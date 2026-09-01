import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { harborPhaseTimingEvents } from "../src/evals/harbor-phase-timings.js";
import { forceRemove } from "../test-support/helpers.js";

test("Harbor phase timing evidence exposes setup, Agent, and Verifier durations without trusting unsafe files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-timings-"));
  t.after(() => forceRemove(root));
  const trial = "task-a__attempt-1";
  const directory = path.join(root, trial);
  await Promise.all([mkdir(path.join(directory, "agent"), { recursive: true }), mkdir(path.join(directory, "verifier"), { recursive: true })]);
  const completedAt = new Date().toISOString();
  await writeFile(path.join(directory, "agent", "hitch-phase-timings.json"), JSON.stringify({
    schema_version: "1", phases: { setup: { duration_ms: 12, completed_at: completedAt }, agent: { duration_ms: 34, completed_at: completedAt } },
  }));
  await writeFile(path.join(directory, "verifier", "hitch-phase-timings.json"), JSON.stringify({
    schema_version: "1", phases: { verifier: { duration_ms: 56, completed_at: completedAt } },
  }));
  const raw = { trial_results: [{ task_name: "task-a", trial_name: trial }] };
  assert.deepEqual(await harborPhaseTimingEvents(root, raw), [
    { type: "eval.setup.completed", trial_id: trial, task_id: "task-a", duration_ms: 12 },
    { type: "eval.agent.completed", trial_id: trial, task_id: "task-a", duration_ms: 34 },
    { type: "eval.verifier.completed", trial_id: trial, task_id: "task-a", duration_ms: 56 },
  ]);

  const external = path.join(root, "external.json");
  await writeFile(external, JSON.stringify({ schema_version: "1", phases: {} }));
  await forceRemove(path.join(directory, "verifier", "hitch-phase-timings.json"));
  await symlink(external, path.join(directory, "verifier", "hitch-phase-timings.json"));
  const unsafe = await harborPhaseTimingEvents(root, raw);
  assert.ok(unsafe.some((event) => event.type === "eval.phase-timing.invalid" && event.phase_source === "verifier"));
});
