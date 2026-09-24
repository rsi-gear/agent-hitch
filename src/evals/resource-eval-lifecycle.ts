import path from "node:path";
import type { EvalRequest, ExecutionEvidenceV1 } from "../domain/index.js";
import { invalidInput } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { configuredResourceStore, preflightResourceInput, readResourceInput, sealResourceEvidence, confirmResourceResultSealed } from "../resources/index.js";
import { assertStandardBenchmarkCandidate } from "./benchmark-candidate.js";

export async function admitEvalResources(root: string, request: EvalRequest, evalId: string, buildMode: string, signal?: AbortSignal): Promise<void> {
  const resource = await readResourceInput(request.dataset); if (!resource) return;
  if (buildMode !== "backend") throw invalidInput("resource role contexts require backend builds after materialization");
  const manifest = "schema_version" in resource ? resource : { ...resource.manifest, tasks: resource.tasks, dataset_digest: resource.digest };
  const { store, config } = await configuredResourceStore(root);
  await preflightResourceInput(store, request.dataset, { owner: `eval:${evalId}`, generation: 1, platform: config.platform, ...(signal ? { signal } : {}) });
  await assertStandardBenchmarkCandidate(request.dataset, manifest, parseHarnessReference(request.harness_ref).harness_id, request.agent_args, root);
}
export async function sealTrialResources(input: { root: string; taskId: string; harborJobDirectory?: string; executionEvidence?: ExecutionEvidenceV1 }, directory: string, runId: string, valid: boolean): Promise<void> {
  if (!input.harborJobDirectory) return;
  await sealResourceEvidence({ store: (await configuredResourceStore(input.root)).store, file: path.join(path.dirname(input.harborJobDirectory), "resource-evidence.json"),
    runDirectory: directory, owner: `run:${runId}`, taskId: input.taskId, ...(input.executionEvidence ? { execution: input.executionEvidence } : {}), requireObserved: valid });
}
export async function confirmTrialResources(jobDirectory?: string): Promise<void> {
  if (jobDirectory) await confirmResourceResultSealed(path.join(path.dirname(jobDirectory), "resource-evidence.json"));
}
export function emitWorkLeaseRelease(sink: { emit(event: Record<string, unknown>): void }, workId: string, leaseId: string, epoch: number, workerId: string, state: string): void {
  sink.emit({ type: "lease.released", work_id: workId, lease_id: leaseId, lease_epoch: epoch, worker_id: workerId });
  sink.emit({ type: "eval.work-item.lease-released", work_id: workId, lease_id: leaseId, lease_epoch: epoch, state });
}
