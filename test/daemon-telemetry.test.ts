import test from "node:test";
import assert from "node:assert/strict";
import { DaemonTelemetry } from "../src/daemon/telemetry.js";

test("daemon telemetry exposes separate lifecycle durations and typed rerun counters", () => {
  const telemetry = new DaemonTelemetry();
  telemetry.observe({ type: "eval.plan.created", duration_ms: 11 });
  telemetry.observe({ type: "build.completed", duration_ms: 22 });
  telemetry.observe({ type: "eval.setup.completed", duration_ms: 33 });
  telemetry.observe({ type: "eval.agent.completed", duration_ms: 44 });
  telemetry.observe({ type: "eval.verifier.completed", duration_ms: 55 });
  telemetry.observe({ type: "eval.collection.completed", duration_ms: 66 });
  telemetry.observe({ type: "eval.rerun.started", rerun_type: "candidate-restart" });
  telemetry.observe({ type: "eval.rerun.started", rerun_type: "collect-only" });
  const snapshot = telemetry.snapshot() as {
    phase_durations_ms: Record<string, { count: number; total_ms: number }>;
    trials: { candidate_reruns: number; reruns_by_type: Record<string, number> };
  };
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.phase_durations_ms).map(([phase, value]) => [phase, value.total_ms])), {
    agent: 44, build: 22, collection: 66, planning: 11, setup: 33, verifier: 55,
  });
  assert.equal(snapshot.trials.candidate_reruns, 1);
  assert.deepEqual(snapshot.trials.reruns_by_type, { "candidate-restart": 1, "collect-only": 1 });
});
