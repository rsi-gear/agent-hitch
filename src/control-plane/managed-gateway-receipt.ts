import path from "node:path";
import type { AcquireManagedInferenceInputV1, ModelEndpointBindingV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths } from "../foundation/index.js";

export interface ManagedGatewayReceiptInput {
  serviceId: string; epoch: number; inferenceId: string; isolationKey: string; ownerId: string;
  cacheScopeOwner: string; evidenceOwner: AcquireManagedInferenceInputV1["evidence_owner"];
  binding: ModelEndpointBindingV1; credential: string;
}
function receipt(input: ManagedGatewayReceiptInput) {
  return { schema_version: "2", service_id: input.serviceId, epoch: input.epoch, inference_id: input.inferenceId,
    isolation_key: input.isolationKey, owner_id: input.ownerId,
    scope_digest: sha256JSON({ cache_scope_owner: input.cacheScopeOwner, evidence_owner: input.evidenceOwner ?? null }),
    target_digest: sha256JSON({ binding: input.binding, credential: input.credential }) };
}
function file(root: string, input: ManagedGatewayReceiptInput) {
  if (!/^inference_[a-f0-9]{32}$/.test(input.serviceId) || !/^run_[a-f0-9]{32}$/.test(input.ownerId)) throw ambiguous();
  return path.join(statePaths(root).inferenceServices, input.serviceId, "gateways", receipt(input).target_digest.slice(7) + ".json");
}
export async function sealManagedGateway(root: string, input: ManagedGatewayReceiptInput): Promise<void> {
  const expected = receipt(input), previous = await readJSON<unknown | null>(file(root, input), null);
  if (previous && sha256JSON(previous) !== sha256JSON(expected)) throw ambiguous();
  if (!previous) await atomicWriteJSON(file(root, input), expected);
}
export async function verifyManagedGateway(root: string, input: ManagedGatewayReceiptInput): Promise<void> {
  if (sha256JSON(await readJSON(file(root, input), null)) !== sha256JSON(receipt(input))) throw ambiguous();
}
function ambiguous() { return new HitchError("original private gateway receipt is missing or changed", { code: "inference_recovery_ambiguous", exitCode: 12 }); }
