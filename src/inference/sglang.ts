import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { InferenceLockV1, InferenceRuntimeManifestV1, InferenceServiceRecordV1, LocalModelManifestV1 } from "../domain/index.js";
import { HitchError, delay, ensureDir, hitchRootId, runCommand, statePaths } from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";
import { materializeLocalModel } from "./materialize.js";

export interface SGLangLaunchInput {
  root: string;
  serviceId: string;
  lock: InferenceLockV1;
  model: LocalModelManifestV1;
  runtime: InferenceRuntimeManifestV1;
  signal?: AbortSignal;
}

export interface SGLangLaunchedService {
  container_id: string;
  base_url: string;
  wire_model: string;
  engine_token: string;
  admin_token: string;
  stop(): Promise<void>;
}

export interface SGLangLauncher {
  start(input: SGLangLaunchInput): Promise<SGLangLaunchedService>;
  stopOrphan?(root: string, record: InferenceServiceRecordV1): Promise<"stopped" | "missing" | "ambiguous">;
}

export interface DockerSGLangLauncherOptions {
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  run?: (executable: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
  fetch?: typeof fetch;
}

export class DockerSGLangLauncher implements SGLangLauncher {
  private readonly docker: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly invoke: (executable: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
  private readonly request: typeof fetch;

  constructor(options: DockerSGLangLauncherOptions = {}) {
    this.env = options.env ?? process.env;
    this.docker = options.dockerExecutable || this.env.HITCH_DOCKER_PATH || "docker";
    this.invoke = options.run ?? ((executable, args, timeoutMs = 30 * 60_000) => runCommand(executable, args, {
      env: this.env, timeoutMs, failureCode: "inference_process_exited", failureExitCode: 12,
    }));
    this.request = options.fetch ?? fetch;
  }

  async start(input: SGLangLaunchInput): Promise<SGLangLaunchedService> {
    if (input.runtime.package.kind !== "oci" || input.runtime.backend !== input.lock.execution.platform.backend) {
      throw new TypeError("SGLang runtime does not match lock backend");
    }
    const modelDirectory = await materializeLocalModel(input.root, input.model);
    const cacheDirectory = await ensureDir(path.join(statePaths(input.root).inferenceCache, input.runtime.runtime_id.slice("sha256:".length)));
    const port = await availablePort();
    const engineToken = randomBytes(32).toString("hex");
    const adminToken = randomBytes(32).toString("hex");
    const wireModel = `hitch-${input.model.model_id.slice("sha256:".length, "sha256:".length + 16)}`;
    const network = `hitch-inference-${hitchRootId(input.root)}`;
    await this.ensureNetwork(network);
    const name = `hitch-sglang-${input.serviceId.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 48)}`;
    const args = dockerArguments({
      input, modelDirectory, cacheDirectory, port, engineToken, adminToken, wireModel, network, name,
    });
    let containerId = "";
    try {
      containerId = (await this.invoke(this.docker, args, 60_000)).stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new TypeError("Docker returned an invalid SGLang container ID");
      await this.waitUntilReady(`http://127.0.0.1:${port}`, engineToken, wireModel, input.lock, input.signal);
    } catch (error) {
      if (containerId) await this.invoke(this.docker, ["rm", "-f", containerId], 30_000).catch(() => {});
      throw error;
    }
    let stopped = false;
    return {
      container_id: containerId,
      base_url: `http://127.0.0.1:${port}`,
      wire_model: wireModel,
      engine_token: engineToken,
      admin_token: adminToken,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await this.invoke(this.docker, ["stop", "--time", "10", containerId], 30_000).catch(() => {});
        await this.invoke(this.docker, ["rm", "-f", containerId], 30_000).catch(() => {});
      },
    };
  }

  async stopOrphan(root: string, record: InferenceServiceRecordV1): Promise<"stopped" | "missing" | "ambiguous"> {
    if (!record.container_id) return "missing";
    let inspected: CommandResult;
    try {
      inspected = await this.invoke(this.docker, ["container", "inspect", "--format", "{{json .Config.Labels}}", record.container_id], 10_000);
    } catch { return "missing"; }
    let labels: Record<string, unknown>;
    try { labels = JSON.parse(inspected.stdout) as Record<string, unknown>; } catch { return "ambiguous"; }
    if (labels["io.hitch.local-inference"] !== "true"
      || labels["io.hitch.root-id"] !== hitchRootId(root)
      || labels["io.hitch.inference-id"] !== record.inference_id) return "ambiguous";
    await this.invoke(this.docker, ["rm", "-f", record.container_id], 30_000);
    return "stopped";
  }

  private async ensureNetwork(name: string): Promise<void> {
    try { await this.invoke(this.docker, ["network", "inspect", name], 10_000); return; } catch {}
    try {
      await this.invoke(this.docker, ["network", "create", "--internal", "--driver", "bridge", name], 30_000);
    } catch (error) {
      try { await this.invoke(this.docker, ["network", "inspect", name], 10_000); } catch { throw error; }
    }
  }

  private async waitUntilReady(
    baseUrl: string,
    token: string,
    wireModel: string,
    lock: InferenceLockV1,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = Date.now() + lock.execution.startup_timeout_ms;
    let last = "service did not respond";
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new HitchError("SGLang startup cancelled", { code: "cancelled", exitCode: 9 });
      try {
        const health = await this.request(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
        if (health.ok) {
          const models = await this.request(`${baseUrl}/v1/models`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
          });
          if (!models.ok || !JSON.stringify(await models.json()).includes(wireModel)) throw new Error("served model alias is absent");
          await this.probeResponses(baseUrl, token, wireModel);
          return;
        }
        last = `health returned HTTP ${health.status}`;
      } catch (error) { last = (error as Error).message; }
      await delay(500);
    }
    throw new HitchError(`SGLang startup timed out: ${last}`, { code: "inference_start_timeout", exitCode: 12 });
  }

  private async probeResponses(baseUrl: string, token: string, wireModel: string): Promise<void> {
    const response = await this.request(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: wireModel, input: "Reply with one word.", max_output_tokens: 1, store: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new HitchError(`SGLang Responses probe returned HTTP ${response.status}`, {
        code: "inference_protocol_unsupported", exitCode: 12,
      });
    }
    const body = await response.json() as { status?: unknown };
    if (body.status !== "completed" && body.status !== "incomplete") {
      throw new HitchError("SGLang Responses probe returned an invalid payload", {
        code: "inference_protocol_unsupported", exitCode: 12,
      });
    }
  }
}

function dockerArguments(input: {
  input: SGLangLaunchInput;
  modelDirectory: string;
  cacheDirectory: string;
  port: number;
  engineToken: string;
  adminToken: string;
  wireModel: string;
  network: string;
  name: string;
}): string[] {
  const { lock } = input.input;
  const backend = lock.execution.platform;
  const image = input.input.runtime.package;
  if (image.kind !== "oci") throw new TypeError("SGLang Docker launch requires an OCI runtime");
  return [
    "run", "--detach", "--rm", "--name", input.name,
    "--label", "io.hitch.local-inference=true",
    "--label", `io.hitch.root-id=${hitchRootId(input.input.root)}`,
    "--label", `io.hitch.inference-id=${lock.inference_id}`,
    "--network", input.network,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "4096",
    "--shm-size", "2g", "--tmpfs", "/tmp:rw,noexec,nosuid,size=2g",
    "--mount", `type=bind,src=${input.modelDirectory},dst=/model,readonly`,
    "--mount", `type=bind,src=${input.cacheDirectory},dst=/root/.cache`,
    "--publish", `127.0.0.1:${input.port}:30000`,
    ...(backend.backend === "cuda" ? ["--gpus", `device=${backend.device_constraint || "0"}`] : []),
    ...(backend.backend === "cpu" ? ["--env", "SGLANG_USE_CPU_ENGINE=1", "--cpus", String(backend.cpu_threads)] : []),
    image.image,
    "python3", "-m", "sglang.launch_server",
    "--model-path", "/model", "--served-model-name", input.wireModel,
    "--host", "0.0.0.0", "--port", "30000",
    "--api-key", input.engineToken, "--admin-api-key", input.adminToken,
    "--random-seed", String(lock.generation.seed),
    "--load-format", lock.execution.load_format, "--dtype", lock.execution.dtype,
    "--tp", "1", "--dp", "1", "--pp", "1",
    "--context-length", String(lock.execution.context_tokens_per_request),
    "--max-running-requests", String(lock.execution.max_running_requests),
    "--max-total-tokens", String(lock.execution.max_total_tokens),
    "--chunked-prefill-size", String(lock.execution.chunked_prefill_size),
    "--max-prefill-tokens", String(lock.execution.max_prefill_tokens),
    "--kv-cache-dtype", lock.execution.kv_cache_dtype,
    "--attention-backend", lock.execution.attention_backend,
    "--sampling-backend", lock.execution.sampling_backend,
    "--disable-request-logging",
    ...(lock.execution.quantization ? ["--quantization", lock.execution.quantization] : []),
    ...(lock.execution.prefix_cache.mode === "disabled" ? ["--disable-radix-cache"] : []),
    ...(!backend.overlap_schedule ? ["--disable-overlap-schedule"] : []),
    ...(backend.backend === "cuda" ? ["--mem-fraction-static", String(backend.mem_fraction_static)] : ["--device", "cpu"]),
    ...(backend.backend === "cuda" && backend.cuda_graph === "disabled" ? ["--disable-cuda-graph"] : []),
    ...(lock.protocol.tool_call_parser ? ["--tool-call-parser", lock.protocol.tool_call_parser] : []),
    ...(lock.protocol.reasoning_parser ? ["--reasoning-parser", lock.protocol.reasoning_parser] : []),
    ...(lock.execution.deterministic_inference ? ["--enable-deterministic-inference"] : []),
  ];
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
