import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InferenceRuntimeManifestV1, InferenceServiceRecordV1 } from "../src/domain/index.js";
import { hitchRootId, sha256JSON } from "../src/foundation/index.js";
import { addLocalModel, buildInferenceLock, inferenceRuntimeIdentity, ProcessSGLangLauncher, validateProcessRuntimeObservation } from "../src/inference/index.js";
import type { InferenceNodeClient, SGLangAttachInput, SGLangLaunchInput } from "../src/inference/index.js";
import { safetensorsFixture } from "./helpers.js";

/** Contract fixture only: fake node, CUDA observations and HTTP engine. */
export async function inferenceAttachmentFixture(temporary: string) {
  const root = path.join(temporary, "hitch"), source = path.join(temporary, "model"); await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ model_type: "qwen2", torch_dtype: "bfloat16", max_position_embeddings: 128 }));
  await writeFile(path.join(source, "tokenizer.json"), "{}");
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "attachment-fixture" });
  const actual = { pythonVersion: "3.12.1", packagesDigest: sha256JSON("fixture-packages"), outerImageDigest: null };
  const body = { schema_version: "2" as const, engine: "sglang" as const, sglang_version: "0.0.0", sglang_commit: null, backend: "cuda" as const,
    package: { kind: "python-env" as const, environment_digest: sha256JSON(actual), python_version: actual.pythonVersion, packages_digest: actual.packagesDigest },
    compatibility_profile: "attachment-fixture-only" };
  const runtime: InferenceRuntimeManifestV1 = { ...body, runtime_id: inferenceRuntimeIdentity(body) };
  const node = { nodeId: "fixture-node", generation: "boot-1" };
  const modelNode = { schema_version: "2" as const, node_id: node.nodeId, generation: node.generation, runtime_digest: sha256JSON(actual), launcher: "process" as const };
  const lock = buildInferenceLock(model, runtime, { backend: "cuda", profile: "baseline", deviceConstraint: "GPU-fixture", modelNode, api: "chat-completions" });
  const serviceId = `inference_${"a".repeat(32)}`, owner = `run_${"b".repeat(32)}`;
  const handle = { schema_version: "2" as const, kind: "process" as const, node_id: node.nodeId, generation: node.generation,
    service_id: serviceId, process: { pid: 42, created_at: 1.5 } };
  const execution = lock.execution;
  if (execution.platform.backend !== "cuda") throw new TypeError("attachment fixture requires its CUDA contract");
  const serverInfo = { version: "0.0.0", device: "cuda", dtype: execution.dtype, kv_cache_dtype: execution.kv_cache_dtype,
    attention_backend: execution.attention_backend, sampling_backend: execution.sampling_backend, context_length: execution.context_tokens_per_request,
    max_running_requests: execution.max_running_requests, tp_size: 1, dp_size: 1, pp_size: 1, disable_radix_cache: true, disable_overlap_schedule: true,
    max_total_num_tokens: execution.max_total_tokens, mem_fraction_static: execution.platform.mem_fraction_static, api_key: "fixture-private" };
  const observation = validateProcessRuntimeObservation(serverInfo, { kind: "python-env", node_id: node.nodeId, generation: node.generation,
    environment_digest: sha256JSON(actual), python_version: actual.pythonVersion, packages_digest: actual.packagesDigest, outer_image_digest: null }, "GPU-fixture", lock, runtime, modelNode);
  const input: SGLangLaunchInput = { root, serviceId, model, runtime, lock };
  const record: InferenceServiceRecordV1 = { schema_version: "1", service_id: serviceId, inference_id: lock.inference_id, isolation_key: sha256JSON("scope"),
    state: "ready", epoch: 7, owner_id: owner, lease_owner_ids: [owner], backend: "cuda", model_node: modelNode, service_handle: handle,
    started_at: observation.observed_at, updated_at: observation.observed_at };
  const attach: SGLangAttachInput = { root, lock, model, runtime, record, observation };
  const status: Record<string, unknown> = { schemaVersion: 2, state: "ready", resourcesReleased: false, inferenceId: lock.inference_id,
    inputDigest: sha256JSON({ serviceId, ownerId: hitchRootId(root), model, runtime, lock }), handle,
    access: { port: 30123, engineToken: "d".repeat(64), adminToken: "e".repeat(64), wireModel: `hitch-${model.model_id.slice(7, 23)}` },
    runtime: actual, serverInfo, gpuUuid: "GPU-fixture" };
  const calls: string[] = [];
  const client: InferenceNodeClient = { node,
    prepare: async () => { calls.push("prepare"); },
    start: async value => {
      calls.push("start"); status.handle = { ...handle, service_id: value.serviceId };
      status.inputDigest = sha256JSON({ serviceId: value.serviceId, ownerId: hitchRootId(root), model, runtime, lock });
      return structuredClone(status);
    },
    attach: async () => { calls.push("attach"); return structuredClone(status); },
    inspect: async () => { calls.push("inspect"); return structuredClone(status); },
    route: async () => { calls.push("route"); return "http://127.0.0.1:30123"; },
    stop: async () => { calls.push("stop"); return { ...structuredClone(status), state: "stopped", resourcesReleased: true }; },
  };
  const request: typeof fetch = async (url, options) => {
    const endpoint = new URL(String(url)).pathname; calls.push(`${options?.method ?? "GET"} ${endpoint}`);
    if (endpoint === "/v1/models") return Response.json({ data: [{ id: `hitch-${model.model_id.slice(7, 23)}` }] });
    if (endpoint === "/v1/chat/completions") {
      const output = { choices: [{ finish_reason: "stop" }] };
      return JSON.parse(String(options?.body)).stream
        ? new Response(`data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(output);
    }
    return Response.json({ ok: true });
  };
  return { root, input, attach, record, observation, status, calls, client, request, launcher: new ProcessSGLangLauncher(client, request) };
}
