import { request } from "node:http";
import { runCommand } from "../foundation/index.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface DockerEngineContainerStatsV1 {
  cpu_time_ns?: number;
  memory_bytes?: number;
  kernel_peak_bytes?: number;
  read_at?: string;
}

export async function readDockerEngineContainerStats(
  containerId: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DockerEngineContainerStatsV1> {
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new TypeError("Docker Engine stats container ID is invalid");
  const env = options.env ?? process.env;
  const endpoint = await dockerEndpoint(env);
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Docker Engine stats timeout is invalid");
  const payload = await requestJson(endpoint, `/containers/${containerId}/stats?stream=false&one-shot=true`, timeoutMs, options.signal);
  return parseDockerEngineContainerStats(payload);
}

export function parseDockerEngineContainerStats(value: unknown): DockerEngineContainerStatsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Docker Engine stats response is invalid");
  const stats = value as Record<string, unknown>;
  const cpuStats = record(stats.cpu_stats);
  const cpuUsage = record(cpuStats?.cpu_usage);
  const totalUsage = cpuUsage?.total_usage;
  const memoryUsage = record(stats.memory_stats)?.usage;
  const memoryPeak = record(stats.memory_stats)?.max_usage;
  if (totalUsage !== undefined && (!Number.isSafeInteger(totalUsage) || (totalUsage as number) < 0)) throw new TypeError("Docker Engine cumulative CPU time is invalid");
  if (memoryUsage !== undefined && (!Number.isSafeInteger(memoryUsage) || (memoryUsage as number) < 0)) throw new TypeError("Docker Engine memory usage is invalid");
  if (memoryPeak !== undefined && (!Number.isSafeInteger(memoryPeak) || (memoryPeak as number) < 0)) throw new TypeError("Docker Engine memory peak is invalid");
  return {
    ...(totalUsage === undefined ? {} : { cpu_time_ns: totalUsage as number }),
    ...(memoryUsage === undefined ? {} : { memory_bytes: memoryUsage as number }),
    // Some backends expose a zero placeholder for unsupported max_usage. A
    // counter below current usage cannot be a valid kernel peak.
    ...(memoryPeak === undefined || memoryUsage !== undefined && (memoryPeak as number) < (memoryUsage as number) ? {} : { kernel_peak_bytes: memoryPeak as number }),
    ...(typeof stats.read === "string" && Number.isFinite(Date.parse(stats.read)) && !stats.read.startsWith("0001-") ? { read_at: stats.read } : {}),
  };
}

interface DockerEndpoint { socketPath?: string; protocol?: string; hostname?: string; port?: number }
async function dockerEndpoint(env: NodeJS.ProcessEnv): Promise<DockerEndpoint> {
  let raw = env.HITCH_DOCKER_SOCKET || (!env.DOCKER_CONTEXT ? env.DOCKER_HOST : undefined);
  if (!raw) {
    // Docker contexts take precedence over DOCKER_HOST. Never accidentally
    // sample /var/run/docker.sock while the CLI operates on another daemon.
    const context = env.DOCKER_CONTEXT || (await runCommand(env.HITCH_DOCKER_PATH || "docker", ["context", "show"], { env, timeoutMs: 2_000 })).stdout.trim();
    if (!context || /[\0\r\n]/.test(context)) throw new TypeError("Docker stats context is unavailable");
    raw = (await runCommand(env.HITCH_DOCKER_PATH || "docker", ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}', context],
      { env, timeoutMs: 2_000 })).stdout.trim();
  }
  if (!raw) return { socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock" };
  if (raw.startsWith("unix://")) return { socketPath: decodeURIComponent(new URL(raw).pathname) };
  if (raw.startsWith("npipe://")) return { socketPath: raw.slice("npipe://".length).replace(/^\/+/, "//") };
  if (raw.startsWith("tcp://") || raw.startsWith("http://")) {
    const url = new URL(raw.replace(/^tcp:/, "http:"));
    return { protocol: "http:", hostname: url.hostname, port: Number(url.port || 2375) };
  }
  throw new TypeError("Docker Engine endpoint is unsupported for cumulative stats");
}

function requestJson(
  endpoint: DockerEndpoint,
  pathname: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestOptions = endpoint.socketPath
      ? { socketPath: endpoint.socketPath, path: pathname, method: "GET" }
      : { protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port, path: pathname, method: "GET" };
    const req = request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("Docker Engine stats response is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Docker Engine stats returned HTTP ${response.statusCode ?? 0}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
        catch (error) { reject(new TypeError(`Docker Engine stats JSON is invalid: ${(error as Error).message}`)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Docker Engine stats timed out")), timeoutMs);
    timer.unref();
    const abort = (): void => { req.destroy(Object.assign(new Error("Docker Engine stats cancelled"), { code: "cancelled" })); };
    signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject);
    req.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    req.end();
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
