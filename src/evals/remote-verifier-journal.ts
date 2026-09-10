import path from "node:path";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalRequest, RemotePhysicalExecutionV2, RemoteVerifierWorkV2 } from "../domain/index.js";
import { HitchError, readJSON, sha256JSON } from "../foundation/index.js";
import { assertRemoteVerifierWork } from "./remote-verifier-contract.js";

export function remoteVerifierWorkIdentity(input: {
  verifier: RemoteVerifierWorkV2; physical: RemotePhysicalExecutionV2; plan: EvalExecutionPlanV1; request: EvalRequest; work: BackendWorkItemV1;
}) {
  assertRemoteVerifierWork({ verifier: input.verifier, plan: input.plan, work: input.work, physical: input.physical,
    runtimeId: input.verifier.source_manifest.controller_runtime_id });
  if (input.physical.kind !== "verifier-only" || input.request.training_binding) throw ambiguous();
  return { schema_version: "2", execution_kind: "verifier-only", rerun_id: input.physical.rerun_id, source_work_id: input.physical.source_work_id,
    work_id: input.work.work_id, plan_digest: sha256JSON(input.plan), request_digest: sha256JSON(input.request), verifier_work_digest: sha256JSON(input.verifier) };
}

/** A scoring dispatch must already have an immutable journal for crash recovery. */
export async function assertRemoteVerifierDispatch(input: Parameters<typeof remoteVerifierWorkIdentity>[0] & { evalDirectory: string }) {
  const identity = remoteVerifierWorkIdentity(input);
  const file = path.join(input.evalDirectory, "reruns", identity.rerun_id, "remote-work", `${identity.work_id}.json`);
  const record = await readJSON<{ identity: unknown; state: string; result?: unknown } | null>(file, null);
  if (!record || record.state !== "dispatching" || record.result || sha256JSON(record.identity) !== sha256JSON(identity)) throw ambiguous();
}
function ambiguous(): HitchError { return new HitchError("remote verifier dispatch requires its frozen durable work identity", { code: "execution_state_ambiguous", exitCode: 12 }); }
