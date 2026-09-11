import type { HarborPreparedArtifactUse } from "../backends/index.js";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalRequest, RemoteModelBindingV2, RemotePhysicalExecutionV2, RemoteVerifierWorkV2, RemoteWorkOfferV1, ResolvedRevision } from "../domain/index.js";
import { HitchError, sha256JSON } from "../foundation/index.js";
import { assertPhysicalWork, assertRemoteVerifierWork, parseEvalExecutionPlan, parsePhysicalExecution } from "../evals/index.js";
import { parseRemoteModelBinding } from "../control-plane/index.js";

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
export type RemoteHarborWorkSpecV2 = Omit<RemoteHarborWorkSpecV1, "schema_version"> & {
  schema_version: "2";
  model_binding?: RemoteModelBindingV2;
  physical_execution?: RemotePhysicalExecutionV2;
  verifier_source?: "2";
  verifier_only?: RemoteVerifierWorkV2;
};

export function parseRemoteHarborWorkSpec(value: unknown, offer: RemoteWorkOfferV1): RemoteHarborWorkSpecV1 | RemoteHarborWorkSpecV2 {
  const v2 = object(value) && value.schema_version === "2";
  const spec = exact(value, [
    "schema_version", "request", "plan", "work", "resolution", "harness_artifact", "controller_runtime", "task", "credential_names",
    ...(v2 ? ["model_binding", "physical_execution", "verifier_source", "verifier_only"] : []),
  ], "remote Harbor work spec", v2 ? ["model_binding", "physical_execution", "verifier_source", "verifier_only"] : ["credential_names"]);
  if (spec.schema_version !== "1" && !v2) throw specError("remote Harbor work spec version is invalid");
  const binding = v2 && spec.model_binding !== undefined ? parseRemoteModelBinding(spec.model_binding) : undefined;
  const physical = v2 && spec.physical_execution !== undefined ? parsePhysicalExecution(spec.physical_execution) : undefined;
  const capture = v2 && spec.verifier_source === "2";
  if (spec.verifier_source !== undefined && !capture) throw specError("remote verifier source version is invalid");
  if (v2 && !binding && !physical && !capture) throw specError("remote work spec v2 requires a model binding, physical execution or verifier source capture");
  const request = parseRequest(spec.request, v2);
  const plan = parseEvalExecutionPlan(spec.plan);
  const work = offer.work;
  try { assertPhysicalWork(plan, work, physical); }
  catch { throw specError("remote Harbor work graph differs from its frozen plan"); }
  if (sha256JSON(spec.work) !== sha256JSON(work) || plan.eval_id !== offer.lease.eval_id
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
    || work.artifact_id !== undefined && harnessArtifact.artifact_id !== work.artifact_id
    || harnessArtifact.revision_identity !== resolution.identity || request.harness_ref !== resolution.requested_ref
    || request.benchmark_id !== plan.benchmark.id || request.benchmark_revision !== plan.benchmark.revision
    || JSON.stringify(credentialNames) !== JSON.stringify(offer.credential_names ?? [])) {
    throw specError("remote Harbor work inputs do not match their pinned identities");
  }
  const verifier = spec.verifier_only === undefined ? undefined : assertRemoteVerifierWork({ verifier: spec.verifier_only,
    plan, work, physical, runtimeId: runtime.runtime_id as string });
  if ((physical?.kind === "verifier-only") !== !!verifier) throw specError("verifier-only requires both its physical identity and source descriptor");
  if (verifier && (binding || capture || credentialNames.length || request.training_binding || plan.training_binding)) throw specError("verifier-only cannot execute a model or a training slot");
  if (verifier) {
    const kinds = ["work-spec", "harness-artifact", "controller-runtime", "task-input", "verifier-source", "verifier-runtime"];
    if (!offer.inputs || offer.inputs.length !== kinds.length || kinds.some(kind => offer.inputs!.filter(ref => ref.kind === kind).length !== 1)
      || offer.inputs.some(ref => ref.format !== (ref.kind === "work-spec" ? "json" : "hitch-tree-v1"))) throw specError("remote verifier inputs are incomplete or ambiguous");
  } else if (binding) validateModelGraph(binding, request, plan, credentialNames);
  else if (plan.training_binding || request.model.startsWith("local/") || request.model.startsWith("training/")) throw specError("bound models require remote work spec v2");
  return {
    ...(v2 ? { schema_version: "2" as const, ...(binding ? { model_binding: binding } : {}), ...(physical ? { physical_execution: physical } : {}), ...(capture ? { verifier_source: "2" as const } : {}), ...(verifier ? { verifier_only: verifier } : {}) } : { schema_version: "1" as const }),
    request, plan, work, resolution, harness_artifact: harnessArtifact,
    controller_runtime: { runtime_id: runtime.runtime_id, directory: "controller-runtime" },
    task: { task_id: task.task_id as string, directory: "task-input" },
    credential_names: credentialNames,
  };
}

function parseRequest(value: unknown, v2: boolean): EvalRequest {
  const request = exact(value, [
    "schema_version", "backend", "dataset", "harness_ref", "model", "attempts", "max_concurrent",
    "infrastructure_retries", "infrastructure_retry_backoff_ms", "timeout_ms", "setup_timeout_ms",
    "agent_args", "pass_env", "benchmark_id", "benchmark_revision",
    ...(v2 ? ["training_binding", "local_inference"] : []),
  ], "remote eval request", v2 ? ["training_binding", "local_inference"] : []);
  if (typeof request.schema_version !== "string" || request.backend !== "harbor" || request.dataset !== "task-input"
    || !text(request.harness_ref) || typeof request.model !== "string"
    || !positive(request.attempts) || !positive(request.max_concurrent)
    || !nonnegative(request.infrastructure_retries) || !nonnegative(request.infrastructure_retry_backoff_ms)
    || !nonnegative(request.timeout_ms) || !nonnegative(request.setup_timeout_ms)
    || !stringArray(request.agent_args, 4_096) || !environmentNames(request.pass_env)
    || !text(request.benchmark_id) || !text(request.benchmark_revision)) throw specError("remote eval request is invalid");
  return request as unknown as EvalRequest;
}

function validateModelGraph(binding: RemoteModelBindingV2, request: EvalRequest, plan: EvalExecutionPlanV1, credentialNames: string[]): void {
  if (!plan.model_capture?.required || plan.model_capture.effective_mode !== "proxy" || plan.model_capture.topology !== "in-sandbox"
    || credentialNames.length || request.pass_env.length) throw specError("remote model binding requires mandatory lease capture and no credential overrides");
  if (binding.kind === "training-external") {
    if (request.local_inference || !request.training_binding || !plan.training_binding
      || sha256JSON(request.training_binding) !== sha256JSON(binding.training) || sha256JSON(plan.training_binding) !== sha256JSON(binding.training)
      || request.model !== `training/${binding.training.bindingId}` || !request.harness_ref.startsWith("training-tool@")
      || request.attempts !== 1 || request.infrastructure_retries !== 0 || request.agent_args.length
      || plan.slots.length !== 1 || plan.work_items.length !== 1 || plan.retry_policy.infrastructure_retries !== 0) {
      throw specError("remote training binding differs from its single-attempt work graph");
    }
  } else {
    const selection = exact(request.local_inference, ["model", "device", "profile", "offline", "inference_id", "model_node"], "remote managed model selection");
    if (request.training_binding || plan.training_binding || !request.model.startsWith("local/") || selection.model !== request.model
      || selection.device !== "auto" || selection.profile !== "baseline" || typeof selection.offline !== "boolean"
      || selection.inference_id !== binding.inference_id || sha256JSON(selection.model_node) !== sha256JSON(binding.model_node)) {
      throw specError("remote managed model binding differs from its request");
    }
  }
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
