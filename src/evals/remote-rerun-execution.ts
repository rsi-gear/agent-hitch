import path from "node:path";
import type { EvalExecutionPlanV1, EvalId, EvalRequest, EvalTrialRefV1, ManagedInferenceLeaseV1, RemotePhysicalExecutionV2, ResolvedRevision } from "../domain/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse } from "../backends/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { assertPhysicalWork, candidateRestartWorkItem } from "./physical-work-plan.js";
import { loadTrialEnvironmentImages } from "./trial-environment-evidence.js";
import type { EvalRemoteWorkExecutionResult, EvalRemoteWorkExecutor } from "./service-types.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import { EvalEventSink } from "./events.js";
import { readExecutionLeases } from "./execution-leases.js";
import { remoteRerunNeedsExecution } from "./rerun-resume.js";

export async function assertRemoteRerunQuiescent(evalDirectory: string, provider: string): Promise<void> {
  const unresolved = (await readExecutionLeases(evalDirectory)).find(lease => lease.provider === provider && lease.state !== "released");
  if (unresolved) throw new HitchError(`remote rerun requires confirmed release of lease ${unresolved.lease_id}`, { code: "execution_state_ambiguous", exitCode: 12 });
}

export async function executeRemoteRerunGroup(input: {
  root: string; evalId: EvalId; evalDirectory: string; rerunId: string; rerunDirectory: string;
  request: EvalRequest; plan: EvalExecutionPlanV1; slots: readonly EvalTrialSlot[];
  artifact: HarborPreparedArtifactUse; resolvedRevision: ResolvedRevision;
  runtimeDirectory: string; runtimeId: string; executor: EvalRemoteWorkExecutor;
  inferenceLease?: ManagedInferenceLeaseV1; signal?: AbortSignal;
  publish(ref: EvalTrialRefV1): Promise<void>;
}): Promise<Array<{ attempt: number; run: HarborBackendResult }>> {
  const runs: Array<{ attempt: number; run: HarborBackendResult }> = [];
  for (const slot of input.slots) {
    input.signal?.throwIfAborted();
    const plannedSlot = input.plan.slots.find(item => item.task_id === slot.task_id && item.attempt === slot.attempt);
    const source = plannedSlot && input.plan.work_items.find(item => item.slots.includes(plannedSlot.slot_id));
    if (!source || source.task_ids.length !== 1 || source.slots.length !== 1 || source.artifact_id !== input.artifact.artifact_id) {
      throw invalid("remote rerun requires its frozen single-task artifact and logical slot");
    }
    const work = candidateRestartWorkItem(source, input.rerunId);
    const plan = input.plan;
    const physicalExecution: RemotePhysicalExecutionV2 = { schema_version: "2", kind: "candidate-restart", source_work_id: source.work_id, rerun_id: input.rerunId };
    assertPhysicalWork(plan, work, physicalExecution);
    const identity = { schema_version: "1", rerun_id: input.rerunId, source_work_id: source.work_id,
      work_id: work.work_id, plan_digest: sha256JSON(plan), request_digest: sha256JSON(input.request) };
    const file = path.join(input.rerunDirectory, "remote-work", `${work.work_id}.json`);
    const previous = await readJSON<{ identity: unknown; state: string; result?: EvalRemoteWorkExecutionResult } | null>(file, null);
    if (previous) {
      if (sha256JSON(previous.identity) !== sha256JSON(identity)) throw invalid("persisted remote rerun work identity changed");
      if (previous.state !== "not-started") {
        if (previous.state !== "completed" || !previous.result) throw new HitchError("remote rerun work was already dispatched and needs lease reconciliation", { code: "execution_state_ambiguous", exitCode: 12 });
        for (const ref of previous.result.refs) await input.publish(ref);
        if (previous.result.run.backend.process_exit_code !== 0 || previous.result.run.rawResult === null) throw new HitchError("recovered remote Harbor rerun failed before producing a complete result", { code: "eval_rerun_harbor_failed", exitCode: 13 });
        runs.push({ attempt: slot.attempt, run: previous.result.run }); continue;
      }
      await remoteRerunNeedsExecution({ evalDirectory: input.evalDirectory, directory: input.rerunDirectory,
        rerunId: input.rerunId, plan, request: input.request, slots: [slot] });
    }
    await atomicWriteJSON(file, { identity, state: "dispatching" });
    const images = await loadTrialEnvironmentImages({ taskId: slot.task_id, uses: work.image_refs ?? [] });
    const sink = new EvalEventSink(path.join(input.rerunDirectory, "remote-work", work.work_id), input.evalId);
    await sink.open();
    const published: EvalTrialRefV1[] = [];
    const publish = async (ref: EvalTrialRefV1): Promise<void> => {
      if (ref.task_id !== slot.task_id || ref.attempt !== slot.attempt) throw invalid("remote rerun returned an unselected logical slot");
      const existing = published.find(item => item.trial_id === ref.trial_id);
      if (existing && sha256JSON(existing) !== sha256JSON(ref)) throw invalid("remote rerun changed an acknowledged trial");
      if (existing) return;
      await input.publish(ref); published.push(ref);
    };
    const result = await input.executor({
      root: input.root, evalId: input.evalId, evalDirectory: input.evalDirectory, request: input.request,
      plan, workItem: work, physicalExecution, preparedArtifact: input.artifact, resolvedRevision: input.resolvedRevision,
      runtimeDirectory: input.runtimeDirectory, runtimeId: input.runtimeId,
      ...(images ? { environmentImages: images } : {}),
      ...(plan.model_capture ? { modelCapturePlan: plan.model_capture } : {}),
      ...(input.inferenceLease ? { modelTarget: { kind: "managed-inference", binding: input.inferenceLease.binding,
        credential: input.inferenceLease.credential, modelId: input.inferenceLease.lock.model_id,
        maxOutputTokens: input.inferenceLease.lock.generation.max_output_tokens } } : {}),
      ...(input.signal ? { signal: input.signal } : {}), publicationMode: "replace-invalid", publish,
      emit: event => sink.emit({ ...event, rerun_id: input.rerunId, execution_kind: "candidate-restart", source_work_id: source.work_id }),
      onLeaseState: async (leaseId, state) => { await atomicWriteJSON(file, { identity, lease_id: leaseId, state }); },
    }).finally(() => sink.close());
    if (sha256JSON(result.refs) !== sha256JSON(published)) throw invalid("remote rerun result differs from its acknowledged trials");
    await atomicWriteJSON(file, { identity, state: "completed", result });
    runs.push({ attempt: slot.attempt, run: result.run });
    if (result.run.backend.process_exit_code !== 0 || result.run.rawResult === null) throw new HitchError("remote Harbor rerun failed before producing a complete result", { code: "eval_rerun_harbor_failed", exitCode: 13 });
  }
  return runs;
}

function invalid(message: string): HitchError { return new HitchError(message, { code: "eval_rerun_unavailable", exitCode: 12 }); }
