import type { ModelIdentityV1, Sha256 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

export function inferModelProvider(modelId: string, harnessId: string): string | undefined {
  const prefix = modelId.includes("/") ? modelId.split("/", 1)[0]?.trim() : "";
  if (prefix) return prefix;
  return ({ codex: "openai", claude: "anthropic", deepseek: "deepseek" } as Record<string, string>)[harnessId];
}

/** Conservative: aliases are unresolved unless the caller/provider says otherwise. */
export function defaultModelIdentity(
  requestedId: string,
  harnessId: string,
  options: { provider?: string; effectiveId?: string; parametersSha256?: Sha256; resolved?: boolean } = {},
): ModelIdentityV1 {
  const model: ModelIdentityV1 = {
    requested_id: requestedId,
    effective_id: options.effectiveId ?? requestedId,
    identity_resolved: options.resolved ?? looksImmutableModelId(options.effectiveId ?? requestedId),
  };
  const provider = options.provider ?? inferModelProvider(requestedId, harnessId);
  if (provider) model.provider = provider;
  if (options.parametersSha256) model.parameters_sha256 = options.parametersSha256;
  return model;
}

export function looksImmutableModelId(modelId: string): boolean {
  if (!modelId) return false;
  return /^sha256:[0-9a-f]{64}$/.test(modelId)
    || /(?:^|[-_.])\d{4}-\d{2}-\d{2}(?:$|[-_.])/.test(modelId)
    || /@(?:snapshot|version|commit):[^@\s]+$/i.test(modelId);
}

export function benchmarkVerifierIdentity(benchmarkId: string, benchmarkRevision: string): Sha256 {
  return sha256JSON({ backend: "harbor", benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision, verifier: "dataset" });
}

export function benchmarkTaskDigest(benchmarkId: string, benchmarkRevision: string, taskId: string): Sha256 {
  return sha256JSON({ benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision, task_id: taskId });
}
