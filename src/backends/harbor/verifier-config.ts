import type { EvalRequest } from "../../domain/index.js";

/** Configure conservative retries around Harbor's ordinary task verifier. */
export function harborVerifierConfig(request: EvalRequest): Record<string, unknown> {
  return {
    import_path: "hitch_harbor_verifier:HitchRetryingVerifier",
    kwargs: {
      infrastructure_retries: request.infrastructure_retries,
      infrastructure_retry_backoff_ms: request.infrastructure_retry_backoff_ms,
    },
  };
}
