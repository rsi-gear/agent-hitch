import type { HarborPreparedArtifactUse } from "../backends/index.js";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalRequest, RemoteWorkOfferV1, ResolvedRevision } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { parseEvalExecutionPlan } from "../evals/index.js";

export interface RemoteHarborWorkSpecV1 {
  schema_version: "1";
  request: EvalRequest;
  plan: EvalExecutionPlanV1;
  work: BackendWorkItemV1;
  resolution: ResolvedRevision;
  harness_artifact: HarborPreparedArtifactUse;
  controller_runtime: { runtime_id: string; directory: "controller-runtime" };
  task: { task_id: string; directory: "task-input" };
  credential_names: string[];
}

export function parseRemoteHarborWorkSpec(value: unknown, offer: RemoteWorkOfferV1): RemoteHarborWorkSpecV1 {
  const spec = exact(value, [
    "schema_version", "request", "plan", "work", "resolution", "harness_artifact", "controller_runtime", "task", "credential_names",
  ], "remote Harbor work spec", ["credential_names"]);
  if (spec.schema_version !== "1") throw specError("remote Harbor work spec version is invalid");
  const request = parseRequest(spec.request);
  const plan = parseEvalExecutionPlan(spec.plan);
  const work = plan.work_items.find((entry) => entry.work_id === offer.work.work_id);
  if (!work || JSON.stringify(work) !== JSON.stringify(offer.work) || plan.eval_id !== offer.lease.eval_id
    || plan.provider !== offer.lease.provider || request.backend !== "harbor") throw specError("remote Harbor work graph does not match its offer");
  const resolution = parseResolution(spec.resolution);
  const harnessArtifact = parseArtifact(spec.harness_artifact);
  const runtime = exact(spec.controller_runtime, ["runtime_id", "directory"], "remote controller runtime");
  const task = exact(spec.task, ["task_id", "directory"], "remote task input");
  const credentialNames = spec.credential_names === undefined && offer.credential_names === undefined
    ? []
    : environmentNames(spec.credential_names) ? [...spec.credential_names as string[]].sort() : (() => { throw specError("remote credential names are invalid"); })();
  if (runtime.directory !== "controller-runtime" || typeof runtime.runtime_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(runtime.runtime_id)
    || task.directory !== "task-input" || task.task_id !== work.task_ids[0] || work.task_ids.length !== 1
    || harnessArtifact.directory !== "harness-artifact" || harnessArtifact.harness_id !== resolution.harness_id
    || harnessArtifact.revision_identity !== resolution.identity || request.harness_ref !== resolution.requested_ref
    || request.benchmark_id !== plan.benchmark.id || request.benchmark_revision !== plan.benchmark.revision
    || JSON.stringify(credentialNames) !== JSON.stringify(offer.credential_names ?? [])) {
    throw specError("remote Harbor work inputs do not match their pinned identities");
  }
  return {
    schema_version: "1", request, plan, work, resolution, harness_artifact: harnessArtifact,
    controller_runtime: { runtime_id: runtime.runtime_id, directory: "controller-runtime" },
    task: { task_id: task.task_id as string, directory: "task-input" },
    credential_names: credentialNames,
  };
}

function parseRequest(value: unknown): EvalRequest {
  const request = exact(value, [
    "schema_version", "backend", "dataset", "harness_ref", "model", "attempts", "max_concurrent",
    "infrastructure_retries", "infrastructure_retry_backoff_ms", "timeout_ms", "setup_timeout_ms",
    "agent_args", "pass_env", "benchmark_id", "benchmark_revision",
  ], "remote eval request");
  if (typeof request.schema_version !== "string" || request.backend !== "harbor" || request.dataset !== "task-input"
    || !text(request.harness_ref) || typeof request.model !== "string"
    || !positive(request.attempts) || !positive(request.max_concurrent)
    || !nonnegative(request.infrastructure_retries) || !nonnegative(request.infrastructure_retry_backoff_ms)
    || !nonnegative(request.timeout_ms) || !nonnegative(request.setup_timeout_ms)
    || !stringArray(request.agent_args, 4_096) || !environmentNames(request.pass_env)
    || !text(request.benchmark_id) || !text(request.benchmark_revision)) throw specError("remote eval request is invalid");
  return request as unknown as EvalRequest;
}

function parseResolution(value: unknown): ResolvedRevision {
  const resolution = exact(value, [
    "schema_version", "requested_ref", "canonical_ref", "harness_id", "selector", "source", "revision", "identity", "resolved_at",
  ], "remote resolved revision");
  if (typeof resolution.schema_version !== "string" || !text(resolution.requested_ref) || !text(resolution.canonical_ref)
    || !text(resolution.harness_id) || typeof resolution.identity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(resolution.identity)
    || typeof resolution.resolved_at !== "string" || !Number.isFinite(Date.parse(resolution.resolved_at))
    || !object(resolution.selector) || !object(resolution.source) || !object(resolution.revision)) throw specError("remote resolved revision is invalid");
  return resolution as unknown as ResolvedRevision;
}

function parseArtifact(value: unknown): HarborPreparedArtifactUse {
  const artifact = exact(value, [
    "directory", "artifact_id", "artifact_integrity", "entrypoint_integrity", "harness_id", "revision_identity",
    "adapter_version", "recipe_version", "platform", "node_version", "source_type",
  ], "remote prepared artifact");
  if (artifact.directory !== "harness-artifact"
    || !digest(artifact.artifact_id) || !digest(artifact.artifact_integrity) || !digest(artifact.entrypoint_integrity)
    || !text(artifact.harness_id) || !digest(artifact.revision_identity) || !text(artifact.adapter_version)
    || !text(artifact.recipe_version) || !text(artifact.platform) || !text(artifact.node_version) || !text(artifact.source_type)) {
    throw specError("remote prepared artifact is invalid");
  }
  return artifact as unknown as HarborPreparedArtifactUse;
}

function exact(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!object(value)) throw specError(`${label} must be an object`);
  if (keys.some((key) => !(key in value) && !optional.includes(key)) || Object.keys(value).some((key) => !keys.includes(key))) throw specError(`${label} fields are invalid`);
  return value;
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function digest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 1; }
function nonnegative(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function text(value: unknown): boolean { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/.test(value); }
function stringArray(value: unknown, maximum: number): boolean {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) => typeof entry === "string" && entry.length <= maximum && !/[\0]/.test(entry));
}
function environmentNames(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 256 && value.every((entry) => typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) && new Set(value).size === value.length;
}
function specError(message: string): HitchError { return new HitchError(message, { code: "remote_work_spec_invalid", exitCode: 12 }); }
