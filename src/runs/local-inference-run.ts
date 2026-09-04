import type {
  ManagedInferenceCoordinator,
  ManagedInferenceLeaseV1,
  ModelIdentityV1,
  RunId,
  Sha256,
} from "../domain/index.js";
import { HitchError, atomicWriteJSON } from "../foundation/index.js";
import type { ValidatedRunRequest } from "./request.js";

export interface ManagedModelProxyIdentity {
  inference_id: Sha256;
  model_id: Sha256;
}

export function bindManagedModelProxy(
  request: ValidatedRunRequest,
  proxy: ManagedModelProxyIdentity | undefined,
  env: NodeJS.ProcessEnv,
): ValidatedRunRequest {
  if (!proxy) return request;
  if (!request.local_inference || env.HITCH_HARBOR_INTERNAL !== "1" || env.HITCH_MANAGED_LOCAL_INFERENCE !== "1") {
    throw new HitchError("managed model proxy handoff is invalid", {
      code: "local_inference_topology_unsupported", exitCode: 12,
    });
  }
  const { local_inference: _localInference, ...proxied } = request;
  return {
    ...proxied,
    model_identity: {
      provider: "local",
      requested_id: proxied.model,
      effective_id: proxy.model_id,
      identity_resolved: true,
      inference_id: proxy.inference_id,
    },
  };
}

export async function acquireRunInference(input: {
  coordinator: ManagedInferenceCoordinator;
  request: ValidatedRunRequest & { local_inference: NonNullable<ValidatedRunRequest["local_inference"]> };
  runId: RunId;
  signal?: AbortSignal;
  manifest: Record<string, unknown>;
  manifestPath: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<{ lease: ManagedInferenceLeaseV1; manifest: Record<string, unknown> }> {
  const lease = await input.coordinator.acquire({
    run_id: input.runId,
    harness_ref: input.request.harness_ref,
    selection: input.request.local_inference,
    cache_scope_owner: input.request.parent?.eval_id ?? input.runId,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onEvent ? { on_event: input.onEvent } : {}),
  });
  if (!lease) throw new HitchError("local inference lease was not created", { code: "inference_route_unavailable", exitCode: 12 });
  const manifest = {
    ...input.manifest,
    inference_id: lease.lock.inference_id,
    inference_ref: "inference/execution.json",
    model: managedModelIdentity(input.request.model_identity, lease),
  };
  await atomicWriteJSON(input.manifestPath, manifest);
  return { lease, manifest };
}

export function managedModelIdentity(identity: ModelIdentityV1, lease: ManagedInferenceLeaseV1): ModelIdentityV1 {
  return {
    ...identity,
    provider: "local",
    effective_id: lease.lock.model_id,
    identity_resolved: true,
    inference_id: lease.lock.inference_id,
  };
}
