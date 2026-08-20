import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedRevision } from "./artifacts.js";
import { HitchError } from "./errors.js";
import { atomicWriteJSON, readJSON } from "./fs.js";
import { terminateProcess } from "./process.js";

export const LOCAL_GIT_TRANSPORT_SCHEMA_VERSION = "1";
export const LOCAL_GIT_TRANSPORT_PAYLOAD = "payload.pack";
export const LOCAL_GIT_TRANSPORT_MANIFEST = "manifest.json";

export interface LocalGitTransportLimits {
  maxPayloadBytes: number;
  maxObjects: number;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS: Readonly<LocalGitTransportLimits> = {
  maxPayloadBytes: 512 * 1024 * 1024,
  maxObjects: 100_000,
  maxFiles: 50_000,
  maxFileBytes: 64 * 1024 * 1024,
};

export interface LocalGitTransportManifest {
  schema_version: "1";
  kind: "local-git-commit";
  harness_id: string;
  resolution_identity: string;
  commit: string;
  tree: string;
  payload_sha256: `sha256:${string}`;
  payload_bytes: number;
  object_count: number;
  file_count: number;
  created_at: string;
}

export interface LocalGitTransportUse {
  directory: string;
  manifestPath: string;
  payloadPath: string;
  resolutionPath: string;
  manifest: LocalGitTransportManifest;
}

export interface VerifiedLocalGitSource {
  directory: string;
  commit: string;
  tree: string;
  resolutionIdentity: string;
  payloadSha256: string;
}

export function localGitTransportLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): LocalGitTransportLimits {
  return {
    maxPayloadBytes: limit(env.HITCH_LOCAL_GIT_MAX_BYTES, DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS.maxPayloadBytes, "HITCH_LOCAL_GIT_MAX_BYTES"),
    maxObjects: limit(env.HITCH_LOCAL_GIT_MAX_OBJECTS, DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS.maxObjects, "HITCH_LOCAL_GIT_MAX_OBJECTS"),
    maxFiles: limit(env.HITCH_LOCAL_GIT_MAX_FILES, DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS.maxFiles, "HITCH_LOCAL_GIT_MAX_FILES"),
    maxFileBytes: limit(env.HITCH_LOCAL_GIT_MAX_FILE_BYTES, DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS.maxFileBytes, "HITCH_LOCAL_GIT_MAX_FILE_BYTES"),
  };
}

export async function buildLocalGitTransport({
  evalDirectory,
  resolvedRevision,
  sourceDirectory,
  env = process.env,
  limits = localGitTransportLimitsFromEnv(env),
  signal,
}: {
  evalDirectory: string;
  resolvedRevision: ResolvedRevision;
  sourceDirectory: string;
  env?: NodeJS.ProcessEnv;
  limits?: LocalGitTransportLimits;
  signal?: AbortSignal;
}): Promise<LocalGitTransportUse> {
  assertEligibleResolution(resolvedRevision);
  throwIfAborted(signal);
  const commit = resolvedRevision.revision.commit as string;
  const git = env.HITCH_GIT_PATH?.trim() || "git";
  const destination = path.join(evalDirectory, "local-source");
  const temporary = path.join(evalDirectory, `.local-source-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(temporary, { recursive: false, mode: 0o700 });
    const observedCommit = (await runGit(git, sourceDirectory, ["rev-parse", `${commit}^{commit}`], env, signal)).trim();
    if (observedCommit !== commit) {
      throw integrityError(`source resolved ${commit} as ${observedCommit || "no commit"}`);
    }
    const tree = (await runGit(git, sourceDirectory, ["rev-parse", `${commit}^{tree}`], env, signal)).trim();
    if (!objectIdPattern(commit).test(tree)) throw integrityError("source returned an invalid root tree OID");

    const listing = await runGit(git, sourceDirectory, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit], env, signal, 64 * 1024 * 1024);
    const objectIds = new Set<string>([commit, tree]);
    let fileCount = 0;
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      const match = entry.match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t/);
      if (!match) throw transportError("Git returned a malformed tree entry");
      const [, mode, type, oid] = match;
      if (type === "blob" || type === "tree") objectIds.add(oid as string);
      if (type === "blob" || mode === "160000") fileCount += 1;
      if (fileCount > limits.maxFiles) throw transportError(`local Git source exceeds the file limit (${limits.maxFiles})`);
    }
    if (objectIds.size > limits.maxObjects) {
      throw transportError(`local Git source exceeds the object limit (${limits.maxObjects})`);
    }

    const sortedObjectIds = [...objectIds].sort();
    const batch = await runGit(
      git,
      sourceDirectory,
      ["cat-file", `--batch-check=%(objectname) %(objecttype) %(objectsize)`],
      env,
      signal,
      32 * 1024 * 1024,
      `${sortedObjectIds.join("\n")}\n`,
    );
    const checked = batch.trim().split("\n").filter(Boolean);
    if (checked.length !== sortedObjectIds.length) throw transportError("Git object inventory was incomplete");
    for (const line of checked) {
      const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit) (\d+)$/);
      if (!match) throw transportError("Git returned malformed object metadata");
      if (match[2] === "blob" && Number(match[3]) > limits.maxFileBytes) {
        throw transportError(`local Git source contains a blob larger than the single-file limit (${limits.maxFileBytes} bytes)`);
      }
    }

    const payloadPath = path.join(temporary, LOCAL_GIT_TRANSPORT_PAYLOAD);
    await writePack(git, sourceDirectory, sortedObjectIds, payloadPath, env, limits.maxPayloadBytes, signal);
    const payloadInfo = await stat(payloadPath);
    const payloadSha256 = await sha256File(payloadPath);
    const manifest: LocalGitTransportManifest = {
      schema_version: "1",
      kind: "local-git-commit",
      harness_id: resolvedRevision.harness_id,
      resolution_identity: resolvedRevision.identity,
      commit,
      tree,
      payload_sha256: payloadSha256,
      payload_bytes: payloadInfo.size,
      object_count: sortedObjectIds.length,
      file_count: fileCount,
      created_at: new Date().toISOString(),
    };
    validateLocalGitTransportManifest(manifest, limits);
    await atomicWriteJSON(path.join(temporary, LOCAL_GIT_TRANSPORT_MANIFEST), manifest, 0o600);
    await atomicWriteJSON(path.join(temporary, "resolution.json"), resolvedRevision, 0o600);
    await verifyPackContents({ git, packPath: payloadPath, manifest, env, temporaryRoot: temporary, ...(signal ? { signal } : {}) });
    await chmod(payloadPath, 0o600);
    await chmod(temporary, 0o700);
    await rename(temporary, destination);
    return {
      directory: destination,
      manifestPath: path.join(destination, LOCAL_GIT_TRANSPORT_MANIFEST),
      payloadPath: path.join(destination, LOCAL_GIT_TRANSPORT_PAYLOAD),
      resolutionPath: path.join(destination, "resolution.json"),
      manifest,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (signal?.aborted) throw new HitchError("local Git transport was cancelled", { code: "cancelled", exitCode: 9 });
    if (error instanceof HitchError) throw error;
    throw transportError((error as Error)?.message || String(error), error);
  }
}

export async function verifyLocalGitTransport(
  use: Pick<LocalGitTransportUse, "manifestPath" | "payloadPath">,
  { expected, limits = DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS, env = process.env, signal }: {
    expected?: { harnessId: string; resolutionIdentity: string; commit: string };
    limits?: LocalGitTransportLimits;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<LocalGitTransportManifest> {
  const manifestInfo = await regularFile(use.manifestPath, "local Git transport manifest");
  if (manifestInfo.size > 64 * 1024) throw integrityError("transport manifest exceeds 64 KiB");
  let manifest: LocalGitTransportManifest;
  try {
    manifest = validateLocalGitTransportManifest(await readJSON(use.manifestPath), limits);
  } catch (error) {
    throw integrityError(`transport manifest is invalid: ${(error as Error)?.message || String(error)}`, error);
  }
  if (expected) {
    if (manifest.harness_id !== expected.harnessId) throw integrityError("transport harness id does not match the locked resolution");
    if (manifest.resolution_identity !== expected.resolutionIdentity) throw integrityError("transport resolution identity does not match the locked resolution");
    if (manifest.commit !== expected.commit) throw integrityError("transport commit does not match the locked resolution");
  }
  const payloadInfo = await regularFile(use.payloadPath, "local Git transport payload");
  if (payloadInfo.size !== manifest.payload_bytes) throw integrityError("transport payload size does not match its manifest");
  if (payloadInfo.size > limits.maxPayloadBytes) throw integrityError("transport payload exceeds the configured size limit");
  const digest = await sha256File(use.payloadPath);
  if (digest !== manifest.payload_sha256) throw integrityError("transport payload digest does not match its manifest");
  const verificationRoot = await mkdtemp(path.join(path.dirname(use.payloadPath), ".verify-"));
  try {
    const git = env.HITCH_GIT_PATH?.trim() || "git";
    try {
      await verifyPackContents({
        git,
        packPath: use.payloadPath,
        manifest,
        env,
        temporaryRoot: verificationRoot,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if ((error as HitchError)?.code === "cancelled") throw error;
      if ((error as HitchError)?.code === "local_source_integrity_mismatch") throw error;
      throw integrityError(`transport pack is invalid: ${(error as Error)?.message || String(error)}`, error);
    }
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
  return manifest;
}

export function validateLocalGitTransportManifest(
  value: unknown,
  limits: LocalGitTransportLimits = DEFAULT_LOCAL_GIT_TRANSPORT_LIMITS,
): LocalGitTransportManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("local Git transport manifest must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_version", "kind", "harness_id", "resolution_identity", "commit", "tree",
    "payload_sha256", "payload_bytes", "object_count", "file_count", "created_at",
  ]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new TypeError(`unknown local Git transport manifest field: ${unexpected}`);
  if (record.schema_version !== LOCAL_GIT_TRANSPORT_SCHEMA_VERSION) throw new TypeError("local Git transport schema_version must be '1'");
  if (record.kind !== "local-git-commit") throw new TypeError("local Git transport kind must be 'local-git-commit'");
  if (typeof record.harness_id !== "string" || !/^[a-z][a-z0-9-]*$/.test(record.harness_id)) throw new TypeError("local Git transport harness_id is invalid");
  if (typeof record.resolution_identity !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.resolution_identity)) throw new TypeError("local Git transport resolution_identity is invalid");
  if (typeof record.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.commit)) throw new TypeError("local Git transport commit must be a full lowercase OID");
  if (typeof record.tree !== "string" || !objectIdPattern(record.commit).test(record.tree)) throw new TypeError("local Git transport tree must use the commit object format");
  if (typeof record.payload_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.payload_sha256)) throw new TypeError("local Git transport payload_sha256 is invalid");
  const payloadBytes = boundedInteger(record.payload_bytes, "payload_bytes", limits.maxPayloadBytes);
  const objectCount = boundedInteger(record.object_count, "object_count", limits.maxObjects);
  const fileCount = boundedInteger(record.file_count, "file_count", limits.maxFiles);
  if (typeof record.created_at !== "string" || !record.created_at || !Number.isFinite(Date.parse(record.created_at))) throw new TypeError("local Git transport created_at must be an ISO date-time");
  return {
    schema_version: "1",
    kind: "local-git-commit",
    harness_id: record.harness_id,
    resolution_identity: record.resolution_identity,
    commit: record.commit,
    tree: record.tree,
    payload_sha256: record.payload_sha256 as `sha256:${string}`,
    payload_bytes: payloadBytes,
    object_count: objectCount,
    file_count: fileCount,
    created_at: record.created_at,
  };
}

export async function verifyMaterializedLocalGitSource({
  directory,
  manifest,
  resolution,
  env = process.env,
  signal,
}: {
  directory: string;
  manifest: LocalGitTransportManifest;
  resolution: ResolvedRevision;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<VerifiedLocalGitSource> {
  assertEligibleResolution(resolution);
  if (resolution.harness_id !== manifest.harness_id || resolution.identity !== manifest.resolution_identity || resolution.revision.commit !== manifest.commit) {
    throw integrityError("materialized source proof does not match the locked resolution");
  }
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw integrityError("materialized local Git source is not a directory");
  const git = env.HITCH_GIT_PATH?.trim() || "git";
  const commit = (await runGit(git, directory, ["rev-parse", `${manifest.commit}^{commit}`], env, signal)).trim();
  const tree = (await runGit(git, directory, ["rev-parse", `${manifest.commit}^{tree}`], env, signal)).trim();
  if (commit !== manifest.commit) throw integrityError("materialized source commit does not match the transport manifest");
  if (tree !== manifest.tree) throw integrityError("materialized source tree does not match the transport manifest");
  return {
    directory,
    commit,
    tree,
    resolutionIdentity: resolution.identity,
    payloadSha256: manifest.payload_sha256,
  };
}

async function verifyPackContents({ git, packPath, manifest, env, signal, temporaryRoot }: {
  git: string;
  packPath: string;
  manifest: LocalGitTransportManifest;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  temporaryRoot: string;
}): Promise<void> {
  const repository = path.join(temporaryRoot, "verify.git");
  await runGit(git, temporaryRoot, ["init", "--bare", repository], env, signal);
  await runGitFromFile(git, repository, ["index-pack", "--stdin"], packPath, env, signal);
  const commit = (await runGit(git, repository, ["rev-parse", `${manifest.commit}^{commit}`], env, signal)).trim();
  const tree = (await runGit(git, repository, ["rev-parse", `${manifest.commit}^{tree}`], env, signal)).trim();
  if (commit !== manifest.commit || tree !== manifest.tree) throw integrityError("created pack does not contain the locked commit and tree");
  await rm(repository, { recursive: true, force: true });
}

async function writePack(
  git: string,
  repository: string,
  objectIds: string[],
  target: string,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(git, ["-c", "pack.threads=1", "-C", repository, "pack-objects", "--stdout"], {
      env: safeGitEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
    let stderr = "";
    let bytes = 0;
    let exceeded = false;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      output.end(() => error ? reject(error) : resolve());
    };
    const abort = () => terminateProcess(child).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        exceeded = true;
        terminateProcess(child).catch(() => {});
        return;
      }
      if (!output.write(chunk)) child.stdout.pause(), output.once("drain", () => child.stdout.resume());
    });
    child.once("error", (error) => finish(transportError(`failed to start Git pack creation: ${error.message}`, error)));
    output.once("error", (error) => {
      terminateProcess(child).catch(() => {});
      finish(transportError(`failed to write Git transport pack: ${error.message}`, error));
    });
    child.once("close", (code) => {
      if (signal?.aborted) return finish(new HitchError("local Git transport was cancelled", { code: "cancelled", exitCode: 9 }));
      if (exceeded) return finish(transportError(`local Git transport exceeds the payload limit (${maxBytes} bytes)`));
      if (code !== 0) return finish(transportError(`Git pack creation failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      finish();
    });
    child.stdin.end(`${objectIds.join("\n")}\n`);
  });
}

async function runGit(
  git: string,
  repository: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  maxOutput = 8 * 1024 * 1024,
  input?: string,
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(git, ["-C", repository, ...args], { env: safeGitEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let exceeded = false;
    const abort = () => terminateProcess(child).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > maxOutput) {
        exceeded = true;
        terminateProcess(child).catch(() => {});
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(transportError(`failed to start Git: ${error.message}`, error));
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new HitchError("local Git transport was cancelled", { code: "cancelled", exitCode: 9 }));
      if (exceeded) return reject(transportError(`Git output exceeded ${maxOutput} bytes`));
      if (code !== 0) return reject(transportError(`Git ${args[0]} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      resolve(stdout.toString("utf8"));
    });
    child.stdin.end(input || "");
  });
}

async function runGitFromFile(git: string, repository: string, args: string[], inputFile: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(git, ["-C", repository, ...args], { env: safeGitEnv(env), stdio: ["pipe", "ignore", "pipe"] });
    const input = createReadStream(inputFile);
    let stderr = "";
    const abort = () => terminateProcess(child).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    input.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new HitchError("local Git transport was cancelled", { code: "cancelled", exitCode: 9 }));
      if (code !== 0) return reject(integrityError(`Git pack verification failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      resolve();
    });
    input.pipe(child.stdin);
  });
}

async function sha256File(file: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

async function regularFile(file: string, label: string) {
  const info = await lstat(file).catch((error) => { throw integrityError(`${label} is missing`, error); });
  if (!info.isFile() || info.isSymbolicLink()) throw integrityError(`${label} must be a regular file`);
  return info;
}

function safeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
}

function assertEligibleResolution(resolution: ResolvedRevision): void {
  if (resolution?.source?.type !== "git" || resolution.source.registered !== false || resolution.revision?.type !== "commit") {
    throw transportError("local Git transport requires an explicit local Git commit resolution");
  }
  const commit = resolution.revision.commit;
  if (typeof commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw transportError("local Git transport requires a full lowercase commit OID");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(resolution.identity || "")) throw transportError("local Git transport resolution identity is invalid");
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`local Git transport ${name} must be a non-negative integer`);
  if ((value as number) > maximum) throw new TypeError(`local Git transport ${name} exceeds the configured limit (${maximum})`);
  return value as number;
}

function objectIdPattern(commit: string): RegExp {
  return commit.length === 64 ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
}

function limit(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw transportError(`${name} must be a positive integer`);
  return parsed;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HitchError("local Git transport was cancelled", { code: "cancelled", exitCode: 9 });
}

function transportError(message: string, cause?: unknown): HitchError {
  return new HitchError(`local Git transport failed: ${message}`, { code: "local_source_transport_failed", exitCode: 12, ...(cause ? { cause } : {}) });
}

function integrityError(message: string, cause?: unknown): HitchError {
  return new HitchError(`local Git transport integrity mismatch: ${message}`, { code: "local_source_integrity_mismatch", exitCode: 12, ...(cause ? { cause } : {}) });
}
