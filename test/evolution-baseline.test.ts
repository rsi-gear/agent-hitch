import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ensureEvolutionBaseline, evolutionBaselineFingerprint, readEvolutionBaseline } from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

const evolutionId = "bb14b103-569d-4192-b9d1-51b26dc65a84";
const seedEval = `eval_${"a".repeat(32)}`;
const heldoutEval = `eval_${"b".repeat(32)}`;
const seedDigest = `sha256:${"c".repeat(64)}`;
const heldoutDigest = `sha256:${"d".repeat(64)}`;

test("Evolution baseline submits seed and heldout exactly once across concurrent rounds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-evolution-baseline-"));
  t.after(() => forceRemove(root));
  const fingerprint = evolutionBaselineFingerprint({ harness: "sha256:test", benchmark: "demo@1", attempts: 1 });
  let materializations = 0;
  let submissions = 0;
  const materialize = async ({ markRunning }: { markRunning(seed: string, heldout: string): Promise<void> }) => {
    materializations += 1;
    submissions += 2;
    await markRunning(seedEval, heldoutEval);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { seed_eval_id: seedEval, heldout_eval_id: heldoutEval, seed_result_digest: seedDigest, heldout_result_digest: heldoutDigest };
  };
  const [first, concurrent] = await Promise.all([
    ensureEvolutionBaseline({ root, evolutionId, fingerprint, materialize }),
    ensureEvolutionBaseline({ root, evolutionId, fingerprint, materialize }),
  ]);
  assert.deepEqual(concurrent, first);
  assert.equal(first.state, "ready");
  assert.equal(materializations, 1);
  assert.equal(submissions, 2, "the first materialization submits one seed and one heldout eval");

  let validations = 0;
  const laterRound = await ensureEvolutionBaseline({
    root, evolutionId, fingerprint,
    materialize: async () => { throw new Error("later Candidate round must not submit a baseline"); },
    validateReady: async () => { validations += 1; },
  });
  assert.equal(laterRound.seed_eval_id, seedEval);
  assert.equal(materializations, 1);
  assert.equal(submissions, 2);
  assert.equal(validations, 1);
  assert.deepEqual(await readEvolutionBaseline(root, evolutionId), laterRound);
});

test("Evolution baseline fails closed after failure or fingerprint drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-evolution-baseline-failed-"));
  t.after(() => forceRemove(root));
  const fingerprint = evolutionBaselineFingerprint({ benchmark: "demo@1" });
  await assert.rejects(ensureEvolutionBaseline({
    root, evolutionId, fingerprint, materialize: async () => { throw new Error("submission failed"); },
  }), /submission failed/);
  let submissions = 0;
  await assert.rejects(ensureEvolutionBaseline({
    root, evolutionId, fingerprint, materialize: async () => { submissions += 1; throw new Error("unexpected"); },
  }), (error: unknown) => (error as { code?: string }).code === "evolution_baseline_failed");
  await assert.rejects(ensureEvolutionBaseline({
    root, evolutionId, fingerprint: evolutionBaselineFingerprint({ benchmark: "demo@2" }),
    materialize: async () => { submissions += 1; throw new Error("unexpected"); },
  }), (error: unknown) => (error as { code?: string }).code === "evolution_baseline_fingerprint_mismatch");
  assert.equal(submissions, 0);
});
