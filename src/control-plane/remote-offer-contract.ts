import type { ExecutionProviderStatusV1, RemoteWorkOfferV1 } from "../domain/index.js";
import { assertPhysicalWork, assertRemoteVerifierWork, parseEvalExecutionPlan, parsePhysicalExecution } from "../evals/index.js";
import { HitchError, readJSON, sha256JSON } from "../foundation/index.js";
import { remoteModelBinding } from "./remote-model-routes.js";
import type { RemoteModelTargetV2 } from "./remote-model-routes.js";
import type { RemoteWorkInputStore } from "./remote-work-inputs.js";

export async function validateRemoteOfferContract(offer: RemoteWorkOfferV1, features: ExecutionProviderStatusV1["features"], inputs: RemoteWorkInputStore, target?: RemoteModelTargetV2): Promise<void> {
  const ref = offer.inputs?.find(input => input.kind === "work-spec");
  if (!ref) { if (target) throw rejected("remote model needs a sealed work spec"); return; }
  const spec = await readJSON<Record<string, unknown>>((await inputs.verify(ref)).path);
  const physical = spec.physical_execution === undefined ? undefined : parsePhysicalExecution(spec.physical_execution);
  if (spec.physical_execution !== undefined) {
    if (spec.schema_version !== "2" || features.physical_work !== "2") throw rejected("remote worker lacks physical_work v2");
    assertPhysicalWork(parseEvalExecutionPlan(spec.plan), offer.work, physical);
    if (sha256JSON(spec.work) !== sha256JSON(offer.work)) throw rejected("remote physical work differs from the sealed spec");
  }
  if ((physical?.kind === "verifier-only") !== (spec.verifier_only !== undefined)) throw rejected("verifier-only has no matching source descriptor and physical identity");
  if (spec.verifier_only !== undefined) {
    if (features.verifier_only !== "2" || !features.docker) throw rejected("remote worker lacks verifier_only v2");
    const runtime = spec.controller_runtime as { runtime_id?: unknown } | undefined;
    assertRemoteVerifierWork({ verifier: spec.verifier_only, plan: parseEvalExecutionPlan(spec.plan), work: offer.work,
      physical, runtimeId: typeof runtime?.runtime_id === "string" ? runtime.runtime_id : "" });
    if (target || spec.model_binding !== undefined || spec.verifier_source !== undefined || offer.credential_names?.length
      || !Array.isArray(spec.credential_names) || spec.credential_names.length) throw rejected("remote verifier-only must not acquire model access");
    const kinds = ["work-spec", "harness-artifact", "controller-runtime", "task-input", "verifier-source", "verifier-runtime"];
    if (offer.inputs?.length !== kinds.length || kinds.some(kind => offer.inputs!.filter(item => item.kind === kind).length !== 1)
      || offer.inputs.some(item => item.format !== (item.kind === "work-spec" ? "json" : "hitch-tree-v1"))) throw rejected("remote verifier-only inputs are incomplete or ambiguous");
  }
  if (target) {
    const binding = remoteModelBinding(target);
    const feature = binding.kind === "training-external" ? "training_external_binding" : "managed_model_node";
    if (features[feature] !== "2" || !features.model_proxy) throw rejected(`remote worker lacks ${feature} v2`);
    if (spec.schema_version !== "2" || sha256JSON(spec.model_binding) !== sha256JSON(binding)) throw rejected("remote model target differs from the sealed work spec");
  } else if (spec.model_binding !== undefined) throw rejected("remote model work has no controller-owned target");
}

function rejected(message: string): HitchError { return new HitchError(message, { code: "worker_protocol_invalid", exitCode: 2 }); }
