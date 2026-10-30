import path from "node:path";
import type { ExecutionLeaseV1 } from "../domain/index.js";
import { atomicWriteJSON, inspectProcessIdentity, readJSON, withFileLock } from "../foundation/index.js";
import { parseExecutionLease } from "./execution-leases.js";
import { readLocalDockerProcessRecordByLease, releaseLocalDockerProcessRecord } from "./local-docker-provider.js";

/** Older recovery marked failed, already-terminal executions lost. Reconcile
 * only that proven host state; container cleanup must still pass independently. */
export async function reconcileTerminalLocalDockerLease(root: string, lease: ExecutionLeaseV1): Promise<ExecutionLeaseV1> {
  if (lease.provider !== "local-docker" || lease.state !== "lost") return lease;
  const directory = path.join(root, "evals", lease.eval_id, "leases");
  return withFileLock(path.join(directory, ".locks"), lease.lease_id, async () => {
    const file = path.join(directory, `${lease.lease_id}.json`);
    const current = parseExecutionLease(await readJSON<unknown>(file));
    if (current.lease_id !== lease.lease_id || current.eval_id !== lease.eval_id || current.work_id !== lease.work_id
      || current.provider !== "local-docker" || current.epoch !== lease.epoch) throw new TypeError("terminal local lease identity changed");
    if (current.state !== "lost") return current;
    const record = await readLocalDockerProcessRecordByLease({ root, evalId: current.eval_id, leaseId: current.lease_id }).catch(error => {
      if (["provider_lease_not_found", "provider_record_not_found"].includes((error as { code?: string }).code ?? "")) return null;
      throw error;
    });
    if (!record || record.state === "running") return current;
    // markExecutionLeaseLost fences the prior epoch without authorizing a new
    // resource epoch. The provider must still match an authorized execution.
    if (record.eval_id !== current.eval_id || record.work_id !== current.work_id || record.worker_id !== current.worker_id
      || !(current.resource_epochs ?? [current.epoch]).includes(record.lease_epoch)
      || record.lease_epoch !== current.epoch && record.lease_epoch !== current.epoch - 1) {
      throw new TypeError("terminal local provider identity differs from lost lease");
    }
    const status = await inspectProcessIdentity(record.process);
    if (status !== "terminal" && status !== "identity-mismatch") return current;
    await releaseLocalDockerProcessRecord({ root, leaseId: current.lease_id, epoch: record.lease_epoch });
    const released = parseExecutionLease({ ...current, state: "released", terminal_at: current.terminal_at ?? new Date().toISOString() });
    await atomicWriteJSON(file, released);
    return released;
  }, { timeoutCode: "lease_update_locked", timeoutExitCode: 12 });
}
