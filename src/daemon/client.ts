import { readFile } from "node:fs/promises";
import { HitchError, readJSON, statePaths } from "../foundation/index.js";

export interface DaemonClient {
  state: { port?: number; instance_id?: string };
  prepareInference: (selection: unknown, onProgress?: (message: string) => void) => Promise<Record<string, unknown>>;
  request: (pathname: string, options?: RequestInit) => Promise<Record<string, unknown>>;
  requestWithMetadata: (pathname: string, options?: RequestInit) => Promise<{
    payload: Record<string, unknown> | string;
    headers: Headers;
    status: number;
  }>;
}

export interface DaemonHealth {
  status: string;
  pid: number;
  port: number;
  instance_id: string;
  scheduler?: unknown;
  eval_scheduler?: unknown;
  resources?: unknown;
  resource_policy?: unknown;
  [key: string]: unknown;
}

export async function daemonClient(root: string): Promise<DaemonClient> {
  const paths = statePaths(root);
  const state = await readJSON<{ port?: number; instance_id?: string } | null>(paths.daemon, null);
  if (!state?.port) throw new Error("daemon is not running");
  const token = (await readFile(paths.token, "utf8")).trim();
  const performRequest = async (pathname: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`http://127.0.0.1:${state.port as number}${pathname}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const mediaType = (contentType.split(";", 1)[0] || "").trim().toLowerCase();
    const isJSONDocument = mediaType === "application/json" || mediaType.endsWith("+json");
    const payload: Record<string, unknown> | string = isJSONDocument ? await response.json() as Record<string, unknown> : await response.text();
    if (!response.ok) {
      const errorPayload = typeof payload === "object" && payload !== null ? payload : {};
      const message = (errorPayload.error as { message?: string } | undefined)?.message || `daemon request failed (${response.status})`;
      const error = new HitchError(message, {
        code: (errorPayload.error as { code?: string } | undefined)?.code || httpErrorCode(response.status),
        exitCode: Number.isInteger((errorPayload.error as { exit_code?: unknown } | undefined)?.exit_code)
          ? (errorPayload.error as { exit_code: number }).exit_code
          : httpExitCode(response.status),
      });
      (error as { status?: number }).status = response.status;
      throw error;
    }
    return { payload, headers: response.headers, status: response.status };
  };
  const request = async (pathname: string, options?: RequestInit) => (await performRequest(pathname, options)).payload as Record<string, unknown>;
  const prepareInference = async (selection: unknown, onProgress?: (message: string) => void) => {
    const response = await fetch(`http://127.0.0.1:${state.port}/v1/inference/prepare`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(selection), signal: AbortSignal.timeout(40 * 60_000),
    });
    if (!response.ok) throw new HitchError(`daemon inference preparation returned HTTP ${response.status}; upgrade the daemon if necessary`, { code: "daemon_request_failed", exitCode: 12 });
    let buffer = "";
    let result: Record<string, unknown> | undefined;
    const decoder = new TextDecoder();
    if (!response.body) throw new HitchError("daemon preparation stream is missing");
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type?: string; message?: string; result?: Record<string, unknown>; error?: { message: string; code: string; exit_code: number } };
        if (event.error) throw new HitchError(event.error.message, { code: event.error.code, exitCode: event.error.exit_code });
        if (event.message) onProgress?.(event.message);
        if (event.type === "inference.prepared") result = event.result;
      }
    }
    if (!result) throw new HitchError("daemon preparation ended without a result", { code: "inference_route_unavailable", exitCode: 12 });
    return result;
  };
  return { state, request, requestWithMetadata: performRequest, prepareInference };
}

export async function probeDaemonHealth(root: string): Promise<DaemonHealth | null> {
  const state = await readJSON<{ port?: number; instance_id?: string } | null>(statePaths(root).daemon, null);
  if (!state?.port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const health = await response.json() as { instance_id?: string } & Record<string, unknown>;
    return health.instance_id === state.instance_id ? health as unknown as DaemonHealth : null;
  } catch {
    return null;
  }
}

export async function readDaemonLogs(root: string, lines: number): Promise<string> {
  let content = "";
  try {
    content = await readFile(statePaths(root).log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return content.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function httpExitCode(status: number): number {
  if (status === 400) return 2;
  if (status === 404) return 3;
  return 12;
}

function httpErrorCode(status: number): string {
  if (status === 400) return "invalid_input";
  if (status === 404) return "not_found";
  return "daemon_request_failed";
}
