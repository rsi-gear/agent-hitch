import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, openContainedRegularFile, sha256Bytes, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { loadRunRecord, isTerminal } from "./records.js";
import { verifyResultBundleIndex } from "./bundle.js";

export const RUN_OUTPUT_ARTIFACT_CAPABILITY = "run-output-artifacts@1";
export const MAX_RUN_OUTPUT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RUN_OUTPUT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const STORAGE = "output-artifacts";
const EXPORT_MANIFEST = "hitch-output-manifest.json";

export interface RunOutputIdentity {
  run_id: string;
  eval_id: string;
  task_id: string;
  attempt: number;
  harness_commit: string;
  task_digest: string;
}
export interface RunOutputEntryV1 {
  name: string;
  path: string;
  media_type: string;
  bytes: number;
  sha256: string;
}
export interface RunOutputManifestV1 extends RunOutputIdentity {
  schema_version: "1";
  kind: "run-output-artifacts";
  entries: RunOutputEntryV1[];
  digest: string;
}
export interface RunOutputExportV1 {
  schema_version: "1";
  kind: "run-output-artifacts-export";
  run_id: string;
  manifest_digest: string;
  destination: string;
}

/** Called only in an unpublished run staging directory with controller-owned declarations. */
export async function sealRunOutputArtifacts(input: {
  runDirectory: string;
  sourceDirectory: string;
  paths: string[];
  identity: RunOutputIdentity;
  signal?: AbortSignal;
}): Promise<RunOutputManifestV1> {
  validateIdentity(input.identity);
  validateSelection(input.paths);
  if ((await lstat(input.runDirectory)).isSymbolicLink()
    || await exists(input.sourceDirectory) && (await lstat(input.sourceDirectory)).isSymbolicLink()) throw corrupt();
  input = { ...input, runDirectory: await realpath(input.runDirectory),
    sourceDirectory: await exists(input.sourceDirectory) ? await realpath(input.sourceDirectory) : input.sourceDirectory };
  const destination = path.join(input.runDirectory, STORAGE);
  // Never accept a similarly named file supplied by the candidate run bundle.
  await rm(destination, { recursive: true, force: true });
  const staging = await mkdtemp(path.join(input.runDirectory, ".output-artifacts-"));
  try {
    const files = await selectedFiles(input.sourceDirectory, input.paths);
    const entries: RunOutputEntryV1[] = [];
    let total = 0;
    for (const relative of files) {
      input.signal?.throwIfAborted();
      const bytes = await readSafe(input.sourceDirectory, relative, MAX_RUN_OUTPUT_FILE_BYTES);
      total += bytes.length;
      if (total > MAX_RUN_OUTPUT_TOTAL_BYTES) throw failure("output_artifacts_too_large", "run outputs exceed the total byte limit");
      const target = path.join(staging, "files", ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      entries.push({ name: relative, path: relative, media_type: mediaType(relative), bytes: bytes.length, sha256: sha256Bytes(bytes) });
    }
    if (JSON.stringify(files) !== JSON.stringify(await selectedFiles(input.sourceDirectory, input.paths))) {
      throw failure("output_artifacts_changed", "output file selection changed during capture");
    }
    const body = { schema_version: "1" as const, kind: "run-output-artifacts" as const, ...input.identity, entries };
    const manifest = parseRunOutputManifest({ ...body, digest: sha256JSON(body) });
    await atomicWriteJSON(path.join(staging, "manifest.json"), manifest);
    input.signal?.throwIfAborted();
    await rename(staging, destination);
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function parseRunOutputManifest(value: unknown): RunOutputManifestV1 {
  const m = object(value);
  exact(m, ["schema_version", "kind", "run_id", "eval_id", "task_id", "attempt", "harness_commit", "task_digest", "entries", "digest"]);
  validateIdentity(m as unknown as RunOutputIdentity);
  if (m.schema_version !== "1" || m.kind !== "run-output-artifacts" || !Array.isArray(m.entries) || m.entries.length > MAX_FILES || !isDigest(m.digest)) throw corrupt();
  let total = 0;
  const entries = m.entries.map(value => {
    const e = object(value); exact(e, ["name", "path", "media_type", "bytes", "sha256"]);
    if (!safePath(e.path) || e.name !== e.path || e.path === EXPORT_MANIFEST || e.path.startsWith(`${EXPORT_MANIFEST}/`)
      || typeof e.media_type !== "string" || e.media_type !== mediaType(e.path)
      || !Number.isSafeInteger(e.bytes) || (e.bytes as number) < 0 || (e.bytes as number) > MAX_RUN_OUTPUT_FILE_BYTES || !isDigest(e.sha256)) throw corrupt();
    total += e.bytes as number;
    return e as unknown as RunOutputEntryV1;
  });
  const paths = entries.map(e => e.path);
  if (total > MAX_RUN_OUTPUT_TOTAL_BYTES || new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) throw corrupt();
  validateSelection(paths);
  const { digest, ...body } = m;
  if (sha256JSON(body) !== digest) throw corrupt();
  return structuredClone(m) as unknown as RunOutputManifestV1;
}

export async function listRunOutputArtifacts(root: string, runId: string): Promise<RunOutputManifestV1> {
  const loaded = await loadOutput(root, runId);
  await verifyFiles(loaded.directory, loaded.manifest);
  return loaded.manifest;
}

export async function exportRunOutputArtifacts(root: string, runId: string, options: {
  manifestDigest: string; out: string; signal?: AbortSignal;
}): Promise<RunOutputExportV1> {
  if (!isDigest(options.manifestDigest) || !path.isAbsolute(options.out)) throw failure("output_artifacts_invalid_request", "export requires a manifest digest and an absolute output directory");
  const requested = path.resolve(options.out);
  const parent = await realpath(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const lock = sha256JSON(destination);
  return withFileLock(path.join(statePaths(root).root, "locks", "output-exports"), lock, async () => {
    const loaded = await loadOutput(root, runId);
    if (loaded.manifest.digest !== options.manifestDigest) throw failure("output_artifacts_version_mismatch", "run output manifest differs from the requested digest");
    const result: RunOutputExportV1 = { schema_version: "1", kind: "run-output-artifacts-export", run_id: runId, manifest_digest: loaded.manifest.digest, destination };
    if (await exists(destination)) {
      await verifyExport(destination, loaded.manifest);
      return result;
    }
    const staging = await mkdtemp(path.join(parent, ".hitch-output-export-"));
    try {
      for (const entry of loaded.manifest.entries) {
        options.signal?.throwIfAborted();
        const bytes = await readSafe(loaded.directory, `files/${entry.path}`, MAX_RUN_OUTPUT_FILE_BYTES);
        assertBytes(entry, bytes);
        const target = path.join(staging, ...entry.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      }
      await atomicWriteJSON(path.join(staging, EXPORT_MANIFEST), loaded.manifest);
      await verifyExport(staging, loaded.manifest);
      options.signal?.throwIfAborted();
      // serialize cooperating exporters; refuse any externally-created destination
      if (await exists(destination)) throw failure("output_artifacts_destination_exists", "export destination appeared during export");
      await rename(staging, destination);
      return result;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }, { ...(options.signal ? { signal: options.signal } : {}), timeoutCode: "output_artifacts_export_locked" });
}

async function loadOutput(root: string, runId: string): Promise<{ directory: string; manifest: RunOutputManifestV1 }> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw failure("output_artifacts_invalid_request", "invalid run ID");
  const canonicalRoot = await realpath(root);
  const runDirectory = path.join(statePaths(canonicalRoot).runs, runId);
  if (!await exists(runDirectory)) throw failure("output_artifacts_run_not_found", "run does not exist");
  await assertDirectory(runDirectory);
  const raw = JSON.parse((await readSafe(runDirectory, "manifest.json", 1024 * 1024)).toString());
  if (raw.sealed !== true || !isTerminal(raw.status)) throw failure("output_artifacts_not_sealed", "run is not sealed");
  const loaded = await loadRunRecord(runDirectory, { verifyTrajectory: false }).catch(error => { throw corrupt(error); });
  if (loaded.record_status !== "valid") throw corrupt();
  await verifyResultBundleIndex(runDirectory).catch(error => { throw corrupt(error); });
  const directory = path.join(runDirectory, STORAGE);
  if (!await exists(path.join(directory, "manifest.json"))) {
    const statusPath = "output-artifacts-status.json";
    if (await exists(path.join(runDirectory, statusPath))) {
      const status = object(JSON.parse((await readSafe(runDirectory, statusPath, 16 * 1024)).toString()));
      if (typeof status.code === "string" && /^output_artifacts_[a-z_]+$/.test(status.code)) throw failure(status.code, "run output artifacts are unavailable");
    }
    throw failure("output_artifacts_unavailable", "run has no sealed output artifacts; legacy, remote, and non-commit runs are not exported");
  }
  await assertDirectory(directory);
  const manifest = parseRunOutputManifest(JSON.parse((await readSafe(directory, "manifest.json", 4 * 1024 * 1024)).toString()));
  const record = loaded.record;
  const resolution = object(JSON.parse((await readSafe(runDirectory, record.resolution_ref, 1024 * 1024)).toString()));
  const revision = object(resolution.revision);
  // The manifest carries the frozen task content digest. RunContextV1 uses a
  // benchmark-scoped task identity, so its task_digest is not comparable here.
  if (manifest.run_id !== runId || record.context.kind !== "benchmark_task" || manifest.task_id !== record.context.task_id
    || manifest.eval_id !== record.parent?.eval_id || manifest.attempt !== record.parent?.attempt
    || revision.type !== "commit" || manifest.harness_commit !== revision.commit) throw corrupt();
  return { directory, manifest };
}

async function verifyExport(directory: string, expected: RunOutputManifestV1): Promise<void> {
  try {
    await assertDirectory(directory);
    const actual = parseRunOutputManifest(JSON.parse((await readSafe(directory, EXPORT_MANIFEST, 4 * 1024 * 1024)).toString()));
    if (actual.digest !== expected.digest) throw corrupt();
    if (JSON.stringify(await walk(directory, "")) !== JSON.stringify([...expected.entries.map(e => e.path), EXPORT_MANIFEST].sort())) throw corrupt();
    for (const entry of expected.entries) assertBytes(entry, await readSafe(directory, entry.path, MAX_RUN_OUTPUT_FILE_BYTES));
  } catch (error) { throw failure("output_artifacts_destination_exists", "existing export is incomplete or differs from the requested manifest", error); }
}
async function verifyFiles(directory: string, manifest: RunOutputManifestV1): Promise<void> {
  const actual = await walk(directory, "");
  if (JSON.stringify(actual) !== JSON.stringify(["manifest.json", ...manifest.entries.map(e => `files/${e.path}`)].sort())) throw corrupt();
  for (const entry of manifest.entries) assertBytes(entry, await readSafe(directory, `files/${entry.path}`, MAX_RUN_OUTPUT_FILE_BYTES));
}
function assertBytes(entry: RunOutputEntryV1, bytes: Buffer): void {
  if (entry.bytes !== bytes.length || entry.sha256 !== sha256Bytes(bytes)) throw corrupt();
}
async function readSafe(root: string, relative: string, max: number): Promise<Buffer> {
  const file = await openContainedRegularFile(root, relative, max).catch(error => {
    if ((error as Error).message.includes("exceeds its limit")) throw failure("output_artifacts_too_large", "run output file exceeds its byte limit", error);
    throw corrupt(error);
  });
  try { const bytes = await file.handle.readFile(); await file.assertUnchanged(); return bytes; }
  finally { await file.handle.close(); }
}
async function selectedFiles(root: string, selection: string[]): Promise<string[]> {
  if (!await exists(root)) return [];
  await assertDirectory(root);
  const found: string[] = [];
  for (const relative of selection) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!await exists(absolute)) continue;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw corrupt();
    if (info.isDirectory()) found.push(...await walk(root, relative));
    else if (info.isFile() && info.nlink === 1) found.push(relative);
    else throw corrupt();
    if (found.length > MAX_FILES) throw failure("output_artifacts_too_large", "too many output files");
  }
  return found.sort();
}
async function walk(root: string, relative: string): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/")); await assertDirectory(directory);
  const found: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${item.name}` : item.name;
    if (!safePath(child)) throw corrupt();
    if (item.isDirectory()) found.push(...await walk(root, child));
    else if (item.isFile()) found.push(child);
    else throw corrupt();
    if (found.length > MAX_FILES) throw failure("output_artifacts_too_large", "too many output files");
  }
  return found.sort();
}
async function assertDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw corrupt();
}
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
function validateSelection(paths: string[]): void {
  if (paths.length > MAX_FILES) throw corrupt();
  const seen = new Set<string>();
  for (const p of [...paths].sort()) {
    if (!safePath(p) || seen.has(p) || p === EXPORT_MANIFEST || p.startsWith(`${EXPORT_MANIFEST}/`)) throw corrupt();
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) if (seen.has(segments.slice(0, i).join("/"))) throw corrupt();
    seen.add(p);
  }
}
function validateIdentity(i: RunOutputIdentity): void {
  if (!/^run_[a-f0-9]{32}$/.test(i.run_id) || !/^eval_[a-f0-9]{32}$/.test(i.eval_id)
    || typeof i.task_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(i.task_id)
    || !Number.isSafeInteger(i.attempt) || i.attempt < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(i.harness_commit)
    || !isDigest(i.task_digest)) throw corrupt();
}
function safePath(p: unknown): p is string { return typeof p === "string" && p.length > 0 && p.length <= 4096 && p === p.normalize("NFC") && !p.includes("\\") && !/[\x00-\x1f\x7f:]/u.test(p) && p.split("/").every(s => s && s !== "." && s !== ".."); }
function mediaType(p: string): string { return ({ ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain", ".py": "text/x-python" } as Record<string, string>)[path.posix.extname(p).toLowerCase()] ?? "application/octet-stream"; }
function isDigest(v: unknown): v is Sha256 { return typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw corrupt(); return v as Record<string, unknown>; }
function exact(o: Record<string, unknown>, names: string[]): void { if (Object.keys(o).sort().join("\0") !== [...names].sort().join("\0")) throw corrupt(); }
function corrupt(cause?: unknown): HitchError { return failure("output_artifacts_corrupt", "output artifact evidence is corrupt or unsafe", cause); }
function failure(code: string, message: string, cause?: unknown): HitchError { return new HitchError(message, { code, exitCode: 3, ...(cause === undefined ? {} : { cause }) }); }
