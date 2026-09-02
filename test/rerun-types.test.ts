import test from "node:test";
import assert from "node:assert/strict";
import {
  EVAL_RERUN_TYPES,
  assertEvalRerunTypeSupported,
  evalRerunSemantics,
  parseEvalRerunType,
} from "../src/evals/index.js";

test("eval rerun types have explicit candidate, conversation, and sandbox semantics", () => {
  assert.deepEqual(EVAL_RERUN_TYPES, [
    "candidate-restart",
    "candidate-resume",
    "trajectory-replay",
    "verifier-only",
    "collect-only",
  ]);
  assert.deepEqual(evalRerunSemantics("candidate-restart"), {
    candidate_action: "restart",
    conversation_source: "original-instruction",
    sandbox_source: "clean",
    candidate_executes: true,
  });
  assert.deepEqual(evalRerunSemantics("trajectory-replay"), {
    candidate_action: "replay",
    conversation_source: "canonical-trajectory",
    sandbox_source: "checkpoint",
    candidate_executes: true,
  });
  assert.deepEqual(evalRerunSemantics("verifier-only"), {
    candidate_action: "none",
    conversation_source: "none",
    sandbox_source: "recorded-artifacts",
    candidate_executes: false,
  });
});

test("restart and collection are executable while resume prerequisites remain explicit", () => {
  assert.doesNotThrow(() => assertEvalRerunTypeSupported("candidate-restart"));
  assert.doesNotThrow(() => assertEvalRerunTypeSupported("collect-only"));
  assert.doesNotThrow(() => assertEvalRerunTypeSupported("verifier-only"));
  const expected = new Map([
    ["candidate-resume", "eval_candidate_resume_unavailable"],
    ["trajectory-replay", "eval_trajectory_replay_unavailable"],
  ]);
  for (const [type, code] of expected) {
    assert.throws(
      () => assertEvalRerunTypeSupported(parseEvalRerunType(type)),
      (error: unknown) => (error as { code?: string; exitCode?: number }).code === code
        && (error as { exitCode?: number }).exitCode === 2,
    );
  }
  assert.throws(() => parseEvalRerunType("resume"), /must be one of/);
});
