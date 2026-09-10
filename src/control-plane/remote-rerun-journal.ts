import path from "node:path";
import type { EvalExecutionPlanV1, EvalRequest, RemoteWorkOfferV1 } from "../domain/index.js";
import { assertPhysicalWork, parsePhysicalExecution, parseRemoteVerifierWork, remoteVerifierWorkIdentity } from "../evals/index.js";
import type { EvalRemoteWorkExecutionResult } from "../evals/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON } from "../foundation/index.js";
import { RemoteWorkInputStore } from "./remote-work-inputs.js";

export async function remoteRerunSpec(root: string, offer: RemoteWorkOfferV1): Promise<Record<string, unknown> | null> {
  const ref = offer.inputs?.find(input => input.kind === "work-spec");
  if (!ref) return null;
  const spec = await readJSON<Record<string, unknown>>((await new RemoteWorkInputStore(root).verify(ref)).path);
  if (!spec.physical_execution) return null;
  return parsePhysicalExecution(spec.physical_execution).kind !== "physical-infrastructure-retry" ? spec : null;
}

export async function loadRemoteRerunJournal(input: { root: string; evalDirectory: string; plan: EvalExecutionPlanV1; request: EvalRequest; offer: RemoteWorkOfferV1 }) {
  const spec = await remoteRerunSpec(input.root, input.offer);
  if (!spec) return null;
  const physical = parsePhysicalExecution(spec.physical_execution);
  if (physical.kind === "physical-infrastructure-retry") return null;
  assertPhysicalWork(input.plan, input.offer.work, physical);
  if (spec.schema_version !== "2" || sha256JSON(spec.plan) !== sha256JSON(input.plan)
    || sha256JSON(spec.work) !== sha256JSON(input.offer.work)
    || sha256JSON(spec.request) !== sha256JSON({ ...input.request, dataset: "task-input" })) throw ambiguous("remote rerun sealed inputs differ from its frozen source");
  const verifier = physical.kind === "verifier-only" ? parseRemoteVerifierWork(spec.verifier_only) : undefined;
  const identity = verifier ? remoteVerifierWorkIdentity({ ...input, verifier, physical, work: input.offer.work })
    : { schema_version: "1", rerun_id: physical.rerun_id, source_work_id: physical.source_work_id,
      work_id: input.offer.work.work_id, plan_digest: sha256JSON(input.plan), request_digest: sha256JSON(input.request) };
  const file = path.join(input.evalDirectory, "reruns", physical.rerun_id, "remote-work", `${input.offer.work.work_id}.json`);
  const record = await readJSON<{ identity: unknown; state: string; lease_id?: string; result?: EvalRemoteWorkExecutionResult } | null>(file, null);
  if (!record || sha256JSON(record.identity) !== sha256JSON(identity)
    || !["dispatching", "running", "terminal", "not-started", "collected", "completed"].includes(record.state)
    || record.lease_id !== undefined && record.lease_id !== input.offer.lease.lease_id
    || record.result !== undefined && record.result.leaseId !== input.offer.lease.lease_id) throw ambiguous("remote rerun journal has no matching durable dispatch identity");
  return { file, identity, record, physical, ...(verifier ? { verifier } : {}) };
}

export type RemoteRerunJournal = NonNullable<Awaited<ReturnType<typeof loadRemoteRerunJournal>>>;
export async function withdrawRemoteRerunJournal(journal: RemoteRerunJournal, leaseId: string): Promise<void> {
  if (journal.record.result) throw ambiguous("a collected remote rerun cannot become unstarted");
  await atomicWriteJSON(journal.file, { identity: journal.identity, state: "not-started", lease_id: leaseId });
}
export async function collectRemoteRerunJournal(journal: RemoteRerunJournal, result: EvalRemoteWorkExecutionResult): Promise<void> {
  if (journal.record.result) {
    if (sha256JSON(journal.record.result) !== sha256JSON(result)) throw ambiguous("remote rerun changed its collected result");
    if (["collected", "completed"].includes(journal.record.state)) return;
  }
  await atomicWriteJSON(journal.file, { identity: journal.identity, state: "collected", lease_id: result.leaseId, result });
}
export async function completeRemoteRerunJournal(journal: RemoteRerunJournal, leaseId: string): Promise<void> {
  const current = await readJSON<RemoteRerunJournal["record"]>(journal.file);
  if (sha256JSON(current.identity) !== sha256JSON(journal.identity) || !["collected", "completed"].includes(current.state)
    || current.result?.leaseId !== leaseId) throw ambiguous("remote rerun has no collected result for its released lease");
  await atomicWriteJSON(journal.file, { ...current, state: "completed" });
}
function ambiguous(message: string): HitchError { return new HitchError(message, { code: "execution_state_ambiguous", exitCode: 12 }); }
