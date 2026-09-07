import test from "node:test";
import assert from "node:assert/strict";
import { harnessChildEnvironment, managedHarborModelRuntime, scrubLocalInferenceEnvironment } from "../src/runs/local-inference-environment.js";
import type { RunId } from "../src/domain/index.js";

const runId = `run_${"a".repeat(32)}` as RunId;
const identity = {
  inference_id: `sha256:${"c".repeat(64)}` as const,
  model_id: `sha256:${"d".repeat(64)}` as const,
};

test("managed local inference removes cloud and model-runtime environment variables", () => {
  const scrubbed = scrubLocalInferenceEnvironment({
    PATH: "/bin",
    HITCH_CODEX_PATH: "/opt/codex",
    OPENAI_API_KEY: "cloud-secret",
    ANTHROPIC_BASE_URL: "https://cloud.invalid",
    HF_TOKEN: "download-secret",
    SGLANG_USE_CPU_ENGINE: "0",
    TRANSFORMERS_OFFLINE: "0",
    TORCH_LOGS: "all",
    CODEX_HOME: "/user/config",
    HITCH_LOCAL_MODEL_TOKEN: "stale-local-token",
  });
  assert.deepEqual(scrubbed, { PATH: "/bin", HITCH_CODEX_PATH: "/opt/codex" });
});

test("managed Harbor inference becomes a typed endpoint without restoring OpenAI variables", () => {
  const parent = {
    HITCH_HARBOR_INTERNAL: "1",
    HITCH_MANAGED_LOCAL_INFERENCE: "1",
    HITCH_MANAGED_RUN_ID: runId,
    HITCH_MANAGED_INFERENCE_ID: identity.inference_id,
    HITCH_MANAGED_MODEL_ID: identity.model_id,
    OPENAI_API_KEY: "hitch-managed-local",
    OPENAI_BASE_URL: `http://host.docker.internal:4321/${"b".repeat(48)}/${runId}/openai`,
    ANTHROPIC_API_KEY: "must-not-pass",
  };
  const runtime = managedHarborModelRuntime(parent, runId, identity);
  assert.equal(runtime.model_endpoint.base_url, parent.OPENAI_BASE_URL);
  assert.equal(runtime.model_endpoint.inference_id, identity.inference_id);
  assert.equal(runtime.model_endpoint_credential, "hitch-managed-local");
  const child = harnessChildEnvironment({
    parent,
    adapter: {
      HITCH_LOCAL_MODEL_BASE_URL: runtime.model_endpoint.base_url,
      HITCH_LOCAL_MODEL_TOKEN: runtime.model_endpoint_credential,
    },
    cwd: "/workspace",
    managedLocal: true,
  });
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.OPENAI_BASE_URL, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.HITCH_LOCAL_MODEL_TOKEN, "hitch-managed-local");
  assert.throws(() => managedHarborModelRuntime({
    ...parent,
    OPENAI_API_KEY: "real-cloud-key",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  }, runId, identity), /proxy environment is invalid/);
});
