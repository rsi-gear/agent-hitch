import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackendWorkItemV1, EvalRequest, EvalTrialRefV1, ExecutionLeaseV1, ResolvedRevision, Sha256 } from "../domain/index.js";
import { HitchError, ensureDir, readJSON } from "../foundation/index.js";
import { importEvalTrialRun, parseExecutionEvidence } from "../evals/index.js";
import type { TrialEnvironmentImagesV1 } from "../evals/index.js";

const MAX_ENVELOPE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 100_000;

interface RemoteResultFileV1 {
  path: string;
  size: number;
  sha256: Sha256;
  content_base64: string;
}

export interface RemoteResultEnvelopeV1 {
  schema_version: "1";
  eval_id: string;
  work_id: string;
  lease_id: string;
  lease_epoch: number;
  trial: Record<string, unknown>;
  files: RemoteResultFileV1[];
}

export async function encodeRemoteResultEnvelope(input: {
  evalId: string;
  workId: string;
  leaseId: string;
  leaseEpoch: number;
  trial: Record<string, unknown>;
  bundleDirectory: string;
}): Promise<Buffer> {
  validateTransportIdentity(input);
  const files = await encodeTree(input.bundleDirectory);
  const envelope: RemoteResultEnvelopeV1 = {
    schema_version: "1", eval_id: input.evalId, work_id: input.workId,
    lease_id: input.leaseId, lease_epoch: input.leaseEpoch, trial: input.trial, files,
  };
  const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (encoded.length > MAX_ENVELOPE_BYTES) throw transportError("remote result envelope exceeds its size limit");
  return encoded;
}

export async function importRemoteResultEnvelope(input: {
  root: string;
  evalDirectory: string;
  request: EvalRequest;
  resolvedRevision: ResolvedRevision;
  work: BackendWorkItemV1;
  lease: ExecutionLeaseV1;
  artifactPath: string;
  runtimeId?: string;
  environmentImages?: TrialEnvironmentImagesV1;
  modelCapturePlan?: import("../domain/index.js").ModelCapturePlanV1;
}): Promise<{ ref: EvalTrialRefV1; trial: Record<string, unknown>; backendDirectory: string }> {
  const info = await lstat(input.artifactPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_ENVELOPE_BYTES) throw transportError("remote result artifact is not a safe bounded file");
  const envelope = parseRemoteResultEnvelope(JSON.parse(await readFile(input.artifactPath, "utf8")) as unknown);
  assertEnvelopeIdentity(envelope, input.work, input.lease);
  const trialId = safeTrialId(envelope.trial.trial_name);
  if (envelope.trial.task_name !== input.work.task_ids[0]) throw transportError("remote result task identity does not match its work item");
  const backendDirectory = path.join(input.evalDirectory, "harbor", "work-items", input.work.work_id, `epoch-${String(input.lease.epoch).padStart(6, "0")}`);
  const trialDirectory = path.join(backendDirectory, "job", trialId);
  const bundleDirectory = path.join(trialDirectory, "hitch-run-bundle");
  await rm(backendDirectory, { recursive: true, force: true });
  try {
    await materializeEnvelope(envelope, bundleDirectory);
    const execution = parseExecutionEvidence(await readJSON(path.join(bundleDirectory, "execution.json")));
    if (execution.provider !== input.lease.provider || execution.worker_id !== input.lease.worker_id
      || execution.collision_domain_id !== input.lease.collision_domain_id || execution.eval_id !== input.lease.eval_id
      || execution.work_id !== input.lease.work_id || execution.lease_id !== input.lease.lease_id
      || execution.lease_epoch !== input.lease.epoch || execution.task_id !== input.work.task_ids[0]
      || JSON.stringify(execution.reservation) !== JSON.stringify(input.work.reservation)) {
      throw transportError("remote result execution evidence does not match its lease");
    }
    const ref = await importEvalTrialRun({
      root: input.root,
      evalId: input.lease.eval_id,
      evalDirectory: input.evalDirectory,
      harborJobDirectory: path.join(backendDirectory, "job"),
      expectedAttempt: input.work.logical_attempt as number,
      request: input.request,
      resolvedRevision: input.resolvedRevision,
      benchmarkId: input.request.benchmark_id,
      benchmarkRevision: input.request.benchmark_revision,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      executionEvidence: execution,
      ...(input.environmentImages ? { environmentImages: input.environmentImages } : {}),
      ...(input.modelCapturePlan ? { modelCapturePlan: input.modelCapturePlan } : {}),
      requireCompleteMarker: true,
    }, envelope.trial);
    return { ref, trial: envelope.trial, backendDirectory };
  } catch (error) {
    await rm(backendDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function parseRemoteResultEnvelope(value: unknown): RemoteResultEnvelopeV1 {
  const record = exact(value, ["schema_version", "eval_id", "work_id", "lease_id", "lease_epoch", "trial", "files"], "remote result envelope");
  validateTransportIdentity({ evalId: record.eval_id, workId: record.work_id, leaseId: record.lease_id, leaseEpoch: record.lease_epoch });
  if (record.schema_version !== "1" || !record.trial || typeof record.trial !== "object" || Array.isArray(record.trial)
    || !Array.isArray(record.files) || record.files.length < 1 || record.files.length > MAX_FILES) throw transportError("remote result envelope is invalid");
  const files = record.files.map(parseFile);
  const sorted = [...files].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  if (JSON.stringify(sorted) !== JSON.stringify(files) || new Set(files.map((file) => file.path)).size !== files.length) throw transportError("remote result files are not canonical and unique");
  return {
    schema_version: "1", eval_id: record.eval_id as string, work_id: record.work_id as string,
    lease_id: record.lease_id as string, lease_epoch: record.lease_epoch as number,
    trial: record.trial as Record<string, unknown>, files,
  };
}

async function encodeTree(root: string, relative = ""): Promise<RemoteResultFileV1[]> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: RemoteResultFileV1[] = [];
  for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelativePath(child);
    const target = path.join(root, ...child.split("/"));
    const info = await lstat(target);
    if (info.isDirectory()) files.push(...await encodeTree(root, child));
    else if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) {
      const content = await readFile(target);
      files.push({ path: child, size: content.length, sha256: digest(content), content_base64: content.toString("base64") });
    } else throw transportError(`remote result bundle contains an unsafe entry: ${child}`);
    if (files.length > MAX_FILES) throw transportError("remote result bundle has too many files");
  }
  return files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

async function materializeEnvelope(envelope: RemoteResultEnvelopeV1, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let total = 0;
  for (const file of envelope.files) {
    const content = Buffer.from(file.content_base64, "base64");
    total += content.length;
    if (content.length !== file.size || digest(content) !== file.sha256 || total > MAX_ENVELOPE_BYTES) throw transportError(`remote result file integrity failed: ${file.path}`);
    const target = path.join(destination, ...file.path.split("/"));
    await ensureDir(path.dirname(target));
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
  }
}

function parseFile(value: unknown): RemoteResultFileV1 {
  const record = exact(value, ["path", "size", "sha256", "content_base64"], "remote result file");
  const relative = safeRelativePath(record.path);
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0 || (record.size as number) > MAX_ENVELOPE_BYTES
    || typeof record.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.sha256)
    || typeof record.content_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.content_base64)) {
    throw transportError("remote result file is invalid");
  }
  return { path: relative, size: record.size as number, sha256: record.sha256 as Sha256, content_base64: record.content_base64 };
}

function assertEnvelopeIdentity(envelope: RemoteResultEnvelopeV1, work: BackendWorkItemV1, lease: ExecutionLeaseV1): void {
  if (envelope.eval_id !== work.eval_id || envelope.eval_id !== lease.eval_id || envelope.work_id !== work.work_id
    || envelope.work_id !== lease.work_id || envelope.lease_id !== lease.lease_id || envelope.lease_epoch !== lease.epoch
    || work.logical_attempt === null || work.task_ids.length !== 1) throw transportError("remote result envelope identity does not match its lease");
}

function validateTransportIdentity(value: { evalId: unknown; workId: unknown; leaseId: unknown; leaseEpoch: unknown }): void {
  if (typeof value.evalId !== "string" || !/^eval_[a-f0-9]{32}$/.test(value.evalId)
    || typeof value.workId !== "string" || !/^work_[a-f0-9]{32}$/.test(value.workId)
    || typeof value.leaseId !== "string" || !/^lease_[a-f0-9]{32}$/.test(value.leaseId)
    || !Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) < 1) throw transportError("remote result transport identity is invalid");
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw transportError("remote result path is unsafe");
  return value;
}

function safeTrialId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) throw transportError("remote result trial id is unsafe");
  return value;
}

function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw transportError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw transportError(`${label} has unknown fields`);
  return record;
}

function digest(value: Buffer): Sha256 { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function transportError(message: string): HitchError { return new HitchError(message, { code: "remote_result_invalid", exitCode: 12 }); }
