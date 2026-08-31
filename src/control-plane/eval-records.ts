import path from "node:path";
import type { EvalControlStateV1, EvalControlV1, EvalId, EvalRequest, EvalSubmissionV1 } from "../domain/index.js";
import { HitchError, sha256JSON, statePaths } from "../foundation/index.js";
import { resolveLocalDatasetTaskIds, validateEvalRequest } from "../evals/index.js";
import type { EvalRequestInput } from "../evals/index.js";

export function parseEvalControl(value: unknown): EvalControlV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval control must be an object");
  const control = value as Record<string, unknown>;
  const states = new Set<EvalControlStateV1>(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]);
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
  return {
    schema_version: "1",
    eval_id: control.eval_id,
    generation: control.generation as number,
    state: control.state as EvalControlStateV1,
    requested_parallelism: control.requested_parallelism as number,
    admitted_parallelism: control.admitted_parallelism as number,
    ...(control.allocation_id === undefined ? {} : { allocation_id: control.allocation_id as string }),
    ...(control.cancel_requested_at === undefined ? {} : { cancel_requested_at: control.cancel_requested_at as string }),
    ...(error === undefined ? {} : { error: error as { code: string; message: string } }),
    created_at: control.created_at,
    updated_at: control.updated_at,
  };
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
  if (submission.schema_version !== "1" || submission.eval_id !== expectedEvalId
    || typeof submission.submitted_at !== "string" || !Number.isFinite(Date.parse(submission.submitted_at))
    || !submission.request || typeof submission.request !== "object" || Array.isArray(submission.request)) {
    throw new TypeError("eval submission identity is invalid");
  }
  const persisted = submission.request as EvalRequest;
  const normalized = await validateEvalRequest(persistedRequestInput(persisted));
  if (JSON.stringify(normalized) !== JSON.stringify(persisted)) throw new TypeError("eval submission request is not canonical");
  const digest = sha256JSON(normalized);
  if (submission.submission_digest !== digest) throw new TypeError("eval submission digest does not match");
  if (submission.idempotency_key_hash !== undefined && (typeof submission.idempotency_key_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(submission.idempotency_key_hash))) {
    throw new TypeError("eval submission idempotency key hash is invalid");
  }
  return {
    schema_version: "1",
    eval_id: expectedEvalId,
    request: normalized,
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
