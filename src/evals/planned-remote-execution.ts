import type { BackendWorkItemV1, EvalTrialRefV1 } from "../domain/index.js";
import type { ExecutePlannedHarborOptions, PlannedBackendRun } from "./planned-execution.js";
import { loadTrialEnvironmentImages } from "./trial-environment-evidence.js";

export async function executeRemotePlannedWorkItem(input: {
  options: ExecutePlannedHarborOptions;
  item: BackendWorkItemV1;
  publish(ref: EvalTrialRefV1): Promise<void>;
}): Promise<PlannedBackendRun> {
  const { options, item } = input;
  if (!options.remoteWorkExecutor) throw new TypeError("remote work executor is unavailable");
  const taskId = item.task_ids[0] as string;
  const environmentImages = await loadTrialEnvironmentImages({
    taskId, uses: item.image_refs ?? [],
    ...(options.environmentImageManifestLoader ? { loader: options.environmentImageManifestLoader } : {}),
  });
  const completed = await options.remoteWorkExecutor({
    evalId: options.evalId,
    evalDirectory: options.evalDirectory,
    root: options.root,
    request: options.request,
    plan: options.plan,
    workItem: item,
    resolvedRevision: options.resolvedRevision,
    preparedArtifact: options.preparedArtifact,
    runtimeDirectory: options.controllerRuntime.directory,
    runtimeId: options.controllerRuntime.runtime_id,
    ...(environmentImages ? { environmentImages } : {}),
    ...(options.plan.model_capture ? { modelCapturePlan: options.plan.model_capture } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    emit: (event) => options.sink.emit(event),
    publish: input.publish,
    onLeaseState: (leaseId, state) => options.onWorkItemState?.(item.work_id, leaseId, state) ?? Promise.resolve(),
  });
  return {
    attempt: item.logical_attempt as number,
    workId: item.work_id,
    tasks: [taskId],
    refs: completed.refs,
    leaseId: completed.leaseId,
    run: completed.run,
    ...(environmentImages ? { environmentImages } : {}),
  };
}
