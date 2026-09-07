import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InferenceLockV1, LocalModelManifestV1 } from "../src/domain/index.js";
import { HitchError, delay, sha256JSON, statePaths } from "../src/foundation/index.js";
import { buildInferenceLock, doctorLocalInference, resolveLocalInferenceDevice, runtimeCatalogEntry, SGLangServiceSupervisor } from "../src/inference/index.js";
import type { SGLangLauncher, InferenceDoctorOptions } from "../src/inference/index.js";
import { LocalInferenceManager, ResourceLedger } from "../src/control-plane/index.js";
import { reserveInferenceDevice, releaseInferenceDevice } from "../src/inference/device-reservation.js";
import { validateRuntimeObservation } from "../src/inference/observation.js";

const model: LocalModelManifestV1 = {
  schema_version: "1", model_id: `sha256:${"1".repeat(64)}`, format: "hf-safetensors",
  files: [{ path: "model.safetensors", size: 10, sha256: `sha256:${"2".repeat(64)}` }],
  architecture: "Qwen2ForCausalLM", model_type: "qwen2", dtype: "bfloat16", quantization: null, context_tokens: 8192,
  tokenizer_digest: `sha256:${"3".repeat(64)}`, template_digest: null,
  source: { kind: "local-directory", label: "fixture", license: null }, created_at: "2026-09-07T00:00:00.000Z",
};
const runtime = runtimeCatalogEntry("cpu");
const built = buildInferenceLock(model, runtime, { backend: "cpu", profile: "baseline", cpuThreads: 1 });
const lock: InferenceLockV1 = { ...built, execution: { ...built.execution, idle_ttl_ms: 30 } };
const info = {
  version: runtime.sglang_version, device: "cpu", dtype: "bfloat16", kv_cache_dtype: "bfloat16",
  attention_backend: "intel_amx", sampling_backend: "pytorch", context_length: 8192,
  max_total_num_tokens: lock.execution.max_total_tokens, max_running_requests: 1,
  tp_size: 1, dp_size: 1, pp_size: 1, disable_radix_cache: true, disable_overlap_schedule: true,
};
const observation = validateRuntimeObservation(info, `sha256:${"a".repeat(64)}`, null, lock, runtime);
const selection = { model: "local/coder", device: "cpu" as const, profile: "baseline" as const, offline: true };
const runId = `run_${"a".repeat(32)}`;
function input() { return { lock, model, runtime, isolationKey: sha256JSON("fixture"), ownerId: runId }; }
async function temporary(t: { after(fn: () => Promise<void>): unknown }) {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-inference-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function doctorOptions(gpus: string, endpoint = "unix:///var/run/docker.sock"): InferenceDoctorOptions {
  return { platform: "linux", architecture: "x64", env: {}, readCpuInfo: async () => "amx_tile amx_int8 amx_bf16",
    run: async (executable, args) => ({ stdout: executable === "nvidia-smi" ? gpus : args[0] === "info"
      ? JSON.stringify({ OSType: "linux", Architecture: "x86_64", ServerVersion: "27" }) : JSON.stringify(endpoint), stderr: "" }) };
}

test("doctor checks all GPUs, driver/SM/free memory, UUID constraints and local Docker topology", async () => {
  const options = doctorOptions("GPU-old, Old GPU, 80000, 80000, 570.1, 9.0\nGPU-full, H100, 80000, 100, 580.1, 9.0\nGPU-ok, H100, 80000, 60000, 580.1, 9.0");
  const selected = await resolveLocalInferenceDevice("auto", { ...options, requiredMemoryMiB: 4000 });
  assert.equal(selected.doctor.gpu?.uuid, "GPU-ok");
  const fallback = await resolveLocalInferenceDevice("auto", { ...options, requiredMemoryMiB: 90000 });
  assert.equal(fallback.backend, "cpu");
  assert.equal((await doctorLocalInference("cuda", { ...options, deviceConstraint: "GPU-missing" })).ready, false);
  assert.equal((await doctorLocalInference("cuda", doctorOptions("GPU-old, Old GPU, 80000, 80000, 580.1, 7.0"))).ready, false);
  assert.equal((await doctorLocalInference("cpu", doctorOptions("", "ssh://remote"))).ready, false);
});

test("runtime observation rejects silently adjusted kernels, context, memory pool and GPU identity", () => {
  assert.throws(() => validateRuntimeObservation({ ...info, attention_backend: "triton" }, observation.container_image_id, null, lock, runtime), /attention_backend/);
  assert.throws(() => validateRuntimeObservation({ ...info, context_length: 4096 }, observation.container_image_id, null, lock, runtime), /context_length/);
  assert.throws(() => validateRuntimeObservation({ ...info, max_total_num_tokens: 4000 }, observation.container_image_id, null, lock, runtime), /token pool/);
  assert.throws(() => validateRuntimeObservation(info, observation.container_image_id, "GPU-unexpected", lock, runtime), /unexpectedly exposes/);
  const scrubbed = validateRuntimeObservation({ ...info, api_key: "private", admin_api_key: "secret" }, observation.container_image_id, null, lock, runtime);
  assert.equal(JSON.stringify(scrubbed).includes("private"), false);
  assert.equal(JSON.stringify(scrubbed).includes("secret"), false);
  const fp16 = buildInferenceLock({ ...model, dtype: "float16" }, runtimeCatalogEntry("cuda"), { backend: "cuda", profile: "baseline" });
  assert.equal(fp16.execution.kv_cache_dtype, "auto", "float16 is not an SGLang KV CLI choice");
});

test("physical GPU reservations exclude other roots and survive until their owner confirms cleanup", async (t) => {
  const directory = await temporary(t);
  const results = await Promise.allSettled([reserveInferenceDevice(directory, "/root/a", "service-a", "GPU-1"), reserveInferenceDevice(directory, "/root/b", "service-b", "GPU-1")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const first = results[0]?.status === "fulfilled";
  const owner = first ? "/root/a" : "/root/b", service = first ? "service-a" : "service-b";
  await releaseInferenceDevice(directory, "/root/other", service);
  await assert.rejects(reserveInferenceDevice(directory, "/root/other", "other", "GPU-1"), /reserved/);
  await releaseInferenceDevice(directory, owner, service);
  await reserveInferenceDevice(directory, "/root/other", "other", "GPU-1");
});

test("supervisor detects OOM after ready, invalidates the service, and starts a new epoch", async (t) => {
  const root = await temporary(t);
  let failed = false, stops = 0, starts = 0;
  const supervisor = new SGLangServiceSupervisor({ root, healthIntervalMs: 5, launcher: { start: async () => {
    starts += 1;
    return { container_id: "a".repeat(64), base_url: "http://127.0.0.1:30000", wire_model: "wire", engine_token: "secret", admin_token: "admin", observation,
      checkHealth: async () => { if (failed) throw new HitchError("OOM", { code: "inference_oom" }); }, stop: async () => { stops += 1; } };
  } } });
  t.after(() => supervisor.close());
  const terminal: boolean[] = [];
  let observed!: () => void;
  const failure = new Promise<void>((resolve) => { observed = resolve; });
  supervisor.subscribeTerminal(async (_record, released) => { terminal.push(released); if (released) observed(); });
  const first = await supervisor.acquire(input());
  failed = true;
  await Promise.race([failure, delay(2000).then(() => { throw new Error("health monitor did not detect OOM"); })]);
  assert.deepEqual(terminal, [false, true]);
  assert.equal((await supervisor.list())[0]?.error?.code, "inference_oom");
  assert.equal(stops, 1);
  failed = false;
  const second = await supervisor.acquire(input());
  assert.equal(starts, 2);
  assert.ok(second.epoch > first.epoch);
  await first.release();
  await second.release();
});

test("unconfirmed stop keeps failed service reserved and rejects reuse", async (t) => {
  const root = await temporary(t);
  let failed = false, canStop = false;
  const supervisor = new SGLangServiceSupervisor({ root, launcher: { start: async () => ({
    container_id: "a".repeat(64), base_url: "http://127.0.0.1:30000", wire_model: "wire", engine_token: "secret", admin_token: "admin",
    checkHealth: async () => { if (failed) throw new Error("unreachable"); },
    stop: async () => { if (!canStop) throw new Error("Docker unreachable"); },
  }) } });
  t.after(() => { canStop = true; return supervisor.close(); });
  const terminal: boolean[] = [];
  supervisor.subscribeTerminal(async (_record, released) => { terminal.push(released); });
  await supervisor.acquire(input());
  failed = true;
  await assert.rejects(supervisor.acquire(input()), /not ready/);
  assert.deepEqual(terminal, [false]);
  assert.equal((await supervisor.list())[0]?.state, "failed");
});

test("one cancelled startup waiter does not cancel another owner, and close waits for startup", async (t) => {
  const root = await temporary(t);
  let resolveStart!: () => void, stops = 0;
  const barrier = new Promise<void>((resolve) => { resolveStart = resolve; });
  const supervisor = new SGLangServiceSupervisor({ root, launcher: { start: async () => {
    await barrier;
    return { container_id: "a".repeat(64), base_url: "http://127.0.0.1:30000", wire_model: "wire", engine_token: "secret", admin_token: "admin", stop: async () => { stops += 1; } };
  } } });
  const controller = new AbortController();
  const cancelled = supervisor.acquire({ ...input(), signal: controller.signal });
  const second = supervisor.acquire({ ...input(), ownerId: "second" });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  resolveStart();
  const lease = await second;
  assert.equal(stops, 0);
  await lease.release();
  await Promise.all([supervisor.close(), supervisor.close()]);
  assert.equal(stops, 1);
});

test("manager prepare loads through the shared supervisor, records observations, and returns all temporary resources", async (t) => {
  const root = await temporary(t);
  let starts = 0, stops = 0;
  const launcher: SGLangLauncher = { start: async () => {
    starts += 1;
    return { container_id: "a".repeat(64), base_url: "http://127.0.0.1:30000", wire_model: "wire", engine_token: "secret", admin_token: "admin", observation, stop: async () => { stops += 1; } };
  } };
  const resources = new ResourceLedger({ cpu_millis: 4000, memory_bytes: 8 * 1024 ** 3, container_slots: 4, build_slots: 1, ephemeral_disk_bytes: 8 * 1024 ** 3 });
  const manager = new LocalInferenceManager({ root, resources, supervisor: new SGLangServiceSupervisor({ root, launcher }), preflight: async () => ({ model, runtime, lock, runtime_cache_hit: true }) });
  t.after(() => manager.close());
  const prepared = await manager.prepare(selection);
  assert.equal(prepared.observation?.version, runtime.sglang_version);
  assert.equal(starts, 1); assert.equal(stops, 1);
  assert.equal(resources.snapshot().allocations.length, 0);
  const stored = JSON.parse(await readFile(path.join(statePaths(root).inferenceLocks, lock.inference_id.slice(7), "validation.json"), "utf8"));
  assert.equal(stored.observation.max_total_num_tokens, info.max_total_num_tokens);
  const lease = await manager.acquire({ run_id: runId, harness_ref: "model-call", selection, cache_scope_owner: runId });
  await manager.prepare(selection);
  assert.equal(starts, 2, "prepare reuses an already owned service");
  assert.equal(stops, 1, "prepare must not stop the other owner's service");
  await lease.release();
});

test("ambiguous startup retains admission resources and blocks repeated starts", async (t) => {
  const root = await temporary(t);
  let starts = 0;
  const supervisor = new SGLangServiceSupervisor({ root, launcher: { start: async () => {
    starts += 1;
    throw new HitchError("Docker cleanup unconfirmed", { code: "inference_recovery_ambiguous" });
  } } });
  const resources = new ResourceLedger({ cpu_millis: 4000, memory_bytes: 8 * 1024 ** 3, container_slots: 4, build_slots: 1, ephemeral_disk_bytes: 8 * 1024 ** 3 });
  const manager = new LocalInferenceManager({ root, resources, supervisor, preflight: async () => ({ model, runtime, lock, runtime_cache_hit: true }) });
  t.after(() => manager.close());
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(manager.acquire({ run_id: runId, harness_ref: "model-call", selection, cache_scope_owner: runId }),
      (error: unknown) => (error as { code: string }).code === "inference_recovery_ambiguous");
    assert.equal(resources.snapshot().allocations.length, 1);
  }
  assert.equal(starts, 1);
});

test("manager closure during preflight does not allocate resources or start an engine", async (t) => {
  const root = await temporary(t);
  let complete!: () => void;
  const barrier = new Promise<void>((resolve) => { complete = resolve; });
  let starts = 0;
  const resources = new ResourceLedger({ cpu_millis: 4000, memory_bytes: 8 * 1024 ** 3, container_slots: 4, build_slots: 1, ephemeral_disk_bytes: 8 * 1024 ** 3 });
  const manager = new LocalInferenceManager({ root, resources, supervisor: new SGLangServiceSupervisor({ root, launcher: { start: async () => { starts += 1; throw new Error("should not start"); } } }),
    preflight: async () => { await barrier; return { model, runtime, lock, runtime_cache_hit: true }; } });
  const acquisition = manager.acquire({ run_id: runId, harness_ref: "model-call", selection, cache_scope_owner: runId });
  await manager.close(); complete();
  await assert.rejects(acquisition, /closed/);
  assert.equal(starts, 0);
  assert.equal(resources.snapshot().allocations.length, 0);
});
