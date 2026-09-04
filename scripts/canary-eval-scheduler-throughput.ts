import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { replaySchedulerTrace, type SchedulerTraceWorkV1 } from "../src/evals/index.js";

interface TraceFixtureV1 {
  schema_version: "1";
  source: { evolution_id: string; round_id: string; captured_at: string; physical_trials: number };
  slots: number;
  meta_agent_duration_ms: number;
  work: Array<SchedulerTraceWorkV1 & { phase: string }>;
}

const fixturePath = path.resolve("test", "fixtures", "eval-scheduler-throughput-trace.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as TraceFixtureV1;
assert.equal(fixture.schema_version, "1");
assert.equal(fixture.source.physical_trials, 142);
assert.equal(fixture.work.length, fixture.source.physical_trials);
assert.equal(fixture.work.reduce((sum, work) => sum + work.duration_ms, 0), 154_958_000);

const phases = ["seed-baseline", "seed-candidate", "heldout-baseline", "heldout-candidate"] as const;
const replay = (selected: readonly string[], policy: "fifo-v1" | "critical-path-v1", retryScheduling: "batch-v1" | "immediate-v1") => replaySchedulerTrace(
  fixture.work.filter((work) => selected.includes(work.phase)).map((work) => ({
    ...work,
    task_id: `${work.phase}:${work.task_id}`,
  })),
  { slots: fixture.slots, policy, retryScheduling },
);
const phaseResults = Object.fromEntries(phases.map((phase) => [phase, {
  fifo_batch_ms: replay([phase], "fifo-v1", "batch-v1").makespan_ms,
  critical_path_batch_ms: replay([phase], "critical-path-v1", "batch-v1").makespan_ms,
  critical_path_immediate_ms: replay([phase], "critical-path-v1", "immediate-v1").makespan_ms,
}]));
const value = (phase: typeof phases[number], field: keyof (typeof phaseResults)[string]): number => phaseResults[phase]![field];
const fifoBatchMs = fixture.meta_agent_duration_ms + phases.reduce((sum, phase) => sum + value(phase, "fifo_batch_ms"), 0);
const criticalPathImmediateMs = fixture.meta_agent_duration_ms + phases.reduce((sum, phase) => sum + value(phase, "critical_path_immediate_ms"), 0);
const firstRunMs = replay(["seed-baseline", "heldout-baseline"], "critical-path-v1", "immediate-v1").makespan_ms
  + fixture.meta_agent_duration_ms
  + value("seed-candidate", "critical_path_immediate_ms")
  + value("heldout-candidate", "critical_path_immediate_ms");
const candidateOnlyMs = fixture.meta_agent_duration_ms
  + value("seed-candidate", "critical_path_immediate_ms")
  + value("heldout-candidate", "critical_path_immediate_ms");

assert.ok(fifoBatchMs <= 555 * 60_000, `FIFO/barrier baseline exceeded 555 minutes: ${minutes(fifoBatchMs)}`);
assert.ok(criticalPathImmediateMs <= 475 * 60_000, `critical-path/immediate replay exceeded 475 minutes: ${minutes(criticalPathImmediateMs)}`);
assert.ok(firstRunMs <= 425 * 60_000, `first-run replay exceeded 425 minutes: ${minutes(firstRunMs)}`);
assert.ok(candidateOnlyMs <= 240 * 60_000, `Candidate-only replay exceeded 240 minutes: ${minutes(candidateOnlyMs)}`);
assert.ok(phases.every((phase) => replay([phase], "critical-path-v1", "immediate-v1").runnable_idle_ms === 0));

process.stdout.write(`${JSON.stringify({
  schema_version: "1",
  source: fixture.source,
  slots: fixture.slots,
  fifo_batch_minutes: minutes(fifoBatchMs),
  critical_path_immediate_minutes: minutes(criticalPathImmediateMs),
  first_run_minutes: minutes(firstRunMs),
  candidate_only_minutes: minutes(candidateOnlyMs),
  phase_results: Object.fromEntries(Object.entries(phaseResults).map(([phase, result]) => [phase, Object.fromEntries(
    Object.entries(result).map(([key, duration]) => [key.replace("_ms", "_minutes"), minutes(duration)]),
  )])),
}, null, 2)}\n`);

function minutes(durationMs: number): number { return Math.round(durationMs / 600) / 100; }
