import test from "node:test";
import assert from "node:assert/strict";
import { capturePortableHarborRegradeConfig, parsePortableHarborRegradeConfig, restorePortableHarborRegradeConfig } from "../src/backends/index.js";
import { sha256JSON } from "../src/foundation/index.js";

function source() {
  return { task: { path: "/original/task", git_url: null, name: null }, trial_name: "original", trials_dir: "/original/trials",
    job_id: null, source_trial: null, install_only: false, timeout_multiplier: 1.5, verifier_timeout_multiplier: 2,
    agent_timeout_multiplier: null, agent_setup_timeout_multiplier: 3, environment_build_timeout_multiplier: 4,
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", override_timeout_sec: 123, override_setup_timeout_sec: 45,
      kwargs: { api_key: "private-agent-key", hitch_runtime_dir: "/original/runtime" }, env: { PRIVATE_KEY: "private-agent-env" } },
    environment: { type: "docker", import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment", delete: false,
      force_build: false, cpu_enforcement_policy: "limit", memory_enforcement_policy: "limit", override_cpus: 2, override_memory_mb: 2048,
      override_storage_mb: 1024, override_gpus: null, override_tpu: null, mounts: null, extra_docker_compose: [], env: {},
      kwargs: { hitch_ownership_labels: { "io.hitch.lease-id": "old-lease" }, hitch_service_resource_limits: { db: { cpu_millis: 1000, memory_bytes: 1024 ** 3 } },
        hitch_resolved_images: { "example:test": `example@sha256:${"a".repeat(64)}` }, hitch_model_proxy_host_gateway: true }, extra_allowed_hosts: [] },
    verifier: { import_path: "hitch_harbor_verifier:HitchRetryingVerifier", disable: false, override_timeout_sec: 89, max_timeout_sec: 144,
      kwargs: { infrastructure_retries: 2, infrastructure_retry_backoff_ms: 30 }, include_logs: ["reward.json"], exclude_logs: [], env: {} },
    artifacts: [{ source: "/work/patch", destination: "patch", exclude: ["*.tmp"], service: null }], extra_instruction_paths: [] };
}

test("portable regrade preserves scoring settings while replacing host paths and lease ownership", () => {
  const original = source(), portable = capturePortableHarborRegradeConfig(original, "/original/task");
  assert.equal(portable.source_config_digest, sha256JSON(original));
  assert.equal(portable.source_agent_config_digest, sha256JSON(original.agent));
  assert.equal(/private-agent|original\/|old-lease/.test(JSON.stringify(portable)), false);
  assert.deepEqual(parsePortableHarborRegradeConfig(portable), portable);
  const restored = restorePortableHarborRegradeConfig({ portable, sourceConfigDigest: sha256JSON(original),
    taskDirectory: "/new/task", sourceDirectory: "/new/source", outputDirectory: "/new/trials", trialName: "assessment", sourceResult: { id: "original-uuid" },
    ownershipLabels: { "io.hitch.lease-id": "new-lease" } });
  const config = restored.regradeConfig;
  assert.deepEqual(config.task, { path: "/new/task" });
  assert.deepEqual(config.source_trial, { action: "regrade", type: "local", trial_id: "original-uuid", path: "/new/source" });
  assert.equal(config.verifier_timeout_multiplier, 2); assert.equal(config.environment_build_timeout_multiplier, 4);
  const { env: _env, ...verifier } = original.verifier;
  assert.deepEqual(config.verifier, verifier);
  const environment = config.environment as Record<string, unknown>;
  assert.equal(environment.override_cpus, 2); assert.equal(environment.override_memory_mb, 2048);
  assert.deepEqual((environment.kwargs as Record<string, unknown>).hitch_ownership_labels, { "io.hitch.lease-id": "new-lease" });
  assert.deepEqual(config.artifacts, original.artifacts);
  assert.deepEqual(config.agent, { import_path: original.agent.import_path, override_timeout_sec: 123, override_setup_timeout_sec: 45 });
});

test("portable regrade rejects unsupported host dependencies, credential-bearing config and source replacement", () => {
  for (const modify of [
    (s: any) => { s.environment.mounts = [{ source: "/host" }]; },
    (s: any) => { s.environment.extra_docker_compose = ["/host/compose.yml"]; },
    (s: any) => { s.environment.env = { TOKEN: "private" }; },
    (s: any) => { s.verifier.env = { TOKEN: "private" }; },
    (s: any) => { s.verifier.kwargs.api_key = "private"; },
    (s: any) => { s.extra_instruction_paths = ["/host/prompt"]; },
    (s: any) => { s.environment.kwargs.hitch_other = "unknown behavior"; },
    (s: any) => { s.verifier.import_path = "untrusted:Verifier"; },
  ]) { const original = source(); modify(original); assert.throws(() => capturePortableHarborRegradeConfig(original, "/original/task"), { code: "eval_verifier_only_unavailable" }); }
  const original = source(), portable = capturePortableHarborRegradeConfig(original, "/original/task");
  (portable.config.agent as any).kwargs = { credential: "substituted" };
  assert.throws(() => parsePortableHarborRegradeConfig(portable), /not canonical/);
  assert.throws(() => restorePortableHarborRegradeConfig({ portable: capturePortableHarborRegradeConfig(original, "/original/task"), sourceConfigDigest: sha256JSON("different"),
    taskDirectory: "/new/task", sourceDirectory: "/new/source", outputDirectory: "/new/trials", trialName: "assessment", sourceResult: { id: "id" }, ownershipLabels: {} }), /source or paths differ/);
});
