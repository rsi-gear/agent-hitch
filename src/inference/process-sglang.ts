import type { InferenceRuntimeObservationV2, InferenceServiceHandleV2, InferenceServiceRecordV1, PythonRuntimeObservationV2 } from "../domain/index.js";
import { HitchError, delay, hitchRootId, sha256JSON } from "../foundation/index.js";
import { parseInferenceRuntimeManifest, parseInferenceServiceHandle, parseInferenceServiceRecord, parseLocalModelManifest } from "./manifest.js";
import { validateInferenceLockShape } from "./lock.js";
import { validateProcessRuntimeObservation } from "./observation.js";
import { probeSGLangProtocol } from "./protocol-probe.js";
import type { InferenceNodeClient, InferenceNodeOwner } from "./node-client.js";
import type { SGLangAttachInput, SGLangLaunchedService, SGLangLauncher, SGLangLaunchInput } from "./sglang.js";

type ProcessHandle = Extract<InferenceServiceHandleV2, { kind: "process" }>;
interface NodeStatus {
  schemaVersion: 2;
  state: "admitting" | "starting" | "ready" | "stopping" | "stopped" | "failed";
  resourcesReleased: boolean;
  inferenceId?: string;
  inputDigest?: string;
  handle?: ProcessHandle;
  access?: { port: number; engineToken: string; adminToken: string; wireModel: string };
  runtime?: { pythonVersion: string; packagesDigest: PythonRuntimeObservationV2["packages_digest"]; outerImageDigest: PythonRuntimeObservationV2["outer_image_digest"] };
  serverInfo?: unknown;
  gpuUuid?: string | null;
}

export class ProcessSGLangLauncher implements SGLangLauncher {
  constructor(readonly client: InferenceNodeClient, private readonly request: typeof fetch = fetch) {}

  private status(value: unknown, owner: InferenceNodeOwner, expected?: ProcessHandle): NodeStatus {
    const status = value as NodeStatus | null;
    if (!status || status.schemaVersion !== 2 || typeof status.resourcesReleased !== "boolean"
      || !["admitting", "starting", "ready", "stopping", "stopped", "failed"].includes(status.state)) throw new TypeError("invalid model-node service status");
    if (owner.inferenceId && status.inferenceId !== owner.inferenceId) throw new HitchError("model-node service inference lock changed", { code: "inference_runtime_mismatch", exitCode: 12 });
    if (status.handle) {
      const handle = parseInferenceServiceHandle(status.handle);
      if (handle.kind !== "process" || handle.service_id !== owner.serviceId || handle.node_id !== this.client.node.nodeId
        || handle.generation !== this.client.node.generation || (expected && sha256JSON(handle) !== sha256JSON(expected))) {
        throw new HitchError("model-node process identity changed", { code: "inference_runtime_mismatch", exitCode: 12 });
      }
    } else if (expected || status.state === "ready") throw new TypeError("model-node process handle is missing");
    return status;
  }

  async start(input: SGLangLaunchInput): Promise<SGLangLaunchedService> {
    validateInput(input);
    const owner = { serviceId: input.serviceId, ownerId: hitchRootId(input.root), inferenceId: input.lock.inference_id };
    await this.client.prepare(input);
    let handle: ProcessHandle | undefined;
    try {
      let status = this.status(await this.client.start(input), owner);
      const deadline = Date.now() + input.lock.execution.startup_timeout_ms;
      while (true) {
        if (status.handle && !handle) { handle = status.handle; await input.onServiceCreated?.(handle); }
        if (input.signal?.aborted) throw new HitchError("SGLang startup cancelled", { code: "cancelled", exitCode: 9 });
        if (status.state === "ready") break;
        if (status.state === "failed" || status.state === "stopped" || status.state === "stopping") throw new HitchError("model-node process did not become ready", { code: "inference_process_exited", exitCode: 12 });
        if (Date.now() >= deadline) throw new HitchError("model-node startup timed out", { code: "inference_start_timeout", exitCode: 12 });
        await delay(200); status = this.status(await this.client.inspect(owner), owner, handle);
      }
      if (!handle) throw new TypeError("ready model-node process lacks its handle");
      return await this.connect(input, owner, status, handle);
    } catch (error) {
      try { await this.stopConfirmed(owner, handle); } catch {
        throw new HitchError("model-node startup cleanup is unconfirmed; device ownership retained", { code: "inference_recovery_ambiguous", exitCode: 12, cause: error });
      }
      throw error;
    }
  }

  async attach(input: SGLangAttachInput): Promise<SGLangLaunchedService> {
    const { signal, ...evidence } = input;
    input = { ...structuredClone(evidence), ...(signal ? { signal } : {}) };
    validateInput(input);
    const record = parseInferenceServiceRecord(input.record);
    const handle = record.service_handle;
    if (!this.client.attach || !input.observation || input.observation.schema_version !== "2"
      || record.state !== "ready" || record.container_id || handle?.kind !== "process"
      || record.inference_id !== input.lock.inference_id
      || sha256JSON(record.model_node ?? null) !== sha256JSON(input.lock.model_node ?? null)
      || input.lock.model_node && (input.lock.model_node.node_id !== this.client.node.nodeId || input.lock.model_node.generation !== this.client.node.generation)
      || handle.service_id !== record.service_id || handle.node_id !== this.client.node.nodeId || handle.generation !== this.client.node.generation) {
      throw new HitchError("service attachment requires the original ready process and model node", { code: "inference_recovery_ambiguous", exitCode: 12 });
    }
    input.signal?.throwIfAborted();
    const owner = { serviceId: record.service_id, ownerId: hitchRootId(input.root), inferenceId: input.lock.inference_id };
    // Failure must never enter startup cleanup: another live owner may still be
    // generating. No prepare, start, token probe, cache flush or stop is allowed.
    const status = this.status(await this.client.attach(input), owner, handle);
    if (status.inputDigest !== sha256JSON({ serviceId: owner.serviceId, ownerId: owner.ownerId,
      model: input.model, runtime: input.runtime, lock: input.lock })) throw new TypeError("attachment start request digest changed");
    return this.connect({ ...input, serviceId: record.service_id }, owner, status, handle, { observation: input.observation });
  }

  private async connect(input: SGLangLaunchInput, owner: InferenceNodeOwner, status: NodeStatus, handle: ProcessHandle,
    recovery?: { observation: InferenceRuntimeObservationV2 }): Promise<SGLangLaunchedService> {
    const access = status.access; const actual = status.runtime;
    if (status.state !== "ready" || status.resourcesReleased || !access || !actual
      || !/^[a-f0-9]{64}$/.test(access.engineToken) || !/^[a-f0-9]{64}$/.test(access.adminToken)
      || access.wireModel !== `hitch-${input.model.model_id.slice(7, 23)}`) throw new TypeError("ready model-node process lacks its private connection/runtime");
    const baseUrl = await this.client.route(input.root, access.port);
    const headers = { Authorization: `Bearer ${access.engineToken}` };
    const models = await this.request(`${baseUrl}/v1/models`, { headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const catalogue = models.ok ? await models.json() as { data?: Array<{ id?: unknown }> } : null;
    if (!catalogue?.data?.some(model => model.id === access.wireModel)) throw new HitchError("model-node route serves another model", { code: "inference_runtime_mismatch", exitCode: 12 });
    const observed: PythonRuntimeObservationV2 = { kind: "python-env", node_id: this.client.node.nodeId, generation: this.client.node.generation,
      environment_digest: sha256JSON(actual), python_version: actual.pythonVersion, packages_digest: actual.packagesDigest, outer_image_digest: actual.outerImageDigest };
    const currentObservation = validateProcessRuntimeObservation(status.serverInfo, observed, status.gpuUuid ?? null, input.lock, input.runtime,
      { node_id: this.client.node.nodeId, generation: this.client.node.generation });
    let observation = currentObservation;
    if (recovery) {
      const prior = recovery.observation;
      if (!prior || typeof prior.observed_at !== "string" || !Number.isFinite(Date.parse(prior.observed_at)) || Date.parse(prior.observed_at) > Date.now()
        || sha256JSON({ ...currentObservation, observed_at: prior.observed_at }) !== sha256JSON(prior)) {
        throw new HitchError("live process differs from its original protocol/runtime evidence", { code: "inference_runtime_mismatch", exitCode: 12 });
      }
      // Retain the original probe timestamp; attachment performs no inference.
      observation = structuredClone(prior);
    } else {
      await probeSGLangProtocol(this.request, baseUrl, access.engineToken, access.wireModel, input.lock.protocol.api);
      const cleared = await this.request(`${baseUrl}/flush_cache`, { headers: { Authorization: `Bearer ${access.adminToken}` }, signal: AbortSignal.timeout(10_000) });
      if (!cleared.ok) throw new HitchError("model-node warmup cache could not be cleared", { code: "inference_runtime_mismatch", exitCode: 12 });
    }
    input.signal?.throwIfAborted();
    const pinnedHandle = handle;
    let stopping: Promise<void> | undefined;
    return { service_handle: handle, base_url: baseUrl, wire_model: access.wireModel, engine_token: access.engineToken, admin_token: access.adminToken, observation,
      checkHealth: async () => {
        const current = this.status(await this.client.inspect(owner), owner, pinnedHandle);
        if (current.state !== "ready" || current.resourcesReleased) throw new HitchError("model-node process is no longer ready", { code: "inference_process_exited", exitCode: 12 });
        await this.client.route(input.root, access.port);
        const health = await this.request(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        if (!health.ok) throw new HitchError("model-node route is unavailable", { code: "inference_route_unavailable", exitCode: 12 });
      },
      stop: () => stopping ??= this.stopConfirmed(owner, pinnedHandle).finally(() => { stopping = undefined; }),
    };
  }

  private async stopConfirmed(owner: InferenceNodeOwner, handle?: ProcessHandle): Promise<void> {
    const stopped = this.status(await this.client.stop(owner), owner, handle);
    if (!stopped.resourcesReleased || !["stopped", "failed"].includes(stopped.state)) throw new HitchError("model-node process or GPU remains owned", { code: "inference_recovery_ambiguous", exitCode: 12 });
  }

  async stopOrphan(root: string, record: InferenceServiceRecordV1): Promise<"stopped" | "missing" | "ambiguous"> {
    if (record.container_id || record.service_handle?.kind === "docker") return "ambiguous";
    const handle = record.service_handle;
    if (handle && (handle.node_id !== this.client.node.nodeId || handle.generation !== this.client.node.generation)) return "ambiguous";
    try { await this.stopConfirmed({ serviceId: record.service_id, ownerId: hitchRootId(root), inferenceId: record.inference_id }, handle); return "stopped"; }
    catch { return "ambiguous"; }
  }
}

function validateInput(input: Pick<SGLangLaunchInput, "lock" | "model" | "runtime">): void {
  parseLocalModelManifest(input.model); parseInferenceRuntimeManifest(input.runtime); validateInferenceLockShape(input.lock);
  if (input.runtime.schema_version !== "2" || input.runtime.package.kind !== "python-env"
    || input.lock.runtime_id !== input.runtime.runtime_id || input.lock.model_id !== input.model.model_id) throw new TypeError("process launcher requires a locked v2 Python runtime/model");
}
