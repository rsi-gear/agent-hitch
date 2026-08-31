import path from "node:path";
import type { EvalControlStateV1, EvalControlV1, EvalExecutionPolicyV1, EvalId, EvalRequest, EvalSubmissionV1, ResourceVectorV1 } from "../domain/index.js";
import { HitchError, sha256JSON, statePaths } from "../foundation/index.js";
import { resolveLocalDatasetTaskIds, validateEvalRequest } from "../evals/index.js";
import type { EvalRequestInput } from "../evals/index.js";
import { validateResourceVector } from "./resources.js";

export interface EvalSubmissionInputV1 {
  schema_version?: unknown;
  request?: unknown;
  execution?: unknown;
  idempotency_key?: unknown;
}

export interface NormalizedEvalSubmissionInput {
  request: EvalRequest;
  execution: EvalExecutionPolicyV1;
  idempotencyKey?: string;
}

export async function normalizeEvalSubmissionInput(
  value: EvalSubmissionInputV1 | EvalRequestInput,
  defaults: { provider: string; trialResources: ResourceVectorV1 },
): Promise<NormalizedEvalSubmissionInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HitchError("eval submission must be a JSON object", { code: "invalid_input", exitCode: 2 });
  const record = value as Record<string, unknown>;
  const envelope = Object.hasOwn(record, "request") || Object.hasOwn(record, "execution") || Object.hasOwn(record, "idempotency_key");
  if (!envelope) {
    const request = await validateEvalRequest(value as EvalRequestInput);
    return { request, execution: defaultEvalExecutionPolicy(request, defaults) };
  }
  assertOnlyKeys(record, ["schema_version", "request", "execution", "idempotency_key"], "eval submission input");
  if (record.schema_version !== undefined && record.schema_version !== "1") throw invalidSubmission("unsupported eval submission schema_version");
  if (!record.request || typeof record.request !== "object" || Array.isArray(record.request)) throw invalidSubmission("eval submission request must be an object");
  const request = await validateEvalRequest(record.request as EvalRequestInput);
  const execution = record.execution === undefined
    ? defaultEvalExecutionPolicy(request, defaults)
    : parseEvalExecutionPolicy(record.execution, request);
  if (record.idempotency_key !== undefined && typeof record.idempotency_key !== "string") throw invalidSubmission("eval submission idempotency_key must be a string");
  return { request, execution, ...(typeof record.idempotency_key === "string" ? { idempotencyKey: record.idempotency_key } : {}) };
}

export function defaultEvalExecutionPolicy(
  request: EvalRequest,
  defaults: { provider: string; trialResources: ResourceVectorV1 },
): EvalExecutionPolicyV1 {
  return parseEvalExecutionPolicy({
    provider: defaults.provider,
    max_parallelism: request.max_concurrent,
    resources: { default_trial: defaults.trialResources },
    build: { mode: "backend" },
    model_capture: { mode: "native", required: false },
  }, request);
}

export function parseEvalExecutionPolicy(value: unknown, request: EvalRequest): EvalExecutionPolicyV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSubmission("eval execution policy must be an object");
  const policy = value as Record<string, unknown>;
  assertOnlyKeys(policy, ["provider", "max_parallelism", "resources", "build", "model_capture"], "eval execution policy");
  if (typeof policy.provider !== "string" || !policy.provider || !Number.isSafeInteger(policy.max_parallelism)
    || (policy.max_parallelism as number) < 1 || (policy.max_parallelism as number) > request.max_concurrent) {
    throw invalidSubmission("eval execution policy identity is invalid");
  }
  const resources = exactRecord(policy.resources, ["default_trial", "setup"], "eval execution resources");
  const defaultTrial = policyResources(resources.default_trial, "eval execution default trial resources");
  if (defaultTrial.cpu_millis < 1 || defaultTrial.memory_bytes < 1 || defaultTrial.container_slots < 1 || defaultTrial.build_slots !== 0) {
    throw invalidSubmission("eval execution default trial resources require positive CPU, memory and container slots with zero build slots");
  }
  const setup = resources.setup === undefined ? undefined : policyResources(resources.setup, "eval execution setup resources");
  const build = exactRecord(policy.build, ["mode", "remote_cache"], "eval execution build policy");
  if (!new Set(["backend", "prebuild-preferred", "prebuild-required"]).has(build.mode as string)
    || (build.remote_cache !== undefined && (typeof build.remote_cache !== "string" || !build.remote_cache))) {
    throw invalidSubmission("eval execution build policy is invalid");
  }
  const capture = exactRecord(policy.model_capture, ["mode", "required"], "eval model capture policy");
  if (!new Set(["off", "native", "proxy", "hybrid"]).has(capture.mode as string) || typeof capture.required !== "boolean") {
    throw invalidSubmission("eval model capture policy is invalid");
  }
  return {
    provider: policy.provider,
    max_parallelism: policy.max_parallelism as number,
    resources: { default_trial: defaultTrial, ...(setup ? { setup } : {}) },
    build: { mode: build.mode as EvalExecutionPolicyV1["build"]["mode"], ...(build.remote_cache ? { remote_cache: build.remote_cache as string } : {}) },
    model_capture: { mode: capture.mode as EvalExecutionPolicyV1["model_capture"]["mode"], required: capture.required as boolean },
  };
}

export function assertExecutionPolicySupported(policy: EvalExecutionPolicyV1, provider: string): void {
  if (policy.provider !== provider) throw new HitchError(`execution provider is unavailable: ${policy.provider}`, { code: "execution_provider_unavailable", exitCode: 10 });
  if (policy.resources.setup) throw new HitchError("setup resource reservations are not supported by the local provider yet", { code: "execution_setup_resources_unsupported", exitCode: 10 });
  if (policy.build.remote_cache) throw new HitchError("remote build cache is not supported by the local image service yet", { code: "build_remote_cache_unsupported", exitCode: 10 });
  if (policy.build.mode === "prebuild-required") throw new HitchError("prebuild-required needs task image planning before admission", { code: "environment_prebuild_unavailable", exitCode: 10 });
  if (policy.model_capture.mode === "proxy" || policy.model_capture.mode === "hybrid") {
    throw new HitchError(`${policy.model_capture.mode} model capture is unavailable`, { code: "model_capture_unsupported", exitCode: 10 });
  }
  if (policy.model_capture.mode === "off" && policy.model_capture.required) throw invalidSubmission("off model capture cannot be required");
}

export function reconcileIdempotencyKeys(body: string | undefined, header: string | undefined): string | undefined {
  if (body !== undefined && header !== undefined && body !== header) throw invalidSubmission("idempotency_key body and header must match");
  return body ?? header;
}

export function parseEvalControl(value: unknown): EvalControlV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval control must be an object");
  const control = value as Record<string, unknown>;
  const states = new Set<EvalControlStateV1>(["queued", "planning", "preparing", "running", "finalizing", "cancelling", "succeeded", "failed", "cancelled"]);
  if (control.schema_version !== "1" || typeof control.eval_id !== "string" || !/^eval_[a-f0-9]{32}$/.test(control.eval_id)
    || !Number.isSafeInteger(control.generation) || (control.generation as number) < 0
    || !states.has(control.state as EvalControlStateV1)
    || !Number.isSafeInteger(control.requested_parallelism) || (control.requested_parallelism as number) < 1
    || !Number.isSafeInteger(control.admitted_parallelism) || (control.admitted_parallelism as number) < 0
    || typeof control.created_at !== "string" || !Number.isFinite(Date.parse(control.created_at))
    || typeof control.updated_at !== "string" || !Number.isFinite(Date.parse(control.updated_at))) {
    throw new TypeError("eval control is invalid");
  }
  if (control.allocation_id !== undefined && (typeof control.allocation_id !== "string" || !/^allocation_[a-f0-9]{32}$/.test(control.allocation_id))) {
    throw new TypeError("eval control allocation_id is invalid");
  }
  if (control.cancel_requested_at !== undefined && (typeof control.cancel_requested_at !== "string" || !Number.isFinite(Date.parse(control.cancel_requested_at)))) {
    throw new TypeError("eval control cancel_requested_at is invalid");
  }
  const error = control.error;
  if (error !== undefined && (!error || typeof error !== "object" || Array.isArray(error)
    || typeof (error as Record<string, unknown>).code !== "string" || typeof (error as Record<string, unknown>).message !== "string")) {
    throw new TypeError("eval control error is invalid");
  }
  const activeLeases = controlItems(control.active_leases, "active_leases", /^lease_[a-f0-9]{32}$/);
  const queuedWorkItems = controlItems(control.queued_work_items, "queued_work_items", /^work_[a-f0-9]{32}$/);
  const terminalWorkItems = controlItems(control.terminal_work_items, "terminal_work_items", /^work_[a-f0-9]{32}$/);
  if (queuedWorkItems.some((item) => terminalWorkItems.includes(item))) throw new TypeError("eval control work item sets overlap");
  return {
    schema_version: "1",
    eval_id: control.eval_id,
    generation: control.generation as number,
    state: control.state as EvalControlStateV1,
    requested_parallelism: control.requested_parallelism as number,
    admitted_parallelism: control.admitted_parallelism as number,
    active_leases: activeLeases,
    queued_work_items: queuedWorkItems,
    terminal_work_items: terminalWorkItems,
    ...(control.allocation_id === undefined ? {} : { allocation_id: control.allocation_id as string }),
    ...(control.cancel_requested_at === undefined ? {} : { cancel_requested_at: control.cancel_requested_at as string }),
    ...(error === undefined ? {} : { error: error as { code: string; message: string } }),
    created_at: control.created_at,
    updated_at: control.updated_at,
  };
}

function controlItems(value: unknown, label: string, pattern: RegExp): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !pattern.test(item))
    || new Set(value).size !== value.length) throw new TypeError(`eval control ${label} is invalid`);
  const sorted = [...value].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (sorted.some((item, index) => item !== value[index])) throw new TypeError(`eval control ${label} is not canonical`);
  return value;
}

export function terminalControlState(status: unknown): Extract<EvalControlStateV1, "succeeded" | "failed" | "cancelled"> {
  return status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
}

export function isTerminalControl(state: EvalControlStateV1): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function validateIdempotencyKey(value: string): void {
  if (!/^[\x21-\x7e]{1,256}$/.test(value)) throw new HitchError("idempotency key must be 1-256 visible ASCII characters", {
    code: "invalid_input",
    exitCode: 2,
  });
}

export function idempotencyIndexPath(root: string, keyHash: `sha256:${string}`): string {
  return path.join(statePaths(root).indexes, "eval-idempotency", `${keyHash.slice("sha256:".length)}.json`);
}

export async function parseEvalSubmission(value: unknown, expectedEvalId: EvalId): Promise<EvalSubmissionV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval submission must be an object");
  const submission = value as Record<string, unknown>;
  assertOnlyKeys(submission, [
    "schema_version", "eval_id", "request", "execution", "submission_digest", "idempotency_key_hash", "submitted_at",
  ], "eval submission");
  if (submission.schema_version !== "1" || submission.eval_id !== expectedEvalId
    || typeof submission.submitted_at !== "string" || !Number.isFinite(Date.parse(submission.submitted_at))
    || !submission.request || typeof submission.request !== "object" || Array.isArray(submission.request)) {
    throw new TypeError("eval submission identity is invalid");
  }
  const persisted = submission.request as EvalRequest;
  const normalized = await validateEvalRequest(persistedRequestInput(persisted));
  if (JSON.stringify(normalized) !== JSON.stringify(persisted)) throw new TypeError("eval submission request is not canonical");
  const execution = submission.execution === undefined ? undefined : parseEvalExecutionPolicy(submission.execution, normalized);
  if (execution && JSON.stringify(execution) !== JSON.stringify(submission.execution)) throw new TypeError("eval submission execution policy is not canonical");
  const digest = execution ? sha256JSON({ request: normalized, execution }) : sha256JSON(normalized);
  if (submission.submission_digest !== digest) throw new TypeError("eval submission digest does not match");
  if (submission.idempotency_key_hash !== undefined && (typeof submission.idempotency_key_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(submission.idempotency_key_hash))) {
    throw new TypeError("eval submission idempotency key hash is invalid");
  }
  return {
    schema_version: "1",
    eval_id: expectedEvalId,
    request: normalized,
    ...(execution ? { execution } : {}),
    submission_digest: digest,
    ...(submission.idempotency_key_hash === undefined ? {} : { idempotency_key_hash: submission.idempotency_key_hash as `sha256:${string}` }),
    submitted_at: submission.submitted_at,
  };
}

export async function evalCollisionKeys(request: EvalRequest, collisionDomainId = "local-docker"): Promise<string[]> {
  const tasks = await resolveLocalDatasetTaskIds(request.dataset);
  const taskIds = tasks === null ? ["*"] : tasks;
  return taskIds.map((taskId) => evalTaskCollisionKey(request, taskId, collisionDomainId)).sort();
}

export function evalTaskCollisionKey(request: EvalRequest, taskId: string, collisionDomainId = "local-docker"): string {
  if (!taskId || !collisionDomainId) throw new TypeError("eval collision identity must be non-empty");
  return `collision_${sha256JSON({
    domain: collisionDomainId,
    backend: request.backend,
    benchmark_id: request.benchmark_id,
    benchmark_revision: request.benchmark_revision,
    task_id: taskId,
  }).slice("sha256:".length)}`;
}

function persistedRequestInput(request: EvalRequest): EvalRequestInput {
  return {
    schema_version: request.schema_version,
    backend: request.backend,
    dataset: request.dataset,
    harness_ref: request.harness_ref,
    model: request.model,
    attempts: request.attempts,
    max_concurrent: request.max_concurrent,
    infrastructure_retries: request.infrastructure_retries,
    infrastructure_retry_backoff_ms: request.infrastructure_retry_backoff_ms,
    timeout_ms: request.timeout_ms,
    setup_timeout_ms: request.setup_timeout_ms,
    agent_args: request.agent_args,
    pass_env: request.pass_env,
  };
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSubmission(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, keys, label);
  return record;
}

function policyResources(value: unknown, label: string): ResourceVectorV1 {
  try { return validateResourceVector(value as ResourceVectorV1, label); }
  catch (error) { throw invalidSubmission((error as Error).message); }
}

function assertOnlyKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw invalidSubmission(`${label} has unknown field: ${unexpected}`);
}

function invalidSubmission(message: string): HitchError {
  return new HitchError(message, { code: "invalid_input", exitCode: 2 });
}
