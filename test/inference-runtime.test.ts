import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult } from "../src/foundation/index.js";
import { HitchError, sha256JSON } from "../src/foundation/index.js";
import {
  addLocalModel,
  buildInferenceLock,
  DockerSGLangLauncher,
  doctorLocalInference,
  listRuntimeCatalog,
  parseInferenceRuntimeManifest,
  prepareInferenceRuntime,
  resolveLocalInferenceDevice,
  runtimeCatalogEntry,
  validateInferenceLockShape,
} from "../src/inference/index.js";
import { forceRemove, safetensorsFixture } from "../test-support/helpers.js";

test("runtime catalog pins immutable official SGLang images and self-validating identities", () => {
  const catalog = listRuntimeCatalog();
  assert.deepEqual(catalog.map((entry) => entry.backend), ["cpu", "cuda"]);
  for (const runtime of catalog) {
    assert.equal(runtime.package.kind, "oci");
    if (runtime.package.kind !== "oci") continue;
    assert.match(runtime.package.image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(runtime.package.image.endsWith(runtime.package.image_digest), true);
    assert.deepEqual(parseInferenceRuntimeManifest(runtime), runtime);
  }
});

test("device doctor fails closed and auto prefers a certified CUDA device", async () => {
  const run = async (executable: string, args: string[]): Promise<CommandResult> => {
    if (executable === "docker") return { stdout: "27.4.0\n", stderr: "" };
    if (executable === "nvidia-smi") return { stdout: "GPU-123, NVIDIA H100, 81920, 580.65\n", stderr: "" };
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`);
  };
  const options = {
    platform: "linux" as const,
    architecture: "x64",
    run,
    readCpuInfo: async () => "flags: amx_tile amx_int8 amx_bf16",
  };
  const cpu = await doctorLocalInference("cpu", options);
  assert.equal(cpu.ready, true);
  const selected = await resolveLocalInferenceDevice("auto", options);
  assert.equal(selected.backend, "cuda");
  assert.equal(selected.doctor.gpu?.uuid, "GPU-123");

  const unsupported = await doctorLocalInference("cpu", { ...options, platform: "darwin" });
  assert.equal(unsupported.ready, false);
  await assert.rejects(resolveLocalInferenceDevice("cpu", { ...options, platform: "darwin" }),
    (error: unknown) => (error as { code?: string }).code === "inference_device_unsupported");
});

test("runtime preparation pulls once, verifies the digest, persists, and honors offline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-runtime-"));
  const offlineRoot = await mkdtemp(path.join(tmpdir(), "hitch-runtime-offline-"));
  t.after(() => Promise.all([root, offlineRoot].map((directory) => rm(directory, { recursive: true, force: true }))));
  const expected = runtimeCatalogEntry("cuda");
  assert.equal(expected.package.kind, "oci");
  let pulled = false;
  let pullCount = 0;
  const run = async (_executable: string, args: string[]): Promise<CommandResult> => {
    if (args[0] === "pull") {
      pulled = true;
      pullCount += 1;
      assert.deepEqual(args, ["pull", "--platform", "linux/amd64", expected.package.kind === "oci" ? expected.package.image : ""]);
      return { stdout: "pulled\n", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      if (!pulled) throw new HitchError("missing", { code: "inference_runtime_unavailable", exitCode: 3 });
      return {
        stdout: JSON.stringify({
          Id: `sha256:${"1".repeat(64)}`,
          RepoDigests: [`docker.io/lmsysorg/sglang@${expected.package.kind === "oci" ? expected.package.image_digest : ""}`],
          Os: "linux",
          Architecture: "amd64",
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const first = await prepareInferenceRuntime({ root, backend: "cuda", run });
  assert.equal(first.cache_hit, false);
  const second = await prepareInferenceRuntime({ root, backend: "cuda", run });
  assert.equal(second.cache_hit, true);
  assert.equal(pullCount, 1);

  pulled = false;
  await assert.rejects(prepareInferenceRuntime({ root: offlineRoot, backend: "cuda", offline: true, run }),
    (error: unknown) => (error as { code?: string }).code === "inference_runtime_unavailable");
});

test("inference locks are stable and bind model, runtime, backend, and profile", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-lock-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const source = path.join(temporary, "model");
  await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({
    architectures: ["Qwen2ForCausalLM"], model_type: "qwen2", torch_dtype: "bfloat16", max_position_embeddings: 32768,
  }));
  await writeFile(path.join(source, "tokenizer.json"), "{}\n");
  await writeFile(path.join(source, "tokenizer_config.json"), JSON.stringify({ chat_template: "{{ messages }}" }));
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "qwen" });
  const runtime = runtimeCatalogEntry("cuda");
  const first = buildInferenceLock(model, runtime, { backend: "cuda", profile: "baseline", deviceConstraint: "GPU-1" });
  const same = buildInferenceLock(model, runtime, { backend: "cuda", profile: "baseline", deviceConstraint: "GPU-1" });
  const throughput = buildInferenceLock(model, runtime, { backend: "cuda", profile: "throughput", deviceConstraint: "GPU-1" });
  assert.equal(first.inference_id, same.inference_id);
  assert.notEqual(first.inference_id, throughput.inference_id);
  assert.equal(first.protocol.tool_calls, true);
  assert.deepEqual(validateInferenceLockShape(first), first);
  assert.throws(() => validateInferenceLockShape({ ...first, generation: { ...first.generation, temperature: 1 } }), /identity mismatch/);
  assert.throws(() => validateInferenceLockShape({ ...first, generation: { ...first.generation, hidden_default: true } }), /unknown field/);
  const profileMismatch = { ...first, execution: { ...first.execution, max_running_requests: 2 } };
  const { inference_id: _profileId, ...profileIdentity } = profileMismatch;
  assert.throws(() => validateInferenceLockShape({ ...profileMismatch, inference_id: sha256JSON(profileIdentity) }), /does not match its profile/);
  const resourceMismatch = { ...first, resources: { ...first.resources, gpu_count: 0 } };
  const { inference_id: _resourceId, ...resourceIdentity } = resourceMismatch;
  assert.throws(() => validateInferenceLockShape({ ...resourceMismatch, inference_id: sha256JSON(resourceIdentity) }), /resource\/backend/);
});

test("SGLang launcher compiles a locked-down digest-pinned CPU command and probes Responses", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-sglang-launcher-"));
  t.after(() => forceRemove(temporary));
  const root = path.join(temporary, "state");
  const source = path.join(temporary, "model");
  await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ model_type: "qwen2", torch_dtype: "bfloat16" }));
  await writeFile(path.join(source, "tokenizer.json"), "{}\n");
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "coder" });
  const runtime = runtimeCatalogEntry("cpu");
  const lock = buildInferenceLock(model, runtime, { backend: "cpu", profile: "baseline", cpuThreads: 2 });
  const commands: string[][] = [];
  const launcher = new DockerSGLangLauncher({
    run: async (_executable, args) => {
      commands.push(args);
      if (args[0] === "run") return { stdout: `${"a".repeat(64)}\n`, stderr: "" };
      return { stdout: "{}\n", stderr: "" };
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("ok");
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: `hitch-${model.model_id.slice(7, 23)}` }] });
      assert.equal(url.endsWith("/v1/responses"), true);
      assert.equal((init?.headers as Record<string, string>).Authorization?.startsWith("Bearer "), true);
      return Response.json({ status: "completed", output: [] });
    },
  });
  const launched = await launcher.start({ root, serviceId: `inference_${"b".repeat(32)}`, lock, model, runtime });
  const dockerRun = commands.find((args) => args[0] === "run")!;
  assert.equal(dockerRun.includes(runtime.package.kind === "oci" ? runtime.package.image : ""), true);
  assert.deepEqual(dockerRun.slice(dockerRun.indexOf("--random-seed"), dockerRun.indexOf("--random-seed") + 2), ["--random-seed", "0"]);
  assert.equal(dockerRun.includes("--read-only"), true);
  assert.equal(dockerRun.includes("no-new-privileges"), true);
  assert.equal(dockerRun.includes("SGLANG_USE_CPU_ENGINE=1"), true);
  assert.equal(dockerRun.includes("--device"), true);
  assert.equal(dockerRun.includes("--trust-remote-code"), false);
  await launched.stop();
});
