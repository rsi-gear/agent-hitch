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
  const summaries = await bundleSummaries(runDirectory);
  const identity = {
    schema_version: "1" as const,
    run_id: runId,
    sealed: true as const,
    context_identity: contextIdentity,
    files,
    ...summaries,
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
  const summaries = await bundleSummaries(runDirectory);
  if (index.environment !== undefined && JSON.stringify(index.environment) !== JSON.stringify(summaries.environment)
    || index.resources !== undefined && JSON.stringify(index.resources) !== JSON.stringify(summaries.resources)) {
    throw new TypeError("result bundle execution summary does not match");
  }
  const digest = sha256JSON({
    schema_version: index.schema_version,
    run_id: index.run_id,
    sealed: index.sealed,
    context_identity: index.context_identity,
    files: index.files,
    ...(index.environment ? { environment: index.environment } : {}),
    ...(index.resources ? { resources: index.resources } : {}),
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
  const environment = record.environment === undefined ? undefined : parseBundleEnvironment(record.environment);
  const resources = record.resources === undefined ? undefined : parseBundleResources(record.resources);
  return {
    schema_version: "1",
    run_id: runId,
    sealed: true,
    context_identity: record.context_identity as Sha256,
    files,
    ...(environment ? { environment } : {}),
    ...(resources ? { resources } : {}),
    provenance,
    bundle_digest: record.bundle_digest as Sha256,
    created_at: record.created_at,
  };
}

async function bundleSummaries(root: string): Promise<Pick<ResultBundleIndexV1, "environment" | "resources">> {
  const execution = await readJSON<Record<string, unknown> | null>(path.join(root, "execution.json"), null);
  const imageEvidence = await readJSON<Record<string, unknown> | null>(path.join(root, "environment", "image.manifest.json"), null);
  const resources = execution ? resourcesFromExecution(execution) : undefined;
  if (!imageEvidence) return { ...(resources ? { resources } : {}) };
  if (!execution || typeof execution.provider !== "string" || !execution.provider) throw new TypeError("result bundle environment has no provider evidence");
  if (imageEvidence.schema_version !== "1" || !Array.isArray(imageEvidence.manifests)) throw new TypeError("result bundle environment image evidence is invalid");
  const images = imageEvidence.manifests.map((value, index) => {
    const manifest = asRecord(value);
    const output = asRecord(manifest.output);
    if (!isSha256(manifest.image_id) || !isSha256(output.manifest_digest) || typeof output.reference !== "string" || !output.reference) {
      throw new TypeError(`result bundle environment image ${index} is invalid`);
    }
    return { image_id: manifest.image_id as Sha256, image_digest: output.manifest_digest as Sha256, reference: output.reference };
  }).sort((left, right) => Buffer.from(left.image_id).compare(Buffer.from(right.image_id)));
  if (new Set(images.map((image) => image.image_id)).size !== images.length) throw new TypeError("result bundle environment images are duplicated");
  const environment: NonNullable<ResultBundleIndexV1["environment"]> = {
    images,
    provider: execution.provider,
    ...(typeof execution.worker_id === "string" && execution.worker_id ? { worker_id: execution.worker_id } : {}),
    ...(typeof execution.lease_id === "string" && /^lease_[a-f0-9]{32}$/.test(execution.lease_id) ? { lease_id: execution.lease_id } : {}),
  };
  return { environment, ...(resources ? { resources } : {}) };
}

function resourcesFromExecution(execution: Record<string, unknown>): ResultBundleIndexV1["resources"] {
  const requested = resourceVector(execution.reservation);
  const observedValue = asRecord(execution.observed);
  const containers = Array.isArray(observedValue.containers) ? observedValue.containers.map(asRecord) : [];
  const peaks = containers.map((container) => container.peak_memory_bytes).filter((value): value is number => Number.isSafeInteger(value) && (value as number) >= 0);
  const observed = {
    ...(Number.isSafeInteger(observedValue.sample_count) && (observedValue.sample_count as number) >= 0 ? { sample_count: observedValue.sample_count as number } : {}),
    container_count: containers.length,
    ...(peaks.length > 0 ? { peak_memory_bytes: Math.max(...peaks) } : {}),
    oom_killed_containers: containers.filter((container) => container.oom_killed === true).length,
  };
  return { requested, observed };
}

function parseBundleEnvironment(value: unknown): NonNullable<ResultBundleIndexV1["environment"]> {
  const record = asRecord(value);
  if (!Array.isArray(record.images) || typeof record.provider !== "string" || !record.provider
    || record.worker_id !== undefined && (typeof record.worker_id !== "string" || !record.worker_id)
    || record.lease_id !== undefined && (typeof record.lease_id !== "string" || !/^lease_[a-f0-9]{32}$/.test(record.lease_id))) throw new TypeError("result bundle environment summary is invalid");
  const images = record.images.map((value) => {
    const image = asRecord(value);
    if (!isSha256(image.image_id) || !isSha256(image.image_digest) || typeof image.reference !== "string" || !image.reference) throw new TypeError("result bundle environment summary image is invalid");
    return image as { image_id: Sha256; image_digest: Sha256; reference: string };
  });
  return { images, provider: record.provider, ...(record.worker_id ? { worker_id: record.worker_id as string } : {}), ...(record.lease_id ? { lease_id: record.lease_id as string } : {}) };
}

function parseBundleResources(value: unknown): NonNullable<ResultBundleIndexV1["resources"]> {
  const record = asRecord(value);
  const observed = record.observed === undefined ? undefined : asRecord(record.observed);
  if (observed && Object.values(observed).some((entry) => !Number.isSafeInteger(entry) || (entry as number) < 0)) throw new TypeError("result bundle observed resources are invalid");
  return { requested: resourceVector(record.requested), ...(observed ? { observed: observed as Record<string, number> } : {}) };
}

function resourceVector(value: unknown): NonNullable<ResultBundleIndexV1["resources"]>["requested"] {
  const record = asRecord(value);
  const fields = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
  if (Object.keys(record).some((key) => !fields.includes(key as typeof fields[number]))
    || fields.some((key) => !Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) throw new TypeError("result bundle requested resources are invalid");
  return Object.fromEntries(fields.map((key) => [key, record[key]])) as unknown as NonNullable<ResultBundleIndexV1["resources"]>["requested"];
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
