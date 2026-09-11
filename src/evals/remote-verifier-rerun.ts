import path from "node:path";
import { useControllerRuntimeById } from "../controller-runtime/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";
import { validateEvalId } from "./request.js";
import { EvalEventSink } from "./events.js";
import { readExecutionLeases } from "./execution-leases.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { readRegradeObservation } from "./regrade-evidence.js";
import { remoteVerifierWorkIdentity } from "./remote-verifier-journal.js";
import { assertRemoteVerifierPublication, freezeRemoteVerifierSelection } from "./remote-verifier-selection.js";
import { loadRerunPreparedArtifacts, loadRerunResolvedRevision, parseRerunPlan } from "./rerun-inputs.js";
import type { EvalTrialSlot } from "./rerun-slots.js";
import type { EvalRerunResult } from "./rerun-types.js";
import type { EvalRemoteWorkExecutionResult } from "./service-types.js";
import { validateEvalTrialReferences } from "./trial-import.js";
import { frozenRerunBenchmark } from "./verifier-only-rerun.js";
import type { verifierOnlyEvalRerun } from "./verifier-only-rerun.js";
import { finishVerifierRerun } from "./verifier-rerun-result.js";
import { verifierRuntimeRepair } from "./verifier-runtime.js";
import { preparedArtifactForWorkItem } from "./work-item-artifacts.js";

type Journal = { identity: unknown; state: string; lease_id?: string; result?: EvalRemoteWorkExecutionResult };

/** Execute only scoring, with a frozen source selection and a durable per-work journal. */
export async function remoteVerifierOnlyEvalRerun(input: Parameters<typeof verifierOnlyEvalRerun>[0]): Promise<EvalRerunResult> {
  const evalId = validateEvalId(input.evalId);
  const execution = parseEvalExecutionPlan(await readJSON(path.join(input.evalDirectory, "execution-plan.json")));
  const benchmark = await frozenRerunBenchmark(input.evalDirectory);
  if (!benchmark || execution.provider === "local-docker" || execution.membership !== "known" || execution.eval_id !== input.evalId
    || benchmark.id !== input.request.benchmark_id || benchmark.revision !== input.request.benchmark_revision || input.request.training_binding
    || !input.remoteWorkExecutor || input.executionWorker?.provider !== execution.provider) throw ambiguous("remote scoring requires the frozen benchmark, provider and executor");
  const plan = parseRerunPlan(await readJSON(path.join(input.evalDirectory, "plan.json")), input.evalId, input.request);
  const resolution = await loadRerunResolvedRevision(input.evalDirectory, plan), artifacts = await loadRerunPreparedArtifacts(input.root, plan);
  const runtimeId = String(plan.controllerRuntime.runtime_id);
  const runtime = await useControllerRuntimeById(statePaths(input.root), runtimeId.replace(/^sha256:/, ""));
  if (runtime.runtime_id !== runtimeId || runtime.manifest_digest !== plan.controllerRuntime.manifest_digest) throw ambiguous("source controller runtime changed");
  const verifierRuntime = input.verifierRuntimeId ? await useControllerRuntimeById(statePaths(input.root), input.verifierRuntimeId.slice(7)) : runtime;
  verifierRuntimeRepair(runtime, verifierRuntime);
  const selection = await freezeRemoteVerifierSelection({ ...input, plan: execution, slots: input.selectedTrials,
    taskRoot: benchmark.tasks, sourceRuntimeId: runtimeId, verifierRuntimeId: verifierRuntime.runtime_id });
  const artifactFor = (work: typeof execution.work_items[number]) => {
    if (!work.artifact_id && artifacts.size !== 1) throw ambiguous("scoring source has no unique frozen artifact");
    return preparedArtifactForWorkItem({ preparedArtifact: artifacts.values().next().value!, preparedArtifacts: artifacts }, work);
  };
  for (const item of selection) artifactFor(item.work);
  let progress = input.progress;
  const repaired: EvalTrialSlot[] = [], sources: NonNullable<EvalRerunResult["sources"]> = [];
  for (const item of selection) {
    input.signal?.throwIfAborted();
    const { work, physical, source, record: { descriptor, slot } } = item;
    const identity = remoteVerifierWorkIdentity({ verifier: descriptor, physical, plan: execution, request: input.request, work });
    const file = path.join(input.rerunDirectory, "remote-work", `${work.work_id}.json`);
    const previous = await readJSON<Journal | null>(file, null);
    const released = async (leaseId: string | undefined): Promise<void> => {
      if (!(await readExecutionLeases(input.evalDirectory)).some(lease => lease.lease_id === leaseId && lease.work_id === work.work_id
        && lease.provider === execution.provider && lease.state === "released")) throw ambiguous("scoring work requires confirmed release of its own lease");
    };
    if (previous && sha256JSON(previous.identity) !== sha256JSON(identity)) throw ambiguous("scoring work journal identity changed");
    if (previous) {
      if (previous.state === "not-started" && !previous.result) await released(previous.lease_id);
      else if (previous.state === "completed" && previous.result) await released(previous.result.leaseId);
      else throw ambiguous("scoring work was dispatched and requires lease reconciliation");
    }
    const published: EvalRemoteWorkExecutionResult["refs"] = [];
    const publish = async (ref: EvalRemoteWorkExecutionResult["refs"][number]): Promise<void> => {
      assertRemoteVerifierPublication(descriptor.source_ref, ref, descriptor.assessment_id);
      if (published.length && sha256JSON(published[0]) !== sha256JSON(ref)) throw ambiguous("scoring work changed its acknowledged result");
      if (published.length) return;
      if (ref.observation_status === "valid") {
        await validateEvalTrialReferences(input.root, input.evalId, [ref], { benchmarkId: benchmark.id, benchmarkRevision: benchmark.revision });
        progress = replaceInvalidEvalProgressTrial(progress, ref);
        await writeEvalProgress(input.evalDirectory, progress);
      }
      published.push(ref);
    };
    let result = previous?.state === "completed" ? previous.result : undefined;
    if (!result) {
      await atomicWriteJSON(file, { identity, state: "dispatching" });
      const sink = new EvalEventSink(path.join(input.rerunDirectory, "remote-work", work.work_id), evalId);
      await sink.open();
      result = await input.remoteWorkExecutor({ root: input.root, evalId, evalDirectory: input.evalDirectory,
        request: input.request, plan: execution, workItem: work, physicalExecution: physical,
        preparedArtifact: artifactFor(work), resolvedRevision: resolution, runtimeDirectory: runtime.directory, runtimeId,
        verifierOnly: { descriptor, sourceSnapshotDirectory: source.sourceSnapshotDirectory, verifierRuntimeDirectory: verifierRuntime.directory },
        publicationMode: "replace-invalid", ...(input.signal ? { signal: input.signal } : {}), publish,
        emit: event => sink.emit({ ...event, rerun_id: input.rerunId, execution_kind: "verifier-only", source_work_id: physical.source_work_id }),
        onLeaseState: async (leaseId, state) => {
          const current = await readJSON<Journal>(file);
          if (sha256JSON(current.identity) !== sha256JSON(identity) || current.lease_id && current.lease_id !== leaseId
            || current.result && current.result.leaseId !== leaseId) throw ambiguous("scoring lease callback changed journal ownership");
          // The coordinator collects before release. Its terminal callback must never erase the result.
          if (state === "terminal" && ["collected", "completed"].includes(current.state) && current.result) return;
          if (state === "running" && current.state !== "dispatching" || state === "terminal" && !["running", "terminal"].includes(current.state)) throw ambiguous("scoring lease callback regressed durable state");
          await atomicWriteJSON(file, { ...current, lease_id: leaseId, state });
        },
      }).finally(() => sink.close());
      await released(result.leaseId);
      if (sha256JSON(result.refs) !== sha256JSON(published)) throw ambiguous("scoring result differs from acknowledged references");
      const current = await readJSON<Journal>(file);
      if (current.result && sha256JSON(current.result) !== sha256JSON(result)) throw ambiguous("scoring executor changed its collected result");
      await atomicWriteJSON(file, { identity, state: "completed", lease_id: result.leaseId, result });
    }
    if (!result.refs.length && result.run.rawResult === null && !result.assessments?.length) {
      throw new HitchError("remote scoring failed before producing an assessment", { code: "eval_rerun_harbor_failed", exitCode: 13 });
    }
    const ref = result.refs[0], assessment = result.assessments?.[0];
    if (result.refs.length !== 1 || result.assessments?.length !== 1 || !ref || assessment?.id !== descriptor.assessment_id) throw ambiguous("scoring result has no unique assessment");
    assertRemoteVerifierPublication(descriptor.source_ref, ref, descriptor.assessment_id);
    await readRegradeObservation(input.root, input.evalId, { ...descriptor.source_ref, assessment });
    const manifest = await readJSON<Record<string, unknown>>(path.join(input.evalDirectory, "assessments", assessment.id, "assessment.json"));
    if (manifest.rerun_id !== input.rerunId || manifest.remote_verifier_work_digest !== sha256JSON(descriptor)
      || ref.observation_status === "valid" && sha256JSON(ref.assessment) !== sha256JSON(assessment)) throw ambiguous("scoring assessment belongs to different work");
    await publish(ref);
    if (ref.observation_status === "valid") repaired.push(slot);
    sources.push({ source_trial_id: descriptor.source_ref.trial_id, source_run_id: descriptor.source_ref.run_id!, source_work_id: source.execution.work_id,
      source_backend_directory: path.relative(input.evalDirectory, path.dirname(path.dirname(source.trialDirectory))).split(path.sep).join("/") });
  }
  return finishVerifierRerun({ ...input, progress, repaired, sources, remote: true });
}
function ambiguous(message: string): HitchError { return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 }); }
