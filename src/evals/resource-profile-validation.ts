export function profileRecord(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("resource profile must be an object");
  const record = value as Record<string, unknown>;
  if (required.some(key => !(key in record)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError("resource profile fields are invalid");
  }
  return record;
}
export function profileText(value: unknown, limit = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\0\r\n]/.test(value)) throw new TypeError("resource profile text is invalid");
  return value;
}
export function profileDigest(value: unknown): import("../domain/index.js").Sha256 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError("resource profile digest is invalid");
  return value as import("../domain/index.js").Sha256;
}
export function profileInteger(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError("resource profile integer is invalid");
  return value as number;
}
export function profileJSON(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("resource profile parameters must be an object");
  const encoded = JSON.stringify(value);
  if (encoded.length > 65536) throw new TypeError("resource profile parameters exceed the limit");
  const check = (item: unknown, depth: number): void => {
    if (depth > 12) throw new TypeError("resource profile parameters are too deep");
    if (item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
    if (Array.isArray(item)) { item.forEach(entry => check(entry, depth + 1)); return; }
    if (item && typeof item === "object") { Object.values(item).forEach(entry => check(entry, depth + 1)); return; }
    throw new TypeError("resource profile parameters must be finite JSON");
  };
  check(value, 0); return JSON.parse(encoded) as Record<string, unknown>;
}
