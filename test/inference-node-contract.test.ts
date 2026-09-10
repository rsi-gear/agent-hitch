import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { InferenceRuntimeManifestV1, PythonRuntimeObservationV2, InferenceLockV1 } from "../src/domain/index.js";
import { sha256JSON } from "../src/foundation/index.js";
import { inferenceRuntimeIdentity, parseInferenceRuntimeManifest, parseInferenceServiceHandle, parseInferenceServiceRecord, runtimeCatalogEntry } from "../src/inference/index.js";
import { DockerSGLangLauncher } from "../src/inference/sglang.js";
import { validateProcessRuntimeObservation } from "../src/inference/observation.js";

const hash = sha256JSON("fixture");
const processHandle = { schema_version: "2" as const, kind: "process" as const, node_id: "gpu-node", generation: "boot-1",
  service_id: `inference_${"a".repeat(32)}`, process: { pid: 123, created_at: 1_788_800_000 } };
const pythonRuntime = (): InferenceRuntimeManifestV1 => {
  const body: Omit<InferenceRuntimeManifestV1, "runtime_id"> = {
    schema_version: "2", engine: "sglang", sglang_version: "0.5.16", sglang_commit: "a".repeat(40), backend: "cuda",
    package: { kind: "python-env", environment_digest: hash, python_version: "3.12.1", packages_digest: hash }, compatibility_profile: "fixture-only",
  };
  return { ...body, runtime_id: inferenceRuntimeIdentity(body) };
};

async function validator(name: string) {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: true }).compile(JSON.parse(await readFile(`docs/schemas/${name}.schema.json`, "utf8")));
}

test("Python CUDA runtime has a v2 identity while legacy OCI manifests round-trip unchanged", async () => {
  const runtime = pythonRuntime(); assert.deepEqual(parseInferenceRuntimeManifest(runtime), runtime);
  const legacy = runtimeCatalogEntry("cuda"); assert.deepEqual(parseInferenceRuntimeManifest(legacy), legacy);
  assert.throws(() => parseInferenceRuntimeManifest({ ...runtime, schema_version: "1" }));
  assert.throws(() => parseInferenceRuntimeManifest({ ...runtime, package: { ...runtime.package, python_version: "3.12.2" } }), /identity mismatch/);
  const validate = await validator("inference-runtime-manifest");
  assert.equal(validate(runtime), true, JSON.stringify(validate.errors)); assert.equal(validate(legacy), true);
  assert.equal(validate({ ...runtime, schema_version: "1" }), false);
});

test("process handles retain node, generation and PID creation time without container identity", async () => {
  assert.deepEqual(parseInferenceServiceHandle(processHandle), processHandle);
  const record = { schema_version: "1", service_id: processHandle.service_id, inference_id: hash, isolation_key: hash,
    state: "ready", epoch: 1, owner_id: "controller", lease_owner_ids: [], backend: "cuda", service_handle: processHandle,
    base_url: "http://127.0.0.1:32000", started_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" };
  assert.deepEqual(parseInferenceServiceRecord(record), record);
  for (const change of [{ container_id: "f".repeat(64) }, { pid: 123 }, { service_handle: { ...processHandle, service_id: `inference_${"b".repeat(32)}` } }]) {
    assert.throws(() => parseInferenceServiceRecord({ ...record, ...change }), /process service handle/);
  }
  assert.throws(() => parseInferenceServiceHandle({ ...processHandle, process: { pid: 123 } }), /process handle/);
  const validate = await validator("inference-service-record");
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...record, container_id: "f".repeat(64) }), false);
});

test("Docker recovery cannot claim that a remote process released its GPU", async () => {
  let dockerCalls = 0;
  const launcher = new DockerSGLangLauncher({ run: async () => { dockerCalls++; throw new Error("must not invoke Docker"); } });
  const result = await launcher.stopOrphan("/unused", { service_id: processHandle.service_id, inference_id: hash, service_handle: processHandle });
  assert.equal(result, "ambiguous"); assert.equal(dockerCalls, 0);
});

test("process runtime observation requires the actual node environment and omits OCI IDs and credentials", async () => {
  const runtime = pythonRuntime();
  const lock = { execution: { platform: { backend: "cuda", overlap_schedule: false, device_constraint: "GPU-123", mem_fraction_static: 0.5 },
    dtype: "bfloat16", kv_cache_dtype: "auto", attention_backend: "flashinfer", sampling_backend: "pytorch",
    context_tokens_per_request: 128, max_running_requests: 1, max_total_tokens: 128, prefix_cache: { mode: "disabled" } },
    protocol: { api: "chat-completions" } } as InferenceLockV1;
  const info = { version: "0.5.16", device: "cuda", dtype: "bfloat16", kv_cache_dtype: "auto", attention_backend: "flashinfer",
    sampling_backend: "pytorch", context_length: 128, max_running_requests: 1, max_total_num_tokens: 128,
    tp_size: 1, dp_size: 1, pp_size: 1, disable_radix_cache: true, disable_overlap_schedule: true, mem_fraction_static: 0.5,
    api_key: "private", admin_api_key: "private-admin" };
  const observed: PythonRuntimeObservationV2 = { kind: "python-env", node_id: "gpu-node", generation: "boot-1",
    environment_digest: hash, python_version: "3.12.1", packages_digest: hash, outer_image_digest: null };
  const expected = { node_id: "gpu-node", generation: "boot-1" };
  const result = validateProcessRuntimeObservation(info, observed, "GPU-123", lock, runtime, expected);
  assert.equal(result.schema_version, "2"); assert.equal("container_image_id" in result, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.throws(() => validateProcessRuntimeObservation(info, { ...observed, generation: "boot-2" }, "GPU-123", lock, runtime, expected), /generation changed/);
  assert.throws(() => validateProcessRuntimeObservation(info, observed, "GPU-another-node", lock, runtime, expected), /GPU UUID/);
  const validate = await validator("inference-execution-evidence");
  const evidence = { schema_version: "1", run_id: `run_${"a".repeat(32)}`, service: { service_id: processHandle.service_id, epoch: 1, isolation_key: hash },
    doctor: null, prepared_at: "2026-09-08T00:00:00Z", observation: result };
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...evidence, observation: { ...result, container_image_id: hash } }), false);
});
