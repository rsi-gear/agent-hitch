import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import type { ExecutionProviderStatusV1 } from "../src/domain/index.js";
import { ModelInteractionCapture, endpointIdentity, loadInteractionCapture, planModelCapture } from "../src/model-access/index.js";

const PROVIDER: ExecutionProviderStatusV1 = {
  schema_version: "1",
  provider: "local-docker",
  worker_id: "worker-local",
  collision_domain_id: "docker-local",
  health: "healthy",
  platforms: ["linux/amd64"],
  backends: [{ id: "harbor", version: "0.21.0" }],
  features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false },
  capacity: {
    total: { cpu_millis: 4_000, memory_bytes: 8_000, container_slots: 2, build_slots: 1 },
    allocatable: { cpu_millis: 4_000, memory_bytes: 8_000, container_slots: 2, build_slots: 1 },
    allocated: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 },
  },
  heartbeat_at: new Date().toISOString(),
};

test("model capture policy gates proxy support and records explicit degradation", () => {
  assert.deepEqual(planModelCapture({ policy: { mode: "hybrid", required: true }, adapter: getAdapter("codex").requirements, provider: PROVIDER }), {
    requested_mode: "hybrid", effective_mode: "hybrid", required: true, topology: "host-side",
  });
  assert.deepEqual(planModelCapture({ policy: { mode: "proxy", required: false }, adapter: getAdapter("pi").requirements, provider: PROVIDER }), {
    requested_mode: "proxy", effective_mode: "native", required: false, degraded_reason: "adapter-endpoint-override-unsupported",
  });
  assert.throws(
    () => planModelCapture({ policy: { mode: "proxy", required: true }, adapter: getAdapter("pi").requirements, provider: PROVIDER }),
    (error: unknown) => (error as { code?: string }).code === "model_capture_unsupported",
  );
  assert.throws(() => planModelCapture({ policy: { mode: "off", required: true }, adapter: getAdapter("pi").requirements, provider: PROVIDER }), /cannot be required/);
});

test("interaction capture redacts headers, payload fields, known credentials, and endpoint query values", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-model-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secret = "known-super-secret";
  const capture = await ModelInteractionCapture.open({
    runDirectory: directory,
    runId,
    evalId: `eval_${"b".repeat(32)}`,
    trialId: "trial-a",
    mode: "hybrid",
    required: true,
    topology: "host-side",
    credentialValues: [secret],
  });
  const interaction = await capture.record({
    requestedModel: "gpt-test",
    effectiveModel: "gpt-test-2026",
    endpoint: "https://API.Example.test:443/v1/chat/completions?api_key=query-secret",
    status: "succeeded",
    httpStatus: 200,
    usage: { input_tokens: 3, output_tokens: 2 },
    requestHeaders: { Authorization: "Bearer abcdefghijklmnop", "x-trace": secret },
    request: { model: "gpt-test", api_key: secret, input: `prefix ${secret} suffix` },
    responseHeaders: { "set-cookie": "session=private" },
    response: { output: "ok", token: "private-token" },
  });
  const ref = await capture.close();
  assert.equal(ref.completeness, "complete");
  assert.equal(ref.interaction_count, 1);
  assert.equal(ref.redaction.status, "applied");
  assert.equal(interaction.endpoint_identity, endpointIdentity("https://api.example.test/v1/chat/completions"));
  const loaded = await loadInteractionCapture(directory);
  assert.equal(loaded.interactions[0]?.interaction_id, interaction.interaction_id);
  const request = await readFile(path.join(directory, ...(interaction.request_ref as string).split("/")), "utf8");
  const response = await readFile(path.join(directory, ...(interaction.response_ref as string).split("/")), "utf8");
  const rows = await readFile(path.join(directory, "interactions", "interactions.jsonl"), "utf8");
  const captureRef = await readFile(path.join(directory, "interactions", "interaction.ref.json"), "utf8");
  for (const content of [request, response, rows, captureRef]) {
    assert.equal(content.includes(secret), false);
    assert.equal(content.includes("query-secret"), false);
    assert.equal(content.includes("abcdefghijklmnop"), false);
    assert.equal(content.includes("private-token"), false);
  }
});
