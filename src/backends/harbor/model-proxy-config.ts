import type { ModelProxyRouteV1 } from "../../domain/index.js";
import { invalidInput } from "../../foundation/index.js";

export function parseHarborModelProxyRoute(value: ModelProxyRouteV1): ModelProxyRouteV1 {
  if (value.schema_version !== "1" || !new Set(["proxy", "hybrid"]).has(value.mode)
    || typeof value.required !== "boolean" || value.topology !== "host-side"
    || !proxyTemplate(value.base_url_template, true) || !proxyTemplate(value.health_url_template, false)) {
    throw invalidInput("Harbor model proxy route is invalid");
  }
  return { ...value };
}

function proxyTemplate(value: string, provider: boolean): boolean {
  if (typeof value !== "string" || value.length > 2_048 || /[\0\r\n]/.test(value)) return false;
  if ((value.match(/\{run_id\}/g) ?? []).length !== 1 || (value.match(/\{provider\}/g) ?? []).length !== (provider ? 1 : 0)) return false;
  try {
    const parsed = new URL(value.replace("{run_id}", `run_${"a".repeat(32)}`).replace("{provider}", "openai"));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch { return false; }
}
