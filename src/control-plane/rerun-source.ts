import path from "node:path";
import type { EvalId, EvalRequest, EvalExecutionPolicyV1, ExecutionProviderStatusV1, ModelCapturePlanV1, ResourceVectorV1 } from "../domain/index.js";
import { assertRemoteRerunQuiescent, parseEvalExecutionPlan, readEndpointEvaluationAttempts, verifierOnlyReservation } from "../evals/index.js";
import type { EvalRerunType } from "../evals/index.js";
import { HitchError, readJSON, statePaths } from "../foundation/index.js";
import { defaultEvalExecutionPolicy, isTerminalControl, parseEvalControl, parseEvalSubmission } from "./eval-records.js";
import { schedulerCapturePlan } from "./scheduler-eval-entry.js";
import type { RemoteWorkCoordinator } from "./remote-work-coordinator.js";

export async function loadRerunSource(input: {
  root: string; evalId: EvalId; rerunType: EvalRerunType; localProvider: string;
  endpointAttempt?: import("../evals/index.js").EndpointEvaluationAttemptV1;
  trialResources: ResourceVectorV1; localStatus: ExecutionProviderStatusV1; remoteWork?: RemoteWorkCoordinator;
}): Promise<{ request: EvalRequest; execution: EvalExecutionPolicyV1; modelCapturePlan?: ModelCapturePlanV1 }> {
  const directory = path.join(statePaths(input.root).evals, input.evalId);
  const [submissionValue, controlValue, result] = await Promise.all([
    readJSON<unknown | null>(path.join(directory, "submission.json"), null),
    readJSON<unknown | null>(path.join(directory, "control.json"), null),
    readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null),
  ]);
  if (!submissionValue || !controlValue) throw new HitchError(`eval not found: ${input.evalId}`, { code: "eval_not_found", exitCode: 3 });
  const submission = await parseEvalSubmission(submissionValue, input.evalId), control = parseEvalControl(controlValue);
  if (control.eval_id !== input.evalId) throw new TypeError("eval control identity does not match its directory");
  if (!isTerminalControl(control.state) || !result) throw new HitchError("eval rerun requires a terminal source eval", { code: "eval_rerun_source_not_terminal", exitCode: 12 });
  if ((control.state === "cancelled" || result.status === "cancelled") && !input.endpointAttempt) throw new HitchError("cancelled eval cannot be rerun", { code: "eval_rerun_cancelled", exitCode: 12 });
  if (input.rerunType === "candidate-restart" && submission.request.endpoint_binding && !input.endpointAttempt
    && (await readEndpointEvaluationAttempts(directory, submission.request)).length > 1) throw new HitchError("candidate restart must name the current immutable endpoint attempt", { code: "eval_endpoint_attempt_required", exitCode: 12 });
  if (submission.request.training_binding) throw new HitchError("training slots are repaired by the frozen Gear batch coordinator", { code: "training_rerun_fenced", exitCode: 12 });
  let execution = submission.execution || defaultEvalExecutionPolicy(submission.request, { provider: input.localProvider, trialResources: input.trialResources, buildMode: "backend" });
  const remote = execution.provider !== input.localProvider;
  if (remote && ["candidate-restart", "verifier-only"].includes(input.rerunType) && input.remoteWork) {
    await input.remoteWork.reconcileReleasedLeases({ evalId: input.evalId, evalDirectory: directory, provider: execution.provider });
  }
  if (remote && input.rerunType !== "collect-only") await assertRemoteRerunQuiescent(directory, execution.provider);
  if (remote && input.rerunType !== "collect-only" && (!["candidate-restart", "verifier-only"].includes(input.rerunType) || !input.remoteWork)) {
    throw new HitchError("this remote rerun mode has no worker executor", { code: "remote_rerun_unavailable", exitCode: 12 });
  }
  if (remote && input.rerunType === "candidate-restart" && !(await input.remoteWork!.providerStatuses(execution.provider)).some(worker => worker.features.physical_work === "2")) {
    throw new HitchError("remote candidate restart requires a physical_work v2 worker", { code: "remote_rerun_unavailable", exitCode: 12 });
  }
  if (remote && input.rerunType === "verifier-only" && !(await input.remoteWork!.providerStatuses(execution.provider)).some(worker => worker.features.verifier_only === "2" && worker.features.physical_work === "2")) {
    throw new HitchError("remote scoring requires a verifier_only v2 worker", { code: "remote_rerun_unavailable", exitCode: 12 });
  }
  if (input.rerunType === "verifier-only" || !remote && input.rerunType === "candidate-restart") {
    const saved = await readJSON(path.join(directory, "execution-plan.json"), null);
    const plan = saved === null && input.rerunType === "candidate-restart" ? undefined : parseEvalExecutionPlan(saved);
    if (plan && (input.rerunType === "verifier-only" || plan.resource_contract_version === "2")) {
      const upper = !remote && plan.resource_contract_version === "2"
        ? { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } as ResourceVectorV1
        : { ...execution.resources.default_trial };
      for (const item of plan.work_items) {
        const reservation = !remote && input.rerunType === "verifier-only" ? verifierOnlyReservation(item, plan) : item.reservation;
        for (const key of Object.keys(reservation) as Array<keyof ResourceVectorV1>) upper[key] = Math.max(upper[key] ?? 0, reservation[key] ?? 0);
      }
      execution = { ...execution, ...(input.rerunType === "verifier-only" ? { max_parallelism: 1 } : {}), resources: { ...execution.resources, default_trial: upper } };
    }
  }
  const modelCapturePlan = input.rerunType === "verifier-only" || remote && input.rerunType === "collect-only" ? undefined : await schedulerCapturePlan({
    request: submission.request, execution, localProvider: input.localProvider, localStatus: input.localStatus,
    ...(input.remoteWork ? { remoteWork: input.remoteWork } : {}),
  });
  if (remote && input.rerunType !== "collect-only" && !await input.remoteWork!.canEverFit(execution.provider, execution.resources.default_trial)) {
    throw new HitchError("one rerun trial exceeds remote worker capacity", { code: "resource_request_unsatisfiable", exitCode: 10 });
  }
  return { request: submission.request, execution, ...(modelCapturePlan ? { modelCapturePlan } : {}) };
}
