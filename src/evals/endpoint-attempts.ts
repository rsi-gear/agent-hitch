import path from "node:path";
import { readdir } from "node:fs/promises";
import type { EvalRequest, ExternalEndpointBindingV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";
import { loadFrozenEndpoint, parseEndpointBinding, requireEndpointVerification } from "../model-access/index.js";
import { readEvalProgress } from "./progress.js";
import { selectRerunTrialSlots } from "./rerun-slots.js";
import { parseRerunPlan } from "./rerun-inputs.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { assertRerunResourceApproval } from "./resource-profile-rerun.js";

export interface EndpointEvaluationAttemptV1 {
  schema_version: "1";
  id: string;
  parent_id?: string;
  endpoint_binding: ExternalEndpointBindingV1;
}
export interface AdmittedEndpointAttemptV1 extends EndpointEvaluationAttemptV1 {
  rerun_id?: string;
  selected_trials?: Array<{ task_id: string; attempt: number }>;
}
export const endpointEvaluationAttemptId = (binding: ExternalEndpointBindingV1): string => `endpoint_attempt_${sha256JSON(binding).slice(7, 39)}`;
function fail(message: string): never { throw new HitchError(message, { code: "eval_endpoint_attempt_conflict", exitCode: 12 }); }
export function parseEndpointEvaluationAttempt(value: unknown): EndpointEvaluationAttemptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("endpoint attempt must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["schema_version", "id", "parent_id", "endpoint_binding"].includes(key))
    || input.schema_version !== "1" || !/^endpoint_attempt_[a-f0-9]{32}$/.test(String(input.id))
    || !/^endpoint_attempt_[a-f0-9]{32}$/.test(String(input.parent_id))) fail("endpoint attempt requires its identity and parent");
  const binding = parseEndpointBinding(input.endpoint_binding);
  if (endpointEvaluationAttemptId(binding) !== input.id) fail("endpoint attempt identity differs from its frozen binding");
  return { schema_version: "1", id: String(input.id), parent_id: String(input.parent_id), endpoint_binding: binding };
}
export async function readEndpointEvaluationAttempts(directory: string, request: EvalRequest): Promise<AdmittedEndpointAttemptV1[]> {
  if (!request.endpoint_binding) return [];
  const root: AdmittedEndpointAttemptV1 = { schema_version: "1", id: endpointEvaluationAttemptId(request.endpoint_binding), endpoint_binding: request.endpoint_binding };
  const saved = await readJSON<AdmittedEndpointAttemptV1[] | null>(path.join(directory, "endpoint-attempts.json"), null);
  if (!saved) return [root];
  if (!Array.isArray(saved) || sha256JSON(saved[0]) !== sha256JSON(root)) fail("original endpoint attempt changed");
  const ids = new Set([root.id]);
  for (let index = 1; index < saved.length; index += 1) {
    const entry = saved[index]!;
    const { rerun_id, selected_trials, ...input } = entry;
    const parsed = parseEndpointEvaluationAttempt(input);
    assertCompatibleEndpointAttempt(root.endpoint_binding, parsed.endpoint_binding);
    if (ids.has(parsed.id) || parsed.parent_id !== saved[index - 1]!.id || !/^rerun_[a-f0-9]{32}$/.test(String(rerun_id))
      || !Array.isArray(selected_trials) || selected_trials.some(slot => !slot || typeof slot.task_id !== "string" || !Number.isSafeInteger(slot.attempt) || slot.attempt < 1)) fail("endpoint attempt lineage or selection changed");
    ids.add(parsed.id);
  }
  return saved;
}
export function assertCompatibleEndpointAttempt(original: ExternalEndpointBindingV1, next: ExternalEndpointBindingV1): void {
  const common = (binding: ExternalEndpointBindingV1) => ({ api: binding.api, capabilities: binding.capabilities, generation: binding.generation,
    model_digest: binding.deployment_receipt?.model_digest, service_config: binding.deployment_receipt?.service_config, source: binding.deployment_receipt?.source });
  if (!original.deployment_receipt || !next.deployment_receipt || sha256JSON(common(original)) !== sha256JSON(common(next))) fail("endpoint repair may change the deployment incarnation only");
  if (sha256JSON(original) === sha256JSON(next)) fail("endpoint repair requires a new immutable binding");
}
/** Freeze the new binding and selection before task admission; never rewrite request/plan. */
export async function admitEndpointEvaluationAttempt(root: string, directory: string, request: EvalRequest,
  value: EndpointEvaluationAttemptV1, rerunId: string): Promise<AdmittedEndpointAttemptV1> {
  const input = parseEndpointEvaluationAttempt(value);
  if (!request.endpoint_binding || request.training_binding) fail("endpoint repair cannot change a training or non-endpoint evaluation");
  assertCompatibleEndpointAttempt(request.endpoint_binding, input.endpoint_binding);
  await loadFrozenEndpoint(root, input.endpoint_binding);
  await requireEndpointVerification(root, input.endpoint_binding);
  return withFileLock(path.join(directory, "locks"), "endpoint-attempts", async () => {
    const attempts = await readEndpointEvaluationAttempts(directory, request);
    // Every task repair is a physical operation, including later repairs on
    // the same endpoint attempt. Missing state is uncertainty, not termination.
    const operations = await readdir(path.join(directory, "reruns"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const operation of operations) {
      if (!operation.isDirectory() || !/^rerun_[a-f0-9]{32}$/.test(operation.name) || operation.name === rerunId) continue;
      const submission = await readJSON(path.join(directory, "reruns", operation.name, "submission.json"), null);
      const state = await readJSON<{ status?: string; error?: { code?: string } } | null>(path.join(directory, "reruns", operation.name, "state.json"), null);
      if (submission && (!state || !["completed", "failed", "cancelled"].includes(String(state.status)) || state.error?.code === "execution_state_ambiguous")) fail("another task repair has not confirmed termination");
    }
    const existing = attempts.find(entry => entry.id === input.id);
    if (existing) {
      const { rerun_id, selected_trials: _selection, ...frozen } = existing;
      if (attempts.at(-1) !== existing || sha256JSON(frozen) !== sha256JSON(input)) fail("endpoint attempt is already frozen for another request");
      return existing;
    }
    if (attempts.at(-1)!.id !== input.parent_id) fail("endpoint repair must name the latest frozen parent attempt");
    const previous = attempts.at(-1)!;
    if (previous.rerun_id) {
      const state = await readJSON<{ status?: string } | null>(path.join(directory, "reruns", previous.rerun_id, "state.json"), null);
      const neverAdmitted = !state && !await readJSON(path.join(directory, "reruns", previous.rerun_id, "submission.json"), null)
        && !!await readJSON(path.join(directory, "reruns", previous.rerun_id, "cancellation.json"), null);
      if (!neverAdmitted && (!state || !["completed", "failed", "cancelled"].includes(String(state.status)))) fail("parent endpoint attempt has not confirmed task termination");
      if ((state as { error?: { code?: string } } | null)?.error?.code === "execution_state_ambiguous") fail("parent endpoint attempt termination is ambiguous");
    }
    const plan = parseRerunPlan(await readJSON(path.join(directory, "plan.json")), path.basename(directory), request);
    const progress = await readEvalProgress(directory);
    if (!progress) fail("endpoint repair requires durable task-level progress");
    const selected = selectRerunTrialSlots(plan.tasks, plan.attempts, progress, { mode: "invalid" }, { allowVerifierFailures: true });
    if (!selected.length) fail("endpoint repair has no missing or invalid slots");
    const execution = await readJSON<unknown | null>(path.join(directory, "execution-plan.json"), null);
    if (execution) assertRerunResourceApproval({ plan: parseEvalExecutionPlan(execution), request,
      controllerRuntimeId: String(plan.controllerRuntime.runtime_id), trials: selected, endpointBinding: input.endpoint_binding });
    const admitted = { ...input, rerun_id: rerunId, selected_trials: selected };
    await atomicWriteJSON(path.join(directory, "endpoint-attempts.json"), [...attempts, admitted]);
    return admitted;
  });
}
export function endpointAttemptRequest(request: EvalRequest, attempt?: EndpointEvaluationAttemptV1): EvalRequest {
  return attempt ? { ...request, model: attempt.endpoint_binding.endpoint_ref, endpoint_binding: attempt.endpoint_binding } : request;
}
