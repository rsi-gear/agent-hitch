import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1, ExecutionEvidenceV1 } from "../src/domain/index.js";
import { readJSON } from "../src/foundation/index.js";
import { parseEnvironmentImageUses } from "../src/evals/execution-plan-images.js";
import { loadVerifierEnvironmentImages, prebuiltTaskImage, prebuiltVerifierImage, verifyTrialEnvironmentImageExecution, writeTrialEnvironmentImageEvidence } from "../src/evals/trial-environment-evidence.js";

const sha = (value: string) => `sha256:${value.repeat(64)}` as const;
function composition() {
  const manifests: EnvironmentImageManifestV1[] = ["candidate", "verifier"].map((role, index) => ({
    schema_version: "1", image_id: sha(index ? "b" : "a"), source: { kind: "build-context", benchmark_id: "demo", benchmark_revision: "1", task_id: "one" },
    platform: "linux/amd64", build: { builder: "buildkit", secret_names: [], cache_key: sha("c") },
    output: { reference: `hitch-environment:${role}`, manifest_digest: sha(index ? "e" : "d"), config_digest: sha(index ? "f" : "0") },
    base_images: [], created_at: "2026-01-01T00:00:00.000Z",
  }));
  const uses: EnvironmentImageUseV1[] = manifests.map((manifest, index) => ({ task_ids: ["one"], role: index ? "verifier" : "candidate",
    image_id: manifest.image_id, requested_reference: manifest.output.reference,
    reference: `${manifest.output.reference}@${manifest.output.manifest_digest}`, manifest_digest: manifest.output.manifest_digest,
    platform: manifest.platform, resolution: "prebuilt", cache_hit: false }));
  return { uses, manifests };
}
const observed = (role: "candidate" | "verifier", digest: string) => ({ role, service: "main", image_config_digest: digest });
const execution = (containers: unknown[]) => ({ observed: { containers } }) as ExecutionEvidenceV1;

test("image role parsers preserve historical bytes and distinguish both main bindings", () => {
  const evidence = composition();
  assert.deepEqual(parseEnvironmentImageUses(evidence.uses, ["one"], "roles"), evidence.uses);
  const { role: _role, ...legacy } = evidence.uses[0]!;
  assert.deepEqual(parseEnvironmentImageUses([legacy], ["one"], "legacy"), [legacy]);
  assert.equal("role" in parseEnvironmentImageUses([legacy], ["one"], "legacy")[0]!, false);
  assert.throws(() => parseEnvironmentImageUses([legacy, evidence.uses[0]], ["one"], "duplicate"), /duplicated/);
  assert.throws(() => parseEnvironmentImageUses([{ ...evidence.uses[1], role: "other" }], ["one"], "invalid"), /invalid/);
  assert.throws(() => parseEnvironmentImageUses([{ ...evidence.uses[1], service: "simulator" }], ["one"], "invalid"), /invalid/);
});

test("both image schemas accept optional roles and retain prebuilt-only service bindings", async () => {
  const evidence = composition(), ajv = new Ajv2020({ strict: false });
  for (const name of ["eval-execution-plan", "run-environment-images"]) {
    const schema = await readJSON<any>(path.resolve(`docs/schemas/${name}.schema.json`));
    const imageUse = name === "eval-execution-plan" ? schema.$defs.imageUse : schema.properties.uses.items;
    const validate = ajv.compile({ $defs: { ...schema.$defs, imageUse }, $ref: "#/$defs/imageUse" });
    assert.equal(validate(evidence.uses[1]), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...evidence.uses[1], role: "unknown" }), false);
    assert.equal(validate({ ...evidence.uses[1], service: "simulator" }), false);
    assert.equal(validate({ ...evidence.uses[0], service: "simulator", resolution: "registry" }), false);
    const { role: _role, ...legacy } = evidence.uses[0]!;
    assert.equal(validate(legacy), true);
  }
});

test("strict role evidence rejects swapped images, candidate-only success and unlabelled verifier witnesses", () => {
  const evidence = composition(), [candidate, verifier] = evidence.manifests;
  assert.equal(prebuiltTaskImage(evidence), candidate!.output.config_digest);
  assert.equal(prebuiltVerifierImage(evidence), verifier!.output.config_digest);
  const correct = execution([observed("candidate", candidate!.output.config_digest!), observed("verifier", verifier!.output.config_digest!)]);
  assert.equal(verifyTrialEnvironmentImageExecution(correct, evidence), correct);
  assert.throws(() => verifyTrialEnvironmentImageExecution(execution([
    observed("candidate", verifier!.output.config_digest!), observed("verifier", candidate!.output.config_digest!),
  ]), evidence), { code: "environment_image_mismatch" });
  for (const witness of [[], [{ service: "main", image_config_digest: verifier!.output.config_digest }], [{ role: "verifier", image_config_digest: verifier!.output.config_digest }]]) {
    assert.throws(() => verifyTrialEnvironmentImageExecution(execution([observed("candidate", candidate!.output.config_digest!), ...witness]), evidence), { code: "environment_image_evidence_unavailable" });
  }
});

test("missing verifier preserves proven unstarted phases while observed contradictions stay strict", () => {
  const evidence = composition(), candidate = observed("candidate", evidence.manifests[0]!.output.config_digest!);
  const onlyCandidate = execution([candidate]);
  for (const trial of [
    { agent_execution: {}, verifier: null, exception_info: { exception_type: "AgentError" } },
    { agent_execution: {}, verifier: {}, exception_info: { exception_type: "VerifierEnvironmentStartTimeoutError" } },
    { agent_execution: {}, verifier: {}, exception_info: { exception_type: "VerifierEnvironmentStartError" } },
  ]) {
    assert.equal(verifyTrialEnvironmentImageExecution(onlyCandidate, evidence, trial), onlyCandidate);
    assert.throws(() => verifyTrialEnvironmentImageExecution(execution([candidate, observed("verifier", sha("9"))]), evidence, trial), { code: "environment_image_mismatch" });
  }
  assert.throws(() => verifyTrialEnvironmentImageExecution(onlyCandidate, evidence,
    { agent_execution: {}, verifier: {}, exception_info: { exception_type: "VerifierTimeoutError" } }), { code: "environment_image_evidence_unavailable" });
});

test("legacy registry records accept newly labelled verifier containers without rewriting source roles", () => {
  const evidence = composition(), { role: _role, ...legacy } = evidence.uses[1]!;
  const manifest = { ...evidence.manifests[1]!, source: { ...evidence.manifests[1]!.source, kind: "registry" as const }, output: { ...evidence.manifests[1]!.output, reference: legacy.reference } };
  const historical = { uses: [{ ...legacy, resolution: "registry" as const }], manifests: [manifest] };
  const actual = execution([observed("verifier", manifest.output.config_digest!)]);
  assert.equal(verifyTrialEnvironmentImageExecution(actual, historical), actual);
  assert.equal("role" in historical.uses[0]!, false);
});

test("verifier-only loads its sealed role, checks config against the plan and never requires candidate rerun evidence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-verifier-image-role-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const original = composition(), manifestFile = path.join(directory, "environment/image.manifest.json");
  await writeTrialEnvironmentImageEvidence(directory, "one", original);
  const before = await readFile(manifestFile);
  const sourceConfig = { environment: { kwargs: { hitch_prebuilt_verifier_image: original.manifests[1]!.output.config_digest, hitch_verifier_resolved_images: {} } } };
  const selected = await loadVerifierEnvironmentImages({ manifestFile, taskId: "one", uses: original.uses, sourceConfig });
  assert.deepEqual(selected?.uses.map(use => use.role), ["verifier"]);
  const onlyVerifier = execution([observed("verifier", original.manifests[1]!.output.config_digest!)]);
  assert.equal(verifyTrialEnvironmentImageExecution(onlyVerifier, selected), onlyVerifier);
  assert.throws(() => verifyTrialEnvironmentImageExecution(execution([]), selected), { code: "environment_image_evidence_unavailable" });
  assert.throws(() => verifyTrialEnvironmentImageExecution(execution([observed("verifier", sha("9"))]), selected), { code: "environment_image_mismatch" });
  await assert.rejects(loadVerifierEnvironmentImages({ manifestFile, taskId: "one", uses: original.uses,
    sourceConfig: { environment: { kwargs: { ...sourceConfig.environment.kwargs, hitch_prebuilt_verifier_image: sha("9") } } } }), { code: "environment_image_mismatch" });
  await assert.rejects(loadVerifierEnvironmentImages({ manifestFile, taskId: "one", uses: [{ ...original.uses[1]!, image_id: sha("9") }], sourceConfig }), { code: "environment_image_mismatch" });
  assert.deepEqual(await readFile(manifestFile), before);
  assert.equal(await loadVerifierEnvironmentImages({ manifestFile: "absent", taskId: "one", uses: [], sourceConfig: {} }), undefined);
});
