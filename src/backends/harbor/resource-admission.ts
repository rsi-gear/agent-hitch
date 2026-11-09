import path from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWriteJSON } from "../../foundation/index.js";
import { configuredResourceStore, materializeResourceTask, readResourceEvidence, preflightResourceInput, readResourceInput, sealResourceEvidence, confirmResourceResultSealed, reclaimResourceExecution } from "../../resources/index.js";
import type { HarborBackendResult, RunHarborBackendOptions } from "./backend.js";

export async function withResourceAdmission(options: RunHarborBackendOptions, run: (options: RunHarborBackendOptions) => Promise<HarborBackendResult>): Promise<HarborBackendResult> {
  if (!await readResourceInput(options.request.dataset)) return run(options);
  if (options.taskNames?.length !== 1 || options.request.attempts !== 1 || options.request.max_concurrent !== 1) throw new Error("resource-aware tasks require isolated task-slot execution");
  const { store, config } = await configuredResourceStore(options.root);
  const owner = `eval:${options.evalId}`, preflight = await preflightResourceInput(store, options.request.dataset, { owner, generation: 1, platform: config.platform, ...(options.signal ? { signal: options.signal } : {}) });
  const plan = preflight?.plans.find(p => p.task.task_id === options.taskNames![0]); if (!plan) throw new Error("resource task is absent from its frozen input");
  const workspace = await materializeResourceTask(store, plan, { owner: `${owner}:${plan.task.task_id}`, generation: 1, policy: config.workspace, ...(options.signal ? { signal: options.signal } : {}) });
  const evidencePath = path.join(options.backendDirectory ?? options.evalDirectory, "resource-evidence.json");
  await atomicWriteJSON(evidencePath, { ...workspace, preflightPlanDigest: preflight!.planDigest, executionEnded: false });
  // backend.started is emitted before Harbor is invoked. Beyond that boundary,
  // a thrown error may leave a live process, so retain its workspace for recovery.
  let executionRequested = false;
  try {
    const result = await run({ ...options, request: { ...options.request, dataset: path.dirname(workspace.taskDirectory) },
      emit: event => { if (event.type === "eval.backend.started") executionRequested = true; options.emit?.(event); } });
    await atomicWriteJSON(evidencePath, { ...await readResourceEvidence(evidencePath), executionEnded: true });
    return result;
  } catch (error) {
    if (!executionRequested) {
      const directory = path.join(path.dirname(evidencePath), "resource-admission-failure");
      await mkdir(directory, { recursive: true });
      await sealResourceEvidence({ store, file: evidencePath, runDirectory: directory,
        owner: `${owner}:preparation:${workspace.id}`, taskId: plan.task.task_id, requireObserved: false });
      await atomicWriteJSON(path.join(directory, "result.json"), {
        protocol: "hitch-resource-preparation-failure@1", evalId: options.evalId, workspaceId: workspace.id,
        executionStarted: false, code: "backend_preparation_failed",
      });
      await atomicWriteJSON(evidencePath, { ...await readResourceEvidence(evidencePath), executionEnded: true });
      await confirmResourceResultSealed(evidencePath);
      await reclaimResourceExecution(store, evidencePath, true);
    }
    throw error;
  }
}
