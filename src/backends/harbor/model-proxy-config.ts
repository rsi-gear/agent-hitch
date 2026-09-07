import type { ModelProxyRouteV1 } from "../../domain/index.js";
import { invalidInput } from "../../foundation/index.js";

export function parseHarborModelProxyRoute(value: ModelProxyRouteV1): ModelProxyRouteV1 {
  const managed = parseManagedInference(value?.managed_inference);
  if (value.schema_version !== "1" || !new Set(["proxy", "hybrid"]).has(value.mode)
    || typeof value.required !== "boolean" || !new Set(["host-side", "in-sandbox"]).has(value.topology)
    || !proxyTemplate(value.base_url_template, true) || !proxyTemplate(value.health_url_template, false)) {
    throw invalidInput("Harbor model proxy route is invalid");
  }
  return { ...value, ...(managed ? { managed_inference: managed } : {}) };
}

function digest(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function parseManagedInference(value: unknown): ModelProxyRouteV1["managed_inference"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "inference_id" && key !== "model_id")
    || Object.keys(value).length !== 2) throw invalidInput("Harbor managed inference identity is invalid");
  const record = value as Record<string, unknown>;
  if (!digest(record.inference_id) || !digest(record.model_id)) throw invalidInput("Harbor managed inference identity is invalid");
  return { inference_id: record.inference_id as import("../../domain/index.js").Sha256, model_id: record.model_id as import("../../domain/index.js").Sha256 };
}

function proxyTemplate(value: string, provider: boolean): boolean {
  if (typeof value !== "string" || value.length > 2_048 || /[\0\r\n]/.test(value)) return false;
  if ((value.match(/\{run_id\}/g) ?? []).length !== 1 || (value.match(/\{provider\}/g) ?? []).length !== (provider ? 1 : 0)) return false;
  try {
    const parsed = new URL(value.replace("{run_id}", `run_${"a".repeat(32)}`).replace("{provider}", "openai"));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch { return false; }
}
