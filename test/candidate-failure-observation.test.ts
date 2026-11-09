import test from "node:test";
import assert from "node:assert/strict";
import { verifierObservation } from "../src/evals/verifier-diagnostics.js";
import { classifyTrialFailure, physicalRetryAllowed } from "../src/evals/failure-classifier.js";

const base = { trial: {}, trajectoryStatus: "valid" as const, recordStatus: "valid" as const,
  verifierRef: undefined, infrastructure: null };

test("candidate program failure keeps its category and unavailable quality, without infrastructure retry", () => {
  for (const [runStatus, candidateErrorCode, reason] of [
    ["failed", "agent_failed", "agent_failed"], ["timed_out", "timed_out", "agent_timed_out"],
  ]) {
    const observation = verifierObservation({ ...base, runStatus: runStatus!, candidateErrorCode });
    assert.deepEqual(observation, { status: "invalid", invalid_reason: reason });
    const classification = classifyTrialFailure({ task_id: "ordinary-task", attempt: 1, trial_id: "ordinary-task__1",
      run_id: `run_${"a".repeat(32)}`, observation_status: "invalid", invalid_reason: reason! });
    assert.equal(classification?.phase, "agent");
    assert.equal(physicalRetryAllowed(classification), false);
  }
});

test("unknown or corrupt candidate failures remain infrastructure/collection failures", () => {
  for (const change of [{ candidateErrorCode: "spawn_failed" }, { recordStatus: "corrupt" as const }, { candidateErrorCode: undefined }]) {
    const observation = verifierObservation({ ...base, runStatus: "failed", candidateErrorCode: "agent_failed", ...change });
    assert.deepEqual(observation, { status: "invalid", invalid_reason: "infrastructure_failure" });
  }
});

test("candidate failure never adopts an unrelated verifier score", () => {
  const observation = verifierObservation({ ...base, trial: { verifier_result: { rewards: { reward: 1 } } },
    verifierRef: "verifier/result.json", runStatus: "failed", candidateErrorCode: "agent_failed" });
  assert.equal(observation.invalid_reason, "agent_failed");
  assert.equal(observation.reward, undefined);
});
