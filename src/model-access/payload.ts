export function capturedPayload(value: { body: Buffer; truncated: boolean }, contentType: string | string[] | undefined): unknown {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  const text = value.body.toString("utf8");
  if (!value.truncated && type?.toLowerCase().includes("json")) {
    try { return JSON.parse(text) as unknown; } catch { /* Preserve malformed provider payload as text. */ }
  }
  return { encoding: "utf8", body: text, truncated: value.truncated };
}

export function modelFromPayload(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).response;
    if (nested && typeof nested === "object") return modelFromPayload(nested);
    const model = (value as Record<string, unknown>).model;
    if (typeof model === "string" && model) return model;
    const body = (value as Record<string, unknown>).body;
    if (typeof body === "string") {
      for (const line of body.split(/\r?\n/).reverse()) {
        const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
        if (!payload || payload === "[DONE]") continue;
        try { const nested = modelFromPayload(JSON.parse(payload) as unknown); if (nested) return nested; } catch { /* Continue. */ }
      }
    }
  }
  return null;
}

export function usageFromPayload(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.response && typeof record.response === "object") return usageFromPayload(record.response);
  if (typeof record.body === "string") {
    for (const line of record.body.split(/\r?\n/).reverse()) {
      if (!line.startsWith("data:")) continue;
      try { const usage = usageFromPayload(JSON.parse(line.slice(5).trim())); if (usage) return usage; } catch { /* SSE sentinel. */ }
    }
  }
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const numbers = Object.entries(usage).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0);
  return numbers.length > 0 ? Object.fromEntries(numbers) : null;
}

