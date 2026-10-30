import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutionLeaseV1 } from "../domain/index.js";
import { confirmPhaseDockerBackend, parseEvalExecutionPlan, phaseCleanupEnvironment, phaseDockerExecutionNeverStarted, phaseReceiptTrialParents, readExecutionLeases, readPhaseDockerBindings, reconcileTerminalLocalDockerLease, recordPhaseDockerCleanup } from "../evals/index.js";
import type { EvalDockerResourceReaper } from "../evals/index.js";
import { HitchError, hitchRootId, readJSON, statePaths } from "../foundation/index.js";

/** In-memory work allocations do not survive daemon restart. A released lease
 * authorizes cleanup; it does not prove that the prior cleanup succeeded. Scan
 * all phase and new profiled task-slot evals, including terminal evals and
 * their verifier/restart leases. Legacy and coarse plans remain unchanged. */
export async function reapStartupDockerResources(input: {
  root: string;
  reaper: EvalDockerResourceReaper;
  env: NodeJS.ProcessEnv;
  emit(event: Record<string, unknown>): void;
}): Promise<void> {
  let phaseLeases = await persistedPhaseLeases(input.root);
  let requiresConfirmation = phaseLeases.length > 0;
  try {
    phaseLeases = await Promise.all(phaseLeases.map(lease => reconcileTerminalLocalDockerLease(input.root, lease)));
    const parents: string[] = [];
    for (const evalId of new Set(phaseLeases.map(lease => lease.eval_id))) {
      parents.push(...await phaseReceiptTrialParents(input.root, evalId, phaseLeases.filter(lease => lease.eval_id === evalId)));
    }
    const bindings = await readPhaseDockerBindings({ root: input.root, leases: phaseLeases, trialParents: parents, useCleanupFences: true });
    if (phaseLeases.length && !bindings.length
      && (await Promise.all(phaseLeases.map(lease => phaseDockerExecutionNeverStarted(input.root, lease)))).every(Boolean)) requiresConfirmation = false;
    const env = await phaseCleanupEnvironment(bindings, input.env);
    await confirmPhaseDockerBackend(bindings, env);
    const report = await input.reaper({ root: input.root, env });
    input.emit({ type: "docker.reaper.completed", root_id: report.root_id, scanned: report.scanned,
      deleted: report.deleted.length, retained: report.retained.length, issues: report.issues.length });
    if (requiresConfirmation && (report.root_id !== hitchRootId(input.root) || report.issues.length || report.retained.length
      // An unconfirmed host process could create containers after an empty
      // Docker listing. Only settled, released executions may reopen capacity.
      || phaseLeases.some(lease => lease.state !== "released"))) {
      throw unconfirmed();
    }
    await confirmPhaseDockerBackend(bindings, env);
    await recordPhaseDockerCleanup(input.root, bindings);
  } catch (error) {
    input.emit({ type: "docker.reaper.failed", code: (error as { code?: string }).code || "docker_reaper_failed" });
    if (requiresConfirmation) throw unconfirmed();
  }
}

async function persistedPhaseLeases(root: string): Promise<ExecutionLeaseV1[]> {
  const directory = statePaths(root).evals;
  const leases: ExecutionLeaseV1[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(entry.name)) continue;
    const evalDirectory = path.join(directory, entry.name);
    const value = await readJSON<Record<string, unknown> | null>(path.join(evalDirectory, "execution-plan.json"), null);
    if (value?.resource_contract_version === undefined && value?.resource_profiling === undefined) continue;
    const plan = parseEvalExecutionPlan(value);
    if (plan.eval_id !== entry.name) throw unconfirmed();
    const confirmedPlan = plan.resource_contract_version === "2" || plan.resource_profiling
      && plan.work_items.every(work => !work.opaque_membership && work.task_ids.length === 1 && work.slots.length === 1);
    if (confirmedPlan && plan.provider === "local-docker") leases.push(...(await readExecutionLeases(evalDirectory))
      .filter(lease => lease.provider === "local-docker"));
  }
  return leases;
}

function unconfirmed(): HitchError {
  return new HitchError("phase execution cleanup is unconfirmed; the daemon cannot reopen local resource capacity", {
    code: "phase_cleanup_unconfirmed", exitCode: 12,
  });
}
