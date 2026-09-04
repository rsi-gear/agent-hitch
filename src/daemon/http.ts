import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResourceVectorV1 } from "../domain/index.js";
import { invalidInput } from "../foundation/index.js";

export function errorStatus(error: unknown): number {
  if (new Set(["idempotency_conflict", "eval_rerun_source_not_terminal", "eval_rerun_cancelled"]).has(String((error as { code?: unknown }).code))) return 409;
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  if (exitCode === 2) return 400;
  if (exitCode === 3) return 404;
  if (exitCode === 11) return 403;
  if ([4, 5, 10].includes(exitCode as number)) return 422;
  return 500;
}

export function httpErrorCode(status: number): string {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  return "daemon_request_failed";
}

export async function readBodyJSON(request: IncomingMessage, limit = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw invalidInput("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown; }
  catch { throw invalidInput("invalid JSON request body"); }
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

export function defaultLogger(type: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} ${type} ${JSON.stringify(fields)}\n`);
}

export function defaultResourceCapacity(maxConcurrent: number): ResourceVectorV1 {
  return {
    cpu_millis: maxConcurrent * 1_000,
    memory_bytes: maxConcurrent * 1024 * 1024 * 1024,
    container_slots: maxConcurrent,
    build_slots: 1,
  };
}
