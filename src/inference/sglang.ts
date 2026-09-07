import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { InferenceRuntimeObservationV1, InferenceLockV1, InferenceRuntimeManifestV1, InferenceServiceRecordV1, LocalModelManifestV1 } from "../domain/index.js";
import { HitchError, delay, ensureDir, hitchRootId, runCommand, statePaths } from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";
import { defaultDeviceReservationDirectory, releaseInferenceDevice, reserveInferenceDevice } from "./device-reservation.js";
import { validateRuntimeObservation } from "./observation.js";
import { doctorLocalInference } from "./doctor.js";
import { materializeLocalModel } from "./materialize.js";

export interface SGLangLaunchInput {
  root: string;
  serviceId: string;
  lock: InferenceLockV1;
  model: LocalModelManifestV1;
  runtime: InferenceRuntimeManifestV1;
  signal?: AbortSignal;
  onCreated?: (containerId: string) => Promise<void>;
}

export interface SGLangLaunchedService {
  container_id: string;
  base_url: string;
  wire_model: string;
  engine_token: string;
  admin_token: string;
  observation?: InferenceRuntimeObservationV1;
  checkHealth?(): Promise<void>;
  stop(): Promise<void>;
}

export interface SGLangLauncher {
  start(input: SGLangLaunchInput): Promise<SGLangLaunchedService>;
  stopOrphan?(root: string, record: InferenceServiceRecordV1): Promise<"stopped" | "missing" | "ambiguous">;
}

export interface DockerSGLangLauncherOptions {
  deviceReservationDirectory?: string;
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  run?: (executable: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
  fetch?: typeof fetch;
}

export class DockerSGLangLauncher implements SGLangLauncher {
  private readonly deviceDirectory: string;
  private readonly docker: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly invoke: (executable: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
  private readonly request: typeof fetch;

  constructor(options: DockerSGLangLauncherOptions = {}) {
    this.deviceDirectory = options.deviceReservationDirectory ?? defaultDeviceReservationDirectory();
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
    let observation: InferenceRuntimeObservationV1;
    const backend = input.lock.execution.platform;
    if (backend.backend === "cuda") {
      if (!backend.device_constraint) throw new TypeError("CUDA launch requires a locked GPU UUID");
      await reserveInferenceDevice(this.deviceDirectory, input.root, input.serviceId, backend.device_constraint);
    }
    try {
      if (backend.backend === "cuda") {
        const weights = input.model.files.filter((f) => f.path.endsWith(".safetensors")).reduce((sum, f) => sum + f.size, 0);
        const doctor = await doctorLocalInference("cuda", {
          env: this.env, dockerExecutable: this.docker, run: this.invoke,
          deviceConstraint: backend.device_constraint!, requiredMemoryMiB: Math.ceil((weights * 1.25 + 1024 ** 3) / 1024 ** 2),
        });
        if (!doctor.ready) throw new HitchError("locked GPU is no longer available or compatible", { code: "inference_device_unsupported", exitCode: 12 });
      }
      containerId = (await this.invoke(this.docker, args, 60_000)).stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new TypeError("Docker returned an invalid SGLang container ID");
      await input.onCreated?.(containerId);
      await this.waitUntilReady(`http://127.0.0.1:${port}`, engineToken, wireModel, input.lock, containerId, input.signal);
      observation = await this.observe(input, containerId, `http://127.0.0.1:${port}`, adminToken);
      // Warmup must not seed a candidate's prefix cache.
      const cleared = await this.request(`http://127.0.0.1:${port}/flush_cache`, {
        headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!cleared.ok) throw new HitchError("SGLang warmup cache could not be cleared", { code: "inference_runtime_mismatch", exitCode: 12 });
    } catch (error) {
      // A failed docker run can still have created a container. Resolve it by
      // owner labels before releasing a device; transport errors stay ambiguous.
      const cleaned = await this.stopOrphan(input.root, {
        service_id: input.serviceId, inference_id: input.lock.inference_id,
        ...(containerId ? { container_id: containerId } : {}),
      });
      if (cleaned === "ambiguous") throw new HitchError("SGLang startup cleanup is ambiguous; device reservation retained", {
        code: "inference_recovery_ambiguous", exitCode: 12, cause: error,
      });
      throw error;
    }
    let stopped = false;
    let stopping: Promise<void> | undefined;
    return {
      container_id: containerId,
      base_url: `http://127.0.0.1:${port}`,
      wire_model: wireModel,
      engine_token: engineToken,
      admin_token: adminToken,
      observation,
      checkHealth: () => this.checkHealth(containerId, `http://127.0.0.1:${port}`),
      stop: () => {
        if (stopped) return Promise.resolve();
        stopping ??= (async () => {
          await this.invoke(this.docker, ["rm", "-f", containerId], 30_000);
          await releaseInferenceDevice(this.deviceDirectory, input.root, input.serviceId);
          stopped = true;
        })().finally(() => { stopping = undefined; });
        return stopping;
      },
    };
  }

  async stopOrphan(root: string, record: Pick<InferenceServiceRecordV1, "service_id" | "inference_id" | "container_id">): Promise<"stopped" | "missing" | "ambiguous"> {
    try {
      const selector = record.container_id ? ["--filter", `id=${record.container_id}`]
        : ["--filter", `label=io.hitch.root-id=${hitchRootId(root)}`, "--filter", `label=io.hitch.service-id=${record.service_id}`];
      const found = await this.invoke(this.docker, ["container", "ls", "-a", "--no-trunc", ...selector, "--format", "{{.ID}}"], 10_000);
      const ids = found.stdout.trim().split(/\r?\n/).filter(Boolean);
      if (ids.length === 0) {
        await releaseInferenceDevice(this.deviceDirectory, root, record.service_id);
        return "missing";
      }
      if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) return "ambiguous";
      const inspected = await this.inspect(ids[0]!);
      const labels = inspected.Config?.Labels;
      if (labels?.["io.hitch.local-inference"] !== "true" || labels["io.hitch.root-id"] !== hitchRootId(root)
        || labels["io.hitch.inference-id"] !== record.inference_id) return "ambiguous";
      await this.invoke(this.docker, ["rm", "-f", ids[0]!], 30_000);
      await releaseInferenceDevice(this.deviceDirectory, root, record.service_id);
      return "stopped";
    } catch { return "ambiguous"; }
  }

  private async inspect(id: string): Promise<ContainerInspection> {
    const result = await this.invoke(this.docker, ["container", "inspect", "--format", "{{json .}}", id], 10_000);
    const value = JSON.parse(result.stdout) as ContainerInspection;
    if (typeof value.State?.Running !== "boolean" || typeof value.Image !== "string") throw new TypeError("invalid Docker container inspection");
    return value;
  }

  private async checkHealth(id: string, baseUrl: string): Promise<void> {
    const state = (await this.inspect(id)).State;
    if (!state.Running) throw new HitchError(`SGLang container exited (${state.ExitCode})`, {
      code: state.OOMKilled ? "inference_oom" : "inference_process_exited", exitCode: 12,
    });
    const health = await this.request(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new HitchError(`SGLang health returned HTTP ${health.status}`, { code: "inference_route_unavailable", exitCode: 12 });
  }

  private async observe(input: SGLangLaunchInput, id: string, baseUrl: string, token: string): Promise<InferenceRuntimeObservationV1> {
    const container = await this.inspect(id);
    const response = await this.request(`${baseUrl}/server_info`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HitchError("SGLang server_info unavailable", { code: "inference_runtime_mismatch", exitCode: 12 });
    let uuid: string | null = null;
    if (input.lock.execution.platform.backend === "cuda") {
      const probe = await this.invoke(this.docker, ["exec", id, "python3", "-c",
        "import torch; assert torch.cuda.is_available() and torch.cuda.device_count() == 1; assert torch.zeros(1, device='cuda').item() == 0"], 30_000);
      void probe;
      uuid = (await this.invoke(this.docker, ["exec", id, "nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], 10_000)).stdout.trim();
    }
    return validateRuntimeObservation(await response.json(), container.Image, uuid, input.lock, input.runtime);
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
    containerId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = Date.now() + lock.execution.startup_timeout_ms;
    let last = "service did not respond";
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new HitchError("SGLang startup cancelled", { code: "cancelled", exitCode: 9 });
      const state = (await this.inspect(containerId)).State;
      if (!state.Running) throw new HitchError(`SGLang exited during startup (${state.ExitCode})`, {
        code: state.OOMKilled ? "inference_oom" : "inference_process_exited", exitCode: 12,
      });
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
      } catch (error) {
        if (error instanceof HitchError) throw error;
        last = (error as Error).message;
      }
      await delay(500);
    }
    throw new HitchError(`SGLang startup timed out: ${last}`, { code: "inference_start_timeout", exitCode: 12 });
  }

  private async probeResponses(baseUrl: string, token: string, wireModel: string): Promise<void> {
    for (const stream of [false, true]) {
      const response = await this.request(`${baseUrl}/v1/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        // These pinned versions reserve two tokens. A budget of one becomes -1.
        body: JSON.stringify({ model: wireModel, input: "Reply with one word.", max_output_tokens: 8, temperature: 0, store: false, stream }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new HitchError(`SGLang Responses probe returned HTTP ${response.status}`, {
        code: "inference_protocol_unsupported", exitCode: 12,
      });
      let body: { status?: unknown };
      if (stream) {
        if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new HitchError("SGLang Responses streaming probe did not return SSE", { code: "inference_protocol_unsupported", exitCode: 12 });
        const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
          .map((line) => JSON.parse(line.slice(6)) as { type?: string; response?: { status?: unknown } });
        body = events.findLast((event) => event.type === "response.completed" || event.type === "response.incomplete")?.response ?? {};
      } else body = await response.json() as { status?: unknown };
      if (body.status !== "completed" && body.status !== "incomplete") throw new HitchError("SGLang Responses probe lacks a successful terminal payload", { code: "inference_protocol_unsupported", exitCode: 12 });
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
    "run", "--detach", "--name", input.name,
    "--label", "io.hitch.local-inference=true",
    "--label", `io.hitch.service-id=${input.input.serviceId}`,
    "--label", `io.hitch.root-id=${hitchRootId(input.input.root)}`,
    "--label", `io.hitch.inference-id=${lock.inference_id}`,
    "--network", input.network,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "4096",
    "--memory", String(lock.resources.memory_bytes), "--cpus", String(lock.resources.cpu_millis / 1_000),
    "--shm-size", "2g", "--tmpfs", "/tmp:rw,noexec,nosuid,size=2g",
    "--mount", `type=bind,src=${input.modelDirectory},dst=/model,readonly`,
    "--mount", `type=bind,src=${input.cacheDirectory},dst=/root/.cache`,
    "--publish", `127.0.0.1:${input.port}:30000`,
    ...(backend.backend === "cuda" ? ["--gpus", `device=${backend.device_constraint || "0"}`] : []),
    ...(backend.backend === "cpu" ? ["--env", "SGLANG_USE_CPU_ENGINE=1", "--env", `OMP_NUM_THREADS=${backend.cpu_threads}`, "--env", `SGLANG_CPU_OMP_THREADS=${backend.cpu_threads}`] : []),
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

interface ContainerInspection {
  Image: string;
  State: { Running: boolean; OOMKilled: boolean; ExitCode: number };
  Config?: { Labels?: Record<string, string> };
}
