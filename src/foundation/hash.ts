import { createHash } from "node:crypto";
import type { Sha256 } from "../domain/index.js";

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256JSON(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
}

export function sha256Bytes(value: string | Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digest(value: unknown): string {
  return sha256JSON(value);
}
