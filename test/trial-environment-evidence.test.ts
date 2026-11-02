import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1 } from "../src/domain/index.js";
import { readJSON } from "../src/foundation/index.js";
import { loadTrialEnvironmentImages, prebuiltServiceImages, prebuiltTaskImage, recordTrialEnvironmentImageExecution, verifyTrialEnvironmentImageExecution, writeTrialEnvironmentImageEvidence } from "../src/evals/trial-environment-evidence.js";

const imageId = `sha256:${"a".repeat(64)}` as const;
const manifestDigest = `sha256:${"b".repeat(64)}` as const;
const reference = `registry.test/task@${manifestDigest}`;
const use: EnvironmentImageUseV1 = {
  task_ids: ["task-a"], image_id: imageId, requested_reference: "registry.test/task:latest",
  reference, manifest_digest: manifestDigest, platform: "linux/amd64", resolution: "registry", cache_hit: false,
};
const manifest: EnvironmentImageManifestV1 = {
  schema_version: "1",
  image_id: imageId,
  source: { kind: "registry", benchmark_id: "demo", benchmark_revision: "1", task_id: "task-a" },
  platform: "linux/amd64",
  build: { builder: "buildkit", frontend: "registry-resolution", secret_names: [], cache_key: `sha256:${"c".repeat(64)}` },
  output: { reference, manifest_digest: manifestDigest, config_digest: `sha256:${"d".repeat(64)}` },
  base_images: [],
  created_at: "2026-01-01T00:00:00.000Z",
};

test("trial environment evidence embeds the complete immutable image manifest", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-trial-environment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await loadTrialEnvironmentImages({ taskId: "task-a", uses: [use], loader: async () => manifest });
  await writeTrialEnvironmentImageEvidence(directory, "task-a", evidence);
  assert.deepEqual(await readJSON(path.join(directory, "environment", "image.manifest.json")), {
    schema_version: "1", task_id: "task-a", uses: [use], manifests: [manifest],
  });
});

test("trial environment evidence rejects a manifest that differs from the plan", async () => {
  await assert.rejects(loadTrialEnvironmentImages({
    taskId: "task-a",
    uses: [use],
    loader: async () => ({ ...manifest, output: { ...manifest.output, manifest_digest: `sha256:${"e".repeat(64)}` } }),
  }), /does not match/);
});

test("trial environment execution requires the planned image config digest", async () => {
  const evidence = await loadTrialEnvironmentImages({ taskId: "task-a", uses: [use], loader: async () => manifest });
  const execution = {
    observed: { containers: [{ image_config_digest: manifest.output.config_digest }] },
  } as never;
  assert.equal(verifyTrialEnvironmentImageExecution(execution, evidence), execution);
  assert.throws(() => verifyTrialEnvironmentImageExecution({
    observed: { containers: [{ image_config_digest: `sha256:${"f".repeat(64)}` }] },
  } as never, evidence), (error: unknown) => (error as { code?: string }).code === "environment_image_mismatch");
});

function preparedComposition() {
  const main: EnvironmentImageManifestV1 = { ...manifest, source: { ...manifest.source, kind: "build-context" },
    output: { ...manifest.output, reference: "hitch-environment:main" } };
  const sidecar: EnvironmentImageManifestV1 = { ...manifest, image_id: `sha256:${"e".repeat(64)}`, source: { ...manifest.source, kind: "compose-build" },
    output: { reference: "hitch-environment:simulator", manifest_digest: `sha256:${"f".repeat(64)}`, config_digest: `sha256:${"c".repeat(64)}` } };
  const uses: EnvironmentImageUseV1[] = [main, sidecar].map((entry, index) => ({
    ...use, image_id: entry.image_id, requested_reference: entry.output.reference,
    reference: `${entry.output.reference}@${entry.output.manifest_digest}`, manifest_digest: entry.output.manifest_digest,
    resolution: "prebuilt", ...(index === 1 ? { service: "simulator" } : {}),
  }));
  return { uses, manifests: [main, sidecar] };
}

test("sidecar bindings retain legacy main selection and reject swapped service images", () => {
  const evidence = preparedComposition();
  const [main, simulator] = evidence.manifests;
  assert.equal(prebuiltTaskImage(evidence), main?.output.config_digest);
  assert.equal(prebuiltServiceImages(evidence).simulator, simulator?.output.config_digest);
  const execution = { observed: { containers: [
    { service: "main", image_config_digest: main?.output.config_digest },
    { service: "simulator", image_config_digest: simulator?.output.config_digest },
  ] } } as never;
  assert.equal(verifyTrialEnvironmentImageExecution(execution, evidence), execution);
  assert.throws(() => verifyTrialEnvironmentImageExecution({ observed: { containers: [
    { service: "main", image_config_digest: simulator?.output.config_digest },
    { service: "simulator", image_config_digest: main?.output.config_digest },
  ] } } as never, evidence), { code: "environment_image_mismatch" });
  const constructor = { ...evidence, uses: [{ ...evidence.uses[1]!, service: "constructor" }] };
  assert.equal(prebuiltServiceImages(constructor).constructor, simulator?.output.config_digest);
});

test("a proven failure before Target starts preserves missing observations and still rejects contradictions", () => {
  const evidence = preparedComposition();
  const failure = { exception_info: { exception_type: "EnvironmentStartTimeoutError" }, agent_execution: null, verifier: null };
  for (const containers of [[], [{ service: "simulator", image_config_digest: evidence.manifests[1]?.output.config_digest }]]) {
    const execution = { observed: { containers } } as never;
    assert.equal(verifyTrialEnvironmentImageExecution(execution, evidence, failure), execution);
    assert.throws(() => verifyTrialEnvironmentImageExecution(execution, evidence), { code: "environment_image_evidence_unavailable" });
    assert.throws(() => verifyTrialEnvironmentImageExecution(execution, evidence, { ...failure, agent_execution: {} }), { code: "environment_image_evidence_unavailable" });
  }
  assert.throws(() => verifyTrialEnvironmentImageExecution({ observed: { containers: [
    { service: "simulator", image_config_digest: `sha256:${"9".repeat(64)}` },
  ] } } as never, evidence, failure), { code: "environment_image_mismatch" });
});

for (const containers of [[], [{}], [{ image_reference: reference }]]) {
  test(`missing immutable image observations are unavailable, not a mismatch: ${JSON.stringify(containers)}`, async () => {
    const evidence = await loadTrialEnvironmentImages({ taskId: "task-a", uses: [use], loader: async () => manifest });
    assert.throws(() => verifyTrialEnvironmentImageExecution({ observed: { containers } } as never, evidence),
      (error: unknown) => (error as { code?: string }).code === "environment_image_evidence_unavailable");
  });
}


test("image verification failure leaves the exact observation and manifest on disk", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-rejected-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await loadTrialEnvironmentImages({ taskId: "task-a", uses: [use], loader: async () => manifest });
  const execution = {
    schema_version: "1" as const, provider: "local-docker", worker_id: "local", collision_domain_id: "docker",
    eval_id: `eval_${"a".repeat(32)}`, work_id: `work_${"b".repeat(32)}`, lease_id: `lease_${"c".repeat(32)}`,
    lease_epoch: 1, task_id: "task-a", reservation: { cpu_millis: 1, memory_bytes: 1, container_slots: 1, build_slots: 0 },
    enforced: { main_limits: { cpu_millis: 1, memory_bytes: 1, container_slots: 1, build_slots: 0 }, sidecar_limits: {} },
    observed: { status: "unavailable" as const, started_at: "2026-01-01T00:00:00.000Z", collected_at: "2026-01-01T00:00:01.000Z",
      sample_count: 0, containers: [], unavailable_fields: ["image_identity" as const], issues: ["Docker unavailable"] },
  };
  await assert.rejects(recordTrialEnvironmentImageExecution(directory, execution, evidence),
    (error: unknown) => (error as { code?: string }).code === "environment_image_evidence_unavailable");
  assert.deepEqual(await readJSON(path.join(directory, "execution.json")), execution);
  assert.ok(await readJSON(path.join(directory, "environment", "image.manifest.json")));
});
