import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ensureControllerRuntime, useControllerRuntimeById } from "../src/controller-runtime/index.js";
import { statePaths } from "../src/foundation/index.js";
import { prepareVerifierEnvironmentRuntime, verifierRuntimeRepair, VERIFIER_ENVIRONMENT_PROVIDER } from "../src/evals/verifier-runtime.js";
import { parseEvalRerunSubmissionInput, parsePersistedSubmission } from "../src/control-plane/rerun-submission.js";
import { evalRerunSemantics } from "../src/evals/rerun-types.js";
import type { EvalId } from "../src/domain/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("verifier repair creates a new immutable runtime and permits exactly one environment provider change", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-runtime-"));
  t.after(() => forceRemove(root));
  const payload = path.join(root, "payload");
  const files = { "dist/bin/hitch.js": "// frozen CLI\n", [VERIFIER_ENVIRONMENT_PROVIDER]: "# old provider\n",
    "integrations/harbor/hitch_harbor_verifier.py": "# original grader\n" };
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(payload, file)), { recursive: true }); await writeFile(path.join(payload, file), text); }
  const source = await ensureControllerRuntime({ root, payloadRoot: payload, rules: Object.keys(files).map(file => ({ path: file })) });
  const provider = path.join(root, "provider.py"); await writeFile(provider, "# repaired provider\n");
  const repaired = await prepareVerifierEnvironmentRuntime({ root, sourceRuntimeId: source.runtime_id, providerPath: provider });
  const receipt = verifierRuntimeRepair(source, repaired)!;
  assert.notEqual(repaired.runtime_id, source.runtime_id);
  assert.equal(receipt.unchanged_file_count, 2);
  assert.equal(receipt.path, VERIFIER_ENVIRONMENT_PROVIDER);
  assert.equal((await useControllerRuntimeById(statePaths(root), source.runtime_id.slice(7))).runtime_id, source.runtime_id);
  for (const [file, bytes] of Object.entries(files)) assert.equal(await readFile(path.join(source.directory, "payload", file), "utf8"), bytes);
  assert.equal((await prepareVerifierEnvironmentRuntime({ root, sourceRuntimeId: source.runtime_id, providerPath: provider })).runtime_id, repaired.runtime_id);
  const drift = structuredClone(repaired);
  drift.manifest.files.find(file => file.path.endsWith("hitch_harbor_verifier.py"))!.sha256 = `sha256:${"f".repeat(64)}`;
  assert.throws(() => verifierRuntimeRepair(source, drift), /only the Docker environment provider/);
  const membership = structuredClone(repaired); membership.manifest.files.pop();
  assert.throws(() => verifierRuntimeRepair(source, membership), /execution contract/);
  const permissions = structuredClone(repaired); permissions.manifest.files[0]!.executable = !permissions.manifest.files[0]!.executable;
  assert.throws(() => verifierRuntimeRepair(source, permissions), /permissions/);
  assert.equal(verifierRuntimeRepair(source, source), null);
});

test("explicit verifier runtime selection survives persisted submission and rejects other rerun types", () => {
  const runtime = `sha256:${"b".repeat(64)}`;
  const input = { rerun_type: "verifier-only", verifier_runtime_id: runtime, selector: { mode: "invalid" } };
  assert.equal(parseEvalRerunSubmissionInput(input).verifier_runtime_id, runtime);
  const evalId = `eval_${"a".repeat(32)}` as EvalId, rerunId = `rerun_${"c".repeat(32)}`;
  const persisted = { ...input, schema_version: "1", eval_id: evalId, rerun_id: rerunId,
    semantics: evalRerunSemantics("verifier-only"), submitted_at: new Date().toISOString() };
  assert.equal(parsePersistedSubmission(persisted, evalId, rerunId).verifier_runtime_id, runtime);
  for (const value of [{ ...input, rerun_type: "candidate-restart" }, { ...input, verifier_runtime_id: "latest" }]) {
    assert.throws(() => parseEvalRerunSubmissionInput(value), /verifier runtime/);
  }
});
