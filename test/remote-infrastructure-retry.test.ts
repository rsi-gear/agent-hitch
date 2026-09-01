import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest, EvalTrialRefV1 } from "../src/domain/index.js";
import { buildEvalExecutionPlan, createEvalProgress, mergeEvalProgressTrial, runRemoteInfrastructureRetries, validateEvalId } from "../src/evals/index.js";
import type { EvalEventSink, EvalRemoteWorkExecutor } from "../src/evals/index.js";
import { forceRemove } from "../test-support/helpers.js";

const EVAL_ID = validateEvalId("eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const REQUEST: EvalRequest = {
  schema_version: "1", backend: "harbor", dataset: "demo@1.0", harness_ref: "pi@version:1.2.3",
  model: "", attempts: 1, max_concurrent: 1, infrastructure_retries: 1,
  infrastructure_retry_backoff_ms: 0, timeout_ms: 900_000, setup_timeout_ms: 1_800_000,
  agent_args: [], pass_env: [], benchmark_id: "demo", benchmark_revision: "1.0",
};

test("physical infrastructure retry stays on the remote provider with a new work and lease", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-infra-retry-"));
  t.after(() => forceRemove(root));
  const evalDirectory = path.join(root, "evals", EVAL_ID);
  const plan = buildEvalExecutionPlan({
    evalId: EVAL_ID, request: REQUEST, tasks: ["task-a"], workItemMode: "task-slots",
    candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    maxParallelism: 1,
    provider: "remote-docker",
    trialResources: { cpu_millis: 1_000, memory_bytes: 1_024, container_slots: 1, build_slots: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const item = plan.work_items[0];
  assert.ok(item);
  const failed = trial("old", "a", "invalid");
  const repaired = trial("new", "b", "valid");
  const progress = mergeEvalProgressTrial(createEvalProgress({
    evalId: EVAL_ID, benchmarkId: "demo", benchmarkRevision: "1.0", plannedTasks: 1,
    plannedTrials: 1, startedAt: "2026-01-01T00:00:00.000Z",
  }), failed);
  const states: Array<{ workId: string; leaseId: string; state: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  let remoteCalls = 0;
  const backend = {
    backend: {
      name: "harbor", executable: "remote-worker:worker-a", version: "0.21.0", identity: "remote",
      config_path: "job.json", result_path: "result.json", stdout_path: "stdout.log", stderr_path: "stderr.log",
      process_exit_code: 0, signal: null, job_directory: "job",
    }, rawResult: { trials: [] }, summary: {},
  };
  const options = {
    evalId: EVAL_ID, evalDirectory, root, request: REQUEST, plan,
    resolvedRevision: {}, preparedArtifact: {}, controllerRuntime: { directory: "runtime", runtime_id: "runtime-test" },
    env: {}, worker: {}, sink: { emit: (event: Record<string, unknown>) => { events.push(event); } } as EvalEventSink,
    onWorkItemState: async (workId: string, leaseId: string, state: "running" | "terminal") => { states.push({ workId, leaseId, state }); },
    remoteWorkExecutor: async (input: Parameters<EvalRemoteWorkExecutor>[0]) => {
      remoteCalls += 1;
      assert.notEqual(input.workItem.work_id, item.work_id);
      assert.equal(input.workItem.provider, "remote-docker");
      await input.onLeaseState("lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "running");
      await input.publish(repaired);
      await input.onLeaseState("lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "terminal");
      return { leaseId: "lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", refs: [repaired], run: backend };
    },
  };
  const result = await runRemoteInfrastructureRetries({
    options: options as never, item, progress,
    initial: { attempt: 1, workId: item.work_id, tasks: ["task-a"], refs: [failed], leaseId: "lease_old", run: backend },
  });

  assert.equal(remoteCalls, 1);
  assert.deepEqual(result.progress.trials, [repaired]);
  assert.equal(result.runs[0]?.workId, states[0]?.workId);
  assert.notEqual(result.runs[0]?.workId, item.work_id);
  assert.equal(result.runs[0]?.leaseId, "lease_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(states.map(({ state }) => state), ["running", "terminal"]);
  assert.ok(events.some((event) => event.type === "eval.infrastructure-retry.repaired"));
});

function trial(suffix: string, runDigit: string, status: "valid" | "invalid"): EvalTrialRefV1 {
  return {
    trial_id: `trial-${suffix}`, run_id: `run_${runDigit.repeat(32)}`, task_id: "task-a", attempt: 1,
    observation_status: status, ...(status === "valid" ? { reward: 1 } : { invalid_reason: "infrastructure_failure" }),
  };
}
