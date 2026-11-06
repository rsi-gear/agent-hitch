import path from "node:path";
import type { EvalExecutionPlanV1, ResourceProfileIdentityV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseEndpointEvaluationAttempt } from "./endpoint-attempts.js";
import { candidateRestartWorkItem, verifierOnlyWorkItem } from "./physical-work-plan.js";

/** An absent issue means this physical work retains the original profile identity.
 * Missing or changed rerun provenance never inherits the logical plan's identity. */
export async function resourceProfileExecutionBindings(input: {
  directory: string; plan: EvalExecutionPlanV1; taskId: string; identity: ResourceProfileIdentityV1 | null;
  rerunIds: string[]; assessmentIds: string[]; readJSON: (file: string) => Promise<unknown>;
}): Promise<Map<string, string | undefined>> {
  const sources = input.plan.work_items.filter(work => work.task_ids.includes(input.taskId));
  const bindings = new Map<string, string | undefined>(sources.map(work => [work.work_id, undefined]));
  // Keep absent optional receipts distinct from malformed/unreadable receipts.
  const readObject = async (file: string) => {
    const value = await input.readJSON(file).catch(() => undefined);
    return value === null ? null : object(value);
  };
  const requests = new Map<string, Record<string, unknown> | undefined>();
  for (const rerunId of input.rerunIds) {
    const request = await readObject(path.join(input.directory, "reruns", rerunId, "request.json"));
    const valid = request?.schema_version === "1" && request.eval_id === input.plan.eval_id && request.rerun_id === rerunId
      && Array.isArray(request.trials) && request.trials.some(slot => object(slot)?.task_id === input.taskId);
    requests.set(rerunId, valid ? request : undefined);
    for (const source of sources) bindings.set(candidateRestartWorkItem(source, rerunId).work_id,
      !valid || request?.rerun_type !== "candidate-restart" ? "physical_profile_identity_unavailable"
        : rerunIdentityIssue(request, input.identity));
  }
  for (const assessmentId of input.assessmentIds) {
    const directory = path.join(input.directory, "assessments", assessmentId), evidence = path.join(directory, "evidence");
    const work = await readObject(path.join(evidence, "work.json"));
    if (typeof work?.work_id !== "string" || !Array.isArray(work.task_ids) || !work.task_ids.includes(input.taskId)) continue;
    if (bindings.has(work.work_id)) continue;
    const source = await readObject(path.join(evidence, "source.json"));
    const original = sources.find(item => item.work_id === source?.work_id);
    let issue: string | undefined = "physical_profile_identity_unavailable";
    if (original) for (const [rerunId, request] of requests) {
      if (!request || request.rerun_type !== "verifier-only") continue;
      const expected = verifierOnlyWorkItem(original, rerunId, assessmentId, input.plan);
      if (sha256JSON(work) !== sha256JSON(expected)) continue;
      issue = rerunIdentityIssue(request, input.identity);
      const assessment = await readObject(path.join(directory, "assessment.json"));
      const repair = await readObject(path.join(evidence, "runtime-repair.json"));
      const runtimes = [source?.controller_runtime_id, assessment?.controller_runtime_id, repair?.replacement_runtime_id,
        request.verifier_runtime_id].filter(value => value !== undefined);
      if (assessment === undefined || repair === undefined || assessment && (assessment.eval_id !== input.plan.eval_id || assessment.task_id !== input.taskId || assessment.rerun_id !== rerunId)) {
        issue = "physical_profile_identity_unavailable";
      } else if (!runtimes.length || runtimes.some(runtime => typeof runtime !== "string")) issue = "physical_profile_identity_unavailable";
      else if (runtimes.some(runtime => runtime !== input.identity?.controller_runtime_digest)) issue = "physical_profile_runtime_changed";
      break;
    }
    bindings.set(work.work_id, issue);
  }
  return bindings;
}

function rerunIdentityIssue(request: Record<string, unknown>, identity: ResourceProfileIdentityV1 | null): string | undefined {
  if (!identity) return "physical_profile_identity_unavailable";
  if (request.endpoint_attempt !== undefined) {
    try {
      const attempt = parseEndpointEvaluationAttempt(request.endpoint_attempt);
      if (sha256JSON(attempt.endpoint_binding) !== identity.resource_parameters.endpoint_binding_digest) return "physical_profile_endpoint_changed";
    } catch { return "physical_profile_identity_unavailable"; }
  }
  if (request.verifier_runtime_id !== undefined && request.verifier_runtime_id !== identity.controller_runtime_digest) return "physical_profile_runtime_changed";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
