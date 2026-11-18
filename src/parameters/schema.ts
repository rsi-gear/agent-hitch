import { HitchError, canonicalJSON } from "../foundation/index.js";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };
export interface ParameterSchema {
  type: string | string[]; properties?: Record<string, ParameterSchema>; required?: string[];
  additionalProperties?: boolean; items?: ParameterSchema; enum?: JSONValue[]; const?: JSONValue;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
}
export function failure(message: string, code = "invalid_parameter_contract"): never {
  throw new HitchError(message, { code, exitCode: 2 });
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) failure(`${label}: unknown field ${key}`);
}
export function pointer(value: string): string[] {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("*") || /~(?:[^01]|$)/.test(value)) failure(`invalid exact JSON Pointer: ${value}`);
  const parts = value.slice(1).split("/").map(p => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some(p => ["__proto__", "constructor", "prototype"].includes(p))) failure("unsafe parameter path");
  return parts;
}
export function at(value: unknown, path: string): unknown {
  for (const part of pointer(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) failure(`unknown parameter path: ${path}`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function schemaAt(schema: ParameterSchema, path: string): ParameterSchema {
  for (const part of pointer(path)) {
    if (!schema.properties || !Object.hasOwn(schema.properties, part)) failure(`path absent from schema: ${path}`);
    schema = schema.properties[part]!;
  }
  return schema;
}
export function validateSchema(raw: unknown, label = "schema"): asserts raw is ParameterSchema {
  const s = record(raw, label);
  exact(s, ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"], label);
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (!types.length || new Set(types).size !== types.length || types.some(t => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(t)))) failure(`${label}: invalid type`);
  if (s.properties !== undefined) for (const [key, child] of Object.entries(record(s.properties, label))) {
    if (["__proto__", "constructor", "prototype"].includes(key)) failure("unsafe schema key");
    validateSchema(child, `${label}/${key}`);
  }
  if (types.includes("object") && (!s.properties || s.additionalProperties !== false)) failure(`${label}: object schema must explicitly declare properties and additionalProperties:false`);
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(k => typeof k !== "string" || !Object.hasOwn(s.properties ?? {}, k)) || new Set(s.required).size !== s.required.length)) failure(`${label}: invalid required keys`);
  if (types.includes("array") && !s.items) failure(`${label}: array schema requires items`);
  if (s.items) validateSchema(s.items, `${label} items`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) failure(`${label}: empty enum`);
  for (const key of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isFinite(s[key]))) failure(`${label}: invalid ${key}`);
}
export function validateValue(value: unknown, s: ParameterSchema, label = "parameters"): asserts value is JSONValue {
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const matches = types.some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "integer" ? Number.isSafeInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === t);
  if (!matches) failure(`${label}: invalid type`, "parameter_value_rejected");
  if (s.enum && !s.enum.some(v => canonicalJSON(v) === canonicalJSON(value)) || Object.hasOwn(s, "const") && canonicalJSON(s.const) !== canonicalJSON(value)) failure(`${label}: value not allowed`, "parameter_value_rejected");
  if (typeof value === "number" && (s.minimum !== undefined && value < s.minimum || s.maximum !== undefined && value > s.maximum)) failure(`${label}: value outside range`, "parameter_value_rejected");
  if (typeof value === "string" && (s.minLength !== undefined && value.length < s.minLength || s.maxLength !== undefined && value.length > s.maxLength)) failure(`${label}: invalid string length`, "parameter_value_rejected");
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems || s.maxItems !== undefined && value.length > s.maxItems) failure(`${label}: invalid array length`, "parameter_value_rejected");
    value.forEach((v, i) => validateValue(v, s.items!, `${label}/${i}`));
  } else if (value && typeof value === "object") {
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) failure(`${label}: missing ${key}`, "parameter_value_rejected");
    for (const [key, v] of Object.entries(value)) {
      const child = s.properties?.[key];
      if (!child) failure(`${label}: unknown ${key}`, "parameter_value_rejected");
      validateValue(v, child, `${label}/${key}`);
    }
  }
}
/** JSON with duplicate keys is ambiguous permission input and never accepted. */
export function parseParameterJSON(text: string, maxBytes = 1024 * 1024): unknown {
  if (Buffer.byteLength(text) > maxBytes) failure("parameter JSON exceeds byte limit");
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  const string = (): string => { const start = i++; while (i < text.length) { const c = text[i++]; if (c === "\\") i++; else if (c === '"') return JSON.parse(text.slice(start, i)) as string; } return failure("unterminated JSON string"); };
  const scan = (depth: number): void => {
    if (depth > 64) failure("parameter JSON nesting exceeds 64");
    space(); const c = text[i];
    if (c === '{') {
      i++; space(); const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      while (true) {
        space(); if (text[i] !== '"') failure("invalid JSON object");
        const key = string(); if (keys.has(key)) failure(`duplicate JSON key: ${key}`); keys.add(key);
        space(); if (text[i++] !== ':') failure("invalid JSON object"); scan(depth + 1); space();
        if (text[i] === '}') { i++; return; } if (text[i++] !== ',') failure("invalid JSON object");
      }
    }
    if (c === '[') { i++; space(); if (text[i] === ']') { i++; return; } while (true) { scan(depth + 1); space(); if (text[i] === ']') { i++; return; } if (text[i++] !== ',') failure("invalid JSON array"); } }
    if (c === '"') { string(); return; }
    const match = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!match) failure("invalid JSON value"); i += match[0].length;
  };
  scan(0); space(); if (i !== text.length) failure("trailing JSON input");
  return JSON.parse(text);
}
