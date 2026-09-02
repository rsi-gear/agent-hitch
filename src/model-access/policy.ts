import type { AdapterRuntimeRequirementsV1, ExecutionProviderStatusV1, ModelCapturePlanV1, ModelCapturePolicyV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";

export function normalizeModelCapturePolicy(value?: Partial<ModelCapturePolicyV1>): ModelCapturePolicyV1 {
  const mode = value?.mode ?? "native";
  const required = value?.required ?? false;
  if (!new Set(["off", "native", "proxy", "hybrid"]).has(mode) || typeof required !== "boolean") {
    throw new TypeError("model capture policy is invalid");
  }
  if (mode === "off" && required) throw new TypeError("off model capture cannot be required");
  return { mode, required };
}

export function planModelCapture(input: {
  policy?: Partial<ModelCapturePolicyV1>;
  adapter: AdapterRuntimeRequirementsV1;
  provider: ExecutionProviderStatusV1;
}): ModelCapturePlanV1 {
  const policy = normalizeModelCapturePolicy(input.policy);
  if (policy.mode === "off") return { requested_mode: "off", effective_mode: "off", required: policy.required };
  const native = input.adapter.capture.native_events;
  if (policy.mode === "native") {
    if (native) return { requested_mode: "native", effective_mode: "native", required: policy.required };
    return degradeOrReject(policy, "adapter-native-capture-unsupported", "off");
  }
  const proxy = input.adapter.endpoint_override === "supported"
    && input.adapter.capture.model_proxy_compatible
    && input.provider.features.model_proxy;
  const hybrid = proxy && native;
  if (policy.mode === "proxy" && proxy || policy.mode === "hybrid" && hybrid) {
    return {
      requested_mode: policy.mode,
      effective_mode: policy.mode,
      required: policy.required,
      topology: input.provider.provider === "local-docker" ? "host-side" : "in-sandbox",
    };
  }
  const reason = input.adapter.endpoint_override !== "supported"
    ? "adapter-endpoint-override-unsupported"
    : !input.adapter.capture.model_proxy_compatible
      ? "adapter-model-proxy-incompatible"
      : !input.provider.features.model_proxy
        ? "provider-model-proxy-unavailable"
        : "adapter-native-capture-unsupported";
  return degradeOrReject(policy, reason, native ? "native" : "off");
}

function degradeOrReject(
  policy: ModelCapturePolicyV1,
  reason: string,
  fallback: "native" | "off",
): ModelCapturePlanV1 {
  if (policy.required) {
    throw new HitchError(`required model capture is unsupported: ${reason}`, { code: "model_capture_unsupported", exitCode: 10 });
  }
  return { requested_mode: policy.mode, effective_mode: fallback, required: false, degraded_reason: reason };
}
