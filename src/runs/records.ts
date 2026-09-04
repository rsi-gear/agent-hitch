import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJSON, readJSON, sha256Bytes, sha256JSON } from "../foundation/index.js";
export { canonicalJSON, sha256Bytes, sha256JSON } from "../foundation/index.js";
import type {
  HarnessIdentityV1,
  ModelIdentityV1,
  ProtocolIdentityV1,
  RunContextV1,
  RunRecordV1,
  RunStatus,
  Sha256,
  TrajectoryRefV2,
} from "../domain/index.js";
import {
  asRecord,
  asSha256,
  asString,
  validateEvalRunParent,
  validateRelativePath,
  validateRunContext,
  validateRunObservation,
  validateTrajectoryRef,
} from "../domain/index.js";
import { readTrajectory, trajectoryRefPath } from "../trajectories/index.js";
import { inferModelProvider } from "./identity.js";

const RUN_STATUSES = new Set<RunStatus>([
  "queued", "preparing", "running", "succeeded", "failed", "timed_out", "cancelled",
]);

export interface RunRecordLoadResult {
  record: RunRecordV1;
  directory: string;
  trajectory_status: "valid" | "missing" | "corrupt";
  verifier_status: "valid" | "missing";
  record_status: "valid" | "corrupt";
  issues: string[];
}

/** Project the persisted manifest into the logical RunRecord V1 schema. */
export function projectRunRecord(manifestValue: unknown): RunRecordV1 {
  const manifest = asRecord(manifestValue, "run manifest");
  const runId = asString(manifest.run_id, "run_id");
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid run_id: ${runId}`);
  const status = asString(manifest.status, "run status") as RunStatus;
  if (!RUN_STATUSES.has(status)) throw new TypeError(`invalid run status: ${status}`);
  const context = validateRunContext(manifest.context ?? { kind: "ad_hoc" });
  const harness = projectHarnessIdentity(manifest);
  const model = projectModelIdentity(manifest, harness.harness_id);
  const protocol = projectProtocolIdentity(manifest);
  const record: RunRecordV1 = {
    run_id: runId,
    context,
    status,
    harness,
    model,
    protocol,
    request_ref: validateRelativePath(manifest.request_ref ?? "request.json", "request_ref"),
    resolution_ref: validateRelativePath(manifest.resolution_ref ?? "resolution.json", "resolution_ref"),
    created_at: isoTimestamp(manifest.created_at, "created_at"),
  };
  if (manifest.parent !== undefined) record.parent = validateEvalRunParent(manifest.parent);
  if (context.kind === "benchmark_phase" && (!record.parent || manifest.observation !== undefined)) {
    throw new TypeError("benchmark phase requires an eval parent and cannot carry a standalone observation");
  }
  if (manifest.observation !== undefined) record.observation = validateRunObservation(manifest.observation);
  if (manifest.result_ref !== undefined) record.result_ref = validateRelativePath(manifest.result_ref, "result_ref");
  else if (isTerminal(status)) record.result_ref = "result.json";
  if (manifest.trajectory_ref !== undefined) record.trajectory_ref = validateRelativePath(manifest.trajectory_ref, "trajectory_ref");
  if (manifest.completed_at !== undefined) record.completed_at = isoTimestamp(manifest.completed_at, "completed_at");
  return record;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = asString(value, label);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${label} must be an ISO date-time string`);
  return timestamp;
}

function projectHarnessIdentity(manifest: Record<string, unknown>): HarnessIdentityV1 {
  const nested = manifest.harness === undefined ? null : asRecord(manifest.harness, "manifest harness");
  const revisionValue = nested?.revision_identity ?? manifest.revision_identity;
  let revisionIdentity: Sha256 | null = null;
  if (revisionValue !== undefined && revisionValue !== null) revisionIdentity = asSha256(revisionValue, "harness revision_identity");
  const harness: HarnessIdentityV1 = {
    harness_id: asString(nested?.harness_id ?? manifest.harness_id ?? manifest.agent, "harness_id"),
    requested_ref: asString(nested?.requested_ref ?? manifest.requested_harness_ref ?? manifest.canonical_harness_ref, "requested harness ref"),
    revision_identity: revisionIdentity,
  };
  const artifact = nested?.artifact_id ?? manifest.artifact_id;
  if (artifact !== undefined && artifact !== null) harness.artifact_id = asSha256(artifact, "artifact_id");
  const argsDigest = nested?.agent_args_sha256 ?? manifest.agent_args_sha256;
  if (typeof argsDigest === "string" && /^[0-9a-f]{64}$/.test(argsDigest)) {
    harness.agent_args_sha256 = `sha256:${argsDigest}`;
  } else if (argsDigest !== undefined && argsDigest !== null) {
    harness.agent_args_sha256 = asSha256(argsDigest, "agent_args_sha256");
  }
  return harness;
}

function projectModelIdentity(manifest: Record<string, unknown>, harnessId: string): ModelIdentityV1 {
  const nested = manifest.model === undefined ? null : asRecord(manifest.model, "manifest model");
  const requestedId = asString(nested?.requested_id ?? manifest.requested_model ?? "", "requested model id");
  const effectiveId = asString(nested?.effective_id ?? manifest.effective_model ?? requestedId, "effective model id");
  const model: ModelIdentityV1 = { requested_id: requestedId, effective_id: effectiveId };
  const provider = nested?.provider ?? manifest.model_provider ?? inferModelProvider(requestedId, harnessId);
  if (typeof provider === "string" && provider) model.provider = provider;
  const parameters = nested?.parameters_sha256 ?? manifest.parameters_sha256;
  if (parameters !== undefined && parameters !== null) model.parameters_sha256 = asSha256(parameters, "parameters_sha256");
  const inferenceId = nested?.inference_id ?? manifest.inference_id;
  if (inferenceId !== undefined && inferenceId !== null) model.inference_id = asSha256(inferenceId, "inference_id");
  const resolved = nested?.identity_resolved ?? manifest.model_identity_resolved;
  model.identity_resolved = resolved === true;
  return model;
}

function projectProtocolIdentity(manifest: Record<string, unknown>): ProtocolIdentityV1 {
  const nested = manifest.protocol === undefined ? null : asRecord(manifest.protocol, "manifest protocol");
  const timeout = Number(nested?.timeout_ms ?? manifest.timeout_ms);
  if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError("protocol timeout_ms must be non-negative");
  const protocol: ProtocolIdentityV1 = {
    timeout_ms: timeout,
    workspace_mode: asString(nested?.workspace_mode ?? manifest.workspace_mode, "protocol workspace_mode"),
  };
  for (const [field, label] of [
    ["initial_workspace_digest", "initial_workspace_digest"],
    ["environment_identity", "environment_identity"],
    ["tool_policy_sha256", "tool_policy_sha256"],
  ] as const) {
    const value = nested?.[field] ?? manifest[field];
    if (value !== undefined && value !== null) protocol[field] = asSha256(value, label);
  }
  return protocol;
}

export async function loadRunRecord(
  runDirectory: string,
  { verifyTrajectory = true }: { verifyTrajectory?: boolean } = {},
): Promise<RunRecordLoadResult> {
  const manifestPath = path.join(runDirectory, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new TypeError("run manifest must be a regular file");
  const manifest = await readJSON(manifestPath);
  const record = projectRunRecord(manifest);
  const issues: string[] = [];
  const recordStatus = await verifyCoreRecordFiles(runDirectory, record, issues);
  const trajectoryStatus = verifyTrajectory
    ? await verifyRunTrajectory(runDirectory, record, issues)
    : record.trajectory_ref ? "valid" : "missing";
  const verifierStatus = await verifyVerifierResult(runDirectory, record, issues);
  if (isTerminal(record.status) && record.context.kind === "benchmark_task" && !record.observation) {
    issues.push("terminal benchmark run has no observation");
  }
  return {
    record,
    directory: runDirectory,
    trajectory_status: trajectoryStatus,
    verifier_status: verifierStatus,
    record_status: recordStatus,
    issues,
  };
}

async function verifyCoreRecordFiles(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "corrupt"> {
  const refs = [record.request_ref, record.resolution_ref, ...(isTerminal(record.status) && record.result_ref ? [record.result_ref] : [])];
  if (isTerminal(record.status) && !record.result_ref) {
    issues.push("terminal run has no result_ref");
    return "corrupt";
  }
  let valid = true;
  for (const ref of refs) {
    const target = path.resolve(runDirectory, ...ref.split("/"));
    if (!isWithin(runDirectory, target)) {
      issues.push(`run record ref escapes run directory: ${ref}`);
      valid = false;
      continue;
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
      const value = await readJSON(target);
      if (ref === record.result_ref) {
        const result = asRecord(value, "run result");
        if (result.run_id !== record.run_id || result.status !== record.status) {
          throw new Error("result identity or status does not match manifest");
        }
      }
    } catch (error) {
      issues.push(`run record file is missing or invalid (${ref}): ${(error as Error).message}`);
      valid = false;
    }
  }
  return valid ? "valid" : "corrupt";
}

async function verifyVerifierResult(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "missing"> {
  const ref = record.observation?.verifier_result_ref;
  if (!ref) return "missing";
  const target = path.resolve(runDirectory, ...ref.split("/"));
  if (!isWithin(runDirectory, target)) {
    issues.push(`verifier result escapes run directory: ${ref}`);
    return "missing";
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
    await readJSON(target);
    return "valid";
  } catch (error) {
    issues.push(`verifier result is missing or invalid: ${(error as Error).message}`);
    return "missing";
  }
}

export function isTerminal(status: RunStatus): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled"].includes(status);
}

async function verifyRunTrajectory(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "missing" | "corrupt"> {
  const refFile = record.trajectory_ref
    ? path.join(runDirectory, ...record.trajectory_ref.split("/"))
    : trajectoryRefPath(runDirectory);
  let raw: unknown;
  try {
    if ((await lstat(refFile)).isSymbolicLink()) throw new Error("trajectory ref is a symbolic link");
    raw = await readJSON(refFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    issues.push(`trajectory ref is unreadable: ${(error as Error).message}`);
    return "corrupt";
  }
  let ref;
  try {
    ref = validateTrajectoryRef(raw);
  } catch (error) {
    issues.push(`trajectory ref is invalid: ${(error as Error).message}`);
    return "corrupt";
  }
  if (ref.run_id !== record.run_id) {
    issues.push(`trajectory run_id mismatch: ${ref.run_id}`);
    return "corrupt";
  }
  if (ref.schema_version === "1") {
    try {
      const legacyTarget = path.isAbsolute(ref.path) ? ref.path : path.resolve(runDirectory, ref.path);
      if ((await lstat(legacyTarget)).isSymbolicLink()) throw new Error("legacy trajectory is a symbolic link");
      if (ref.sha256) {
        const digest = sha256Bytes(await readFile(legacyTarget));
        if (digest !== ref.sha256) throw new Error(`expected ${ref.sha256}, got ${digest}`);
      }
      await readTrajectory(legacyTarget);
      return "valid";
    } catch (error) {
      issues.push(`legacy trajectory checksum failed: ${(error as Error).message}`);
      return "corrupt";
    }
  }
  for (const file of ref.files) {
    const target = path.resolve(runDirectory, ...file.path.split("/"));
    if (!isWithin(runDirectory, target)) {
      issues.push(`trajectory file escapes run directory: ${file.path}`);
      return "corrupt";
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${file.path}`);
      if (!info.isFile() || info.size !== file.bytes) throw new Error(`size mismatch for ${file.path}`);
      const digest = sha256Bytes(await readFile(target));
      if (digest !== file.sha256) throw new Error(`checksum mismatch for ${file.path}`);
      if (file.role === "canonical_session") await readTrajectory(target);
      else if (file.media_type === "application/x-ndjson") await validateJSONLines(target);
    } catch (error) {
      issues.push(`trajectory file verification failed: ${(error as Error).message}`);
      return "corrupt";
    }
  }
  return "valid";
}

async function validateJSONLines(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSONL at ${path.basename(file)}:${index + 1}: ${(error as Error).message}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function trajectoryRefV2(value: TrajectoryRefV2): TrajectoryRefV2 {
  return value;
}
