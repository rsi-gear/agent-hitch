import path from "node:path";
import { atomicWriteJSON } from "../../foundation/index.js";
import { configuredResourceStore, materializeResourceTask, readResourceEvidence, preflightResourceInput, readResourceInput } from "../../resources/index.js";
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
  // The small descriptor is fixed in CAS; each physical attempt receives fresh
  // role contexts. Unknown/failed attempts retain their lease for recovery.
  const result = await run({ ...options, request: { ...options.request, dataset: path.dirname(workspace.taskDirectory) } });
  await atomicWriteJSON(evidencePath, { ...await readResourceEvidence(evidencePath), executionEnded: true });
  return result;
}
