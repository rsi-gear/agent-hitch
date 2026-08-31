import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ResultBundleFileRoleV1, ResultBundleFileV1, ResultBundleIndexV1, Sha256 } from "../domain/index.js";
import { atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";

const BUNDLE_INDEX = "bundle.index.json";

export async function writeResultBundleIndex(runDirectory: string): Promise<ResultBundleIndexV1> {
  const manifest = await readJSON<Record<string, unknown>>(path.join(runDirectory, "manifest.json"));
  if (manifest.sealed !== true) throw new TypeError("result bundle manifest must be sealed");
  const runId = requiredRunId(manifest.run_id);
  const files = await bundleFiles(runDirectory);
  const contextIdentity = sha256JSON({
    context: manifest.context,
    parent: manifest.parent,
    harness: manifest.harness,
    model: manifest.model,
    protocol: manifest.protocol,
    observation: manifest.observation,
  });
  const provenance = bundleProvenance(manifest);
  const identity = {
    schema_version: "1" as const,
    run_id: runId,
    sealed: true as const,
    context_identity: contextIdentity,
    files,
    provenance,
  };
  const index: ResultBundleIndexV1 = {
    ...identity,
    bundle_digest: sha256JSON(identity),
    created_at: new Date().toISOString(),
  };
  await atomicWriteJSON(path.join(runDirectory, BUNDLE_INDEX), index);
  return verifyResultBundleIndex(runDirectory);
}

export async function verifyResultBundleIndex(runDirectory: string): Promise<ResultBundleIndexV1> {
  const value = await readJSON<unknown>(path.join(runDirectory, BUNDLE_INDEX));
  const index = parseResultBundleIndex(value);
  const manifest = await readJSON<Record<string, unknown>>(path.join(runDirectory, "manifest.json"));
  if (manifest.sealed !== true || manifest.run_id !== index.run_id) throw new TypeError("result bundle manifest identity is invalid");
  const actualFiles = await bundleFiles(runDirectory);
  if (JSON.stringify(actualFiles) !== JSON.stringify(index.files)) throw new TypeError("result bundle file set or integrity does not match");
  const contextIdentity = sha256JSON({
    context: manifest.context,
    parent: manifest.parent,
    harness: manifest.harness,
    model: manifest.model,
    protocol: manifest.protocol,
    observation: manifest.observation,
  });
  if (contextIdentity !== index.context_identity) throw new TypeError("result bundle context identity does not match");
  const digest = sha256JSON({
    schema_version: index.schema_version,
    run_id: index.run_id,
    sealed: index.sealed,
    context_identity: index.context_identity,
    files: index.files,
    provenance: index.provenance,
  });
  if (digest !== index.bundle_digest) throw new TypeError("result bundle digest does not match");
  return index;
}

export function parseResultBundleIndex(value: unknown): ResultBundleIndexV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("result bundle index must be an object");
  const record = value as Record<string, unknown>;
  const runId = requiredRunId(record.run_id);
  if (record.schema_version !== "1" || record.sealed !== true || !isSha256(record.context_identity)
    || !isSha256(record.bundle_digest) || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))
    || !Array.isArray(record.files) || !record.provenance || typeof record.provenance !== "object" || Array.isArray(record.provenance)) {
    throw new TypeError("result bundle index is invalid");
  }
  const files = record.files.map((file, index) => parseBundleFile(file, index));
  const sorted = [...files].sort(compareBundleFiles);
  if (JSON.stringify(sorted) !== JSON.stringify(files) || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new TypeError("result bundle files are not uniquely and canonically sorted");
  }
  const provenance = parseProvenance(record.provenance);
  return {
    schema_version: "1",
    run_id: runId,
    sealed: true,
    context_identity: record.context_identity as Sha256,
    files,
    provenance,
    bundle_digest: record.bundle_digest as Sha256,
    created_at: record.created_at,
  };
}

async function bundleFiles(root: string): Promise<ResultBundleFileV1[]> {
  const relativeFiles = await listRegularFiles(root);
  const files = await Promise.all(relativeFiles.filter((file) => file !== BUNDLE_INDEX).map(async (relativePath) => {
    const absolute = path.join(root, ...relativePath.split("/"));
    const info = await lstat(absolute);
    if (!info.isFile() || info.nlink !== 1) throw new TypeError(`result bundle contains an unsafe file: ${relativePath}`);
    return {
      role: roleForPath(relativePath),
      path: relativePath,
      size: info.size,
      sha256: await sha256File(absolute),
    } satisfies ResultBundleFileV1;
  }));
  return files.sort(compareBundleFiles);
}

async function listRegularFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    const normalized = entry.name.normalize("NFC");
    if (normalized !== entry.name || entry.name.includes("\\") || entry.name === "." || entry.name === "..") {
      throw new TypeError("result bundle path is not canonical");
    }
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new TypeError(`result bundle contains a non-regular entry: ${child}`);
  }
  return files;
}

function roleForPath(file: string): ResultBundleFileRoleV1 {
  if (file === "request.json") return "request";
  if (file === "resolution.json") return "resolution";
  if (file === "manifest.json") return "manifest";
  if (file === "result.json") return "result";
  if (file === "runtime.ref.json") return "runtime-ref";
  if (file === "execution.json") return "execution-evidence";
  if (file === "events.jsonl") return "control-events";
  if (file === "workspace.json" || file.startsWith("workspace/")) return "workspace-evidence";
  if (file === "environment/image.manifest.json") return "environment-manifest";
  if (file.startsWith("interactions/")) return "interaction-capture";
  if (file.startsWith("verifier/")) return "verifier-evidence";
  if (file === "trajectory.ref.json" || file.startsWith("trajectory/")) return "trajectory";
  if (file.startsWith("provider/") || file.includes("provider-native")) return "provider-evidence";
  if (/(?:^|\/)(?:stdout|stderr)\.log$/.test(file) || file.endsWith(".stdout.log") || file.endsWith(".stderr.log")) return "process-log";
  return "diagnostic";
}

function parseBundleFile(value: unknown, index: number): ResultBundleFileV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`result bundle file ${index} is invalid`);
  const file = value as Record<string, unknown>;
  const roles = new Set<ResultBundleFileRoleV1>([
    "request", "resolution", "manifest", "result", "runtime-ref", "environment-manifest", "execution-evidence",
    "control-events", "process-log", "workspace-evidence", "trajectory", "provider-evidence", "verifier-evidence",
    "interaction-capture", "diagnostic",
  ]);
  if (!roles.has(file.role as ResultBundleFileRoleV1) || typeof file.path !== "string" || !validRelativePath(file.path)
    || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || !isSha256(file.sha256)) {
    throw new TypeError(`result bundle file ${index} is invalid`);
  }
  return { role: file.role as ResultBundleFileRoleV1, path: file.path, size: file.size as number, sha256: file.sha256 as Sha256 };
}

function bundleProvenance(manifest: Record<string, unknown>): ResultBundleIndexV1["provenance"] {
  const harness = asRecord(manifest.harness);
  const context = asRecord(manifest.context);
  return {
    ...(isSha256(harness.revision_identity) || harness.revision_identity === null ? { harness_revision: harness.revision_identity as Sha256 | null } : {}),
    ...(isSha256(harness.artifact_id) ? { artifact_id: harness.artifact_id as Sha256 } : {}),
    ...(typeof context.benchmark_id === "string" ? { benchmark_id: context.benchmark_id } : {}),
    ...(typeof context.benchmark_revision === "string" ? { benchmark_revision: context.benchmark_revision } : {}),
    ...(isSha256(context.verifier_identity) ? { verifier_identity: context.verifier_identity as Sha256 } : {}),
  };
}

function parseProvenance(value: unknown): ResultBundleIndexV1["provenance"] {
  const record = asRecord(value);
  if (record.harness_revision !== undefined && record.harness_revision !== null && !isSha256(record.harness_revision)) throw new TypeError("result bundle harness revision is invalid");
  if (record.artifact_id !== undefined && !isSha256(record.artifact_id)) throw new TypeError("result bundle artifact id is invalid");
  if (record.verifier_identity !== undefined && !isSha256(record.verifier_identity)) throw new TypeError("result bundle verifier identity is invalid");
  if (record.benchmark_id !== undefined && typeof record.benchmark_id !== "string") throw new TypeError("result bundle benchmark id is invalid");
  if (record.benchmark_revision !== undefined && typeof record.benchmark_revision !== "string") throw new TypeError("result bundle benchmark revision is invalid");
  return record as ResultBundleIndexV1["provenance"];
}

function requiredRunId(value: unknown): string {
  if (typeof value !== "string" || !/^run_[a-f0-9]{32}$/.test(value)) throw new TypeError("result bundle run_id is invalid");
  return value;
}

function validRelativePath(value: string): boolean {
  return value === value.normalize("NFC") && !path.posix.isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compareBundleFiles(left: ResultBundleFileV1, right: ResultBundleFileV1): number {
  return Buffer.from(left.path).compare(Buffer.from(right.path));
}

function sha256File(file: string): Promise<Sha256> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.once("error", reject);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}
