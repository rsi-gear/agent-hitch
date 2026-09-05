import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BackendWorkItemV1, EvalTrialRefV1 } from "../src/domain/index.js";
import {
  ensurePhysicalRetryDecision, ensureTerminalRetryDecision, readEvalRetryState, transitionRetryDecision,
  physicalRetryWorkItem, retryBackoffMs,
} from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

const EVAL_ID = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const item: BackendWorkItemV1 = {
  schema_version: "1", eval_id: EVAL_ID, backend: "harbor",
  work_id: "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  slots: ["slot-1"], task_ids: ["task-a"], logical_attempt: 1, requested_parallelism: 1,
  provider: "local-docker", opaque_membership: false,
  reservation: { cpu_millis: 1_000, memory_bytes: 1_024, container_slots: 1, build_slots: 0 },
};

test("retry backoff is deterministic exponential full jitter", () => {
  assert.equal(retryBackoffMs(0, 1, "work-a"), 0);
  const first = retryBackoffMs(100, 1, "work-a");
  const second = retryBackoffMs(100, 2, "work-a");
  assert.equal(retryBackoffMs(100, 1, "work-a"), first);
  assert.ok(first >= 0 && first <= 1_000);
  assert.ok(second >= 0 && second <= 2_000);
  assert.ok(retryBackoffMs(60_000, 10, "work-a") <= 60_000);
});

test("physical retry identity is deterministic and retains only its own remaining cost", () => {
  const scheduled = {
    ...item,
    scheduling: {
      policy: "critical-path-lpt-v1" as const,
      estimated_duration_ms: 30_000,
      remaining_path_ms: 42_000,
      estimate_source: "history-p75" as const,
      estimate_sample_count: 4,
    },
  };
  const trigger = trial("retry-work", "f", "infrastructure_failure");
  const first = physicalRetryWorkItem(scheduled, 1, [trigger]);
  const replay = physicalRetryWorkItem(scheduled, 1, [trigger]);
  assert.equal(replay.work_id, first.work_id);
  assert.notEqual(first.work_id, scheduled.work_id);
  assert.equal(first.scheduling?.estimated_duration_ms, 30_000);
  assert.equal(first.scheduling?.remaining_path_ms, 30_000);
});

test("retry decisions are durable, idempotent, and transition monotonically", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-retry-state-"));
  t.after(() => forceRemove(root));
  const evalDirectory = path.join(root, "evals", EVAL_ID);
  const trigger = trial("trigger", "a", "infrastructure_failure");
  const first = await ensurePhysicalRetryDecision({
    evalDirectory, evalId: EVAL_ID, item, retryIndex: 1, trigger,
    notBefore: "2026-01-01T00:00:05.000Z", now: "2026-01-01T00:00:00.000Z",
  });
  const replay = await ensurePhysicalRetryDecision({
    evalDirectory, evalId: EVAL_ID, item, retryIndex: 1, trigger,
    notBefore: "2026-01-01T00:01:00.000Z", now: "2026-01-01T00:00:30.000Z",
  });
  assert.deepEqual(replay, first, "a replay must preserve the original persisted backoff");
  await transitionRetryDecision({ evalDirectory, evalId: EVAL_ID, decisionId: first.decision_id, state: "running", now: "2026-01-01T00:00:05.000Z" });
  await transitionRetryDecision({ evalDirectory, evalId: EVAL_ID, decisionId: first.decision_id, state: "repaired", now: "2026-01-01T00:00:06.000Z" });
  await assert.rejects(
    transitionRetryDecision({ evalDirectory, evalId: EVAL_ID, decisionId: first.decision_id, state: "running" }),
    /state transition is invalid/,
  );
  const state = await readEvalRetryState(evalDirectory, EVAL_ID);
  assert.equal(state?.generation, 3);
  assert.equal(state?.decisions[0]?.state, "repaired");
  assert.equal(state?.decisions[0]?.not_before, "2026-01-01T00:00:05.000Z");
});

test("non-retryable provider failures are recorded without physical work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-no-retry-state-"));
  t.after(() => forceRemove(root));
  const evalDirectory = path.join(root, "evals", EVAL_ID);
  const decision = await ensureTerminalRetryDecision({
    evalDirectory, evalId: EVAL_ID, item, retryIndex: 1,
    trigger: trial("quota", "b", "provider_quota_exhausted"), now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(decision?.disposition, "no-retry");
  assert.equal(decision?.state, "skipped");
  assert.equal(decision?.classification.code, "provider_quota_exhausted");
  assert.equal(decision?.retry_work_id, undefined);
});

function trial(suffix: string, runDigit: string, invalidReason: string): EvalTrialRefV1 {
  return {
    trial_id: `trial-${suffix}`, run_id: `run_${runDigit.repeat(32)}`, task_id: "task-a", attempt: 1,
    observation_status: "invalid", invalid_reason: invalidReason,
  };
}
