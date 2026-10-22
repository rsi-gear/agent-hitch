import test from "node:test";
import assert from "node:assert/strict";
import { dockerOwnershipLabelMap } from "../src/evals/docker-ownership.js";
import { parseDockerEngineContainerStats, parseDockerMemoryBytes, parseExecutionEvidence, startDockerResourceObserver } from "../src/evals/index.js";

const ownership = {
  root_id: "a".repeat(24),
  provider: "local-docker" as const,
  eval_id: `eval_${"b".repeat(32)}`,
  work_id: `work_${"c".repeat(32)}`,
  lease_id: `lease_${"d".repeat(32)}`,
  lease_epoch: 2,
  task_id: "task-a",
};
const reservation = { cpu_millis: 2_500, memory_bytes: 2_000_000, container_slots: 2, build_slots: 0 };

test("Docker observer records bounded peak memory, OOM, and exit evidence without inventing CPU time", async () => {
  const id = "e".repeat(64);
  const labels = { ...dockerOwnershipLabelMap(ownership), "com.docker.compose.service": "main", "io.hitch.environment-role": "verifier" };
  let inspections = 0;
  const observer = startDockerResourceObserver({
    ownership,
    workerId: "worker-local",
    collisionDomainId: "docker-engine-local",
    reservation,
    mainLimits: { cpu_millis: 2_000, memory_bytes: 1024 * 1024, container_slots: 1, build_slots: 0 },
    sidecarLimits: { database: { cpu_millis: 500, memory_bytes: 512 * 1024 } },
    intervalMs: 60_000,
    run: async (args) => {
      if (args[0] === "container" && args[1] === "ls") return { stdout: `${id.slice(0, 12)}\n` };
      if (args[0] === "container" && args[1] === "inspect") {
        inspections += 1;
        return { stdout: JSON.stringify([{
          Id: id, Name: "/task-main", Image: `sha256:${"f".repeat(64)}`, Config: { Labels: labels, Image: `registry.test/task@sha256:${"a".repeat(64)}` },
          State: inspections === 1
            ? { Running: true, OOMKilled: false, ExitCode: 0, Error: "" }
            : { Running: false, OOMKilled: true, ExitCode: 137, Error: "" },
        }]) };
      }
      if (args[0] === "container" && args[1] === "stats") return { stdout: `${JSON.stringify({ MemUsage: "12.5MiB / 1GiB" })}\n` };
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    },
  });
  const running = await observer.capture();
  assert.equal(running.observed.status, "partial");
  assert.equal(running.observed.containers[0]?.peak_memory_bytes, 12.5 * 1024 * 1024);
  const terminal = await observer.stop();
  assert.equal(terminal.observed.containers[0]?.oom_killed, true);
  assert.equal(terminal.observed.containers[0]?.exit_code, 137);
  assert.equal(terminal.observed.containers[0]?.exit_reason, "oom-killed");
  assert.equal(terminal.observed.containers[0]?.image_config_digest, `sha256:${"f".repeat(64)}`);
  assert.equal(terminal.observed.containers[0]?.service, "main");
  assert.equal(terminal.observed.containers[0]?.role, "verifier");
  assert.deepEqual(terminal.observed.unavailable_fields, ["cpu_time_ns"]);
  assert.deepEqual(parseExecutionEvidence(terminal), terminal);
});

test("Docker memory parsing is explicit about supported units", () => {
  assert.equal(parseDockerMemoryBytes("1.5GiB / 2GiB"), 1.5 * 1024 ** 3);
  assert.equal(parseDockerMemoryBytes("750kB / 1GB"), 750_000);
  assert.equal(parseDockerMemoryBytes("unknown"), null);
});

test("Docker observer records monotonic cumulative CPU time from the Engine stats API", async () => {
  const id = "f".repeat(64);
  const labels = dockerOwnershipLabelMap(ownership);
  const cpuSamples = [125_000, 375_000];
  const observer = startDockerResourceObserver({
    ownership,
    workerId: "worker-local",
    collisionDomainId: "docker-engine-local",
    reservation,
    mainLimits: { cpu_millis: 2_000, memory_bytes: 1024 * 1024, container_slots: 1, build_slots: 0 },
    sidecarLimits: {},
    intervalMs: 60_000,
    engineStats: async () => ({ cpu_time_ns: cpuSamples.shift() ?? 250_000, memory_bytes: 1_500_000 }),
    run: async (args) => {
      if (args[0] === "container" && args[1] === "ls") return { stdout: `${id}\n` };
      if (args[0] === "container" && args[1] === "inspect") return { stdout: JSON.stringify([{
        Id: id, Name: "/cpu-task", Image: `sha256:${"a".repeat(64)}`,
        Config: { Labels: labels, Image: "cpu-task:test" },
        State: { Running: true, OOMKilled: false, ExitCode: 0, Error: "" },
      }]) };
      if (args[0] === "container" && args[1] === "stats") return { stdout: `${JSON.stringify({ MemUsage: "1MiB / 2MiB" })}\n` };
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    },
  });
  const first = await observer.capture();
  assert.equal(first.observed.containers[0]?.cpu_time_ns, 125_000);
  const second = await observer.stop();
  assert.equal(second.observed.containers[0]?.cpu_time_ns, 375_000);
  assert.equal(second.observed.unavailable_fields.includes("cpu_time_ns"), false);
});

test("Docker Engine stats parser accepts only safe cumulative nanoseconds", () => {
  assert.deepEqual(parseDockerEngineContainerStats({
    cpu_stats: { cpu_usage: { total_usage: 123_456 } }, memory_stats: { usage: 654_321 },
  }), { cpu_time_ns: 123_456, memory_bytes: 654_321 });
  assert.deepEqual(parseDockerEngineContainerStats({ cpu_stats: {} }), {});
  assert.deepEqual(parseDockerEngineContainerStats({ memory_stats: { usage: 0, max_usage: 0 }, read: "2026-10-21T00:00:00.000Z" }),
    { memory_bytes: 0, kernel_peak_bytes: 0, read_at: "2026-10-21T00:00:00.000Z" });
  assert.deepEqual(parseDockerEngineContainerStats({ memory_stats: { usage: 10, max_usage: 0 } }), { memory_bytes: 10 });
  assert.throws(() => parseDockerEngineContainerStats({ cpu_stats: { cpu_usage: { total_usage: -1 } } }), /cumulative CPU time/);
  assert.throws(() => parseDockerEngineContainerStats({ memory_stats: { max_usage: -1 } }), /memory peak/);
});

test("Docker observer retries a transient list failure and retains redacted diagnostics", async () => {
  let calls = 0;
  const id = "e".repeat(64);
  const observer = startDockerResourceObserver({
    ownership, workerId: "local", collisionDomainId: "docker", reservation, mainLimits: reservation,
    sidecarLimits: {}, intervalMs: 60_000, env: { OPENAI_API_KEY: "private-observer-secret" },
    run: async (args) => {
      if (args[1] === "ls") {
        calls += 1;
        if (calls === 1) throw new Error("Docker timeout private-observer-secret");
        return { stdout: id };
      }
      return { stdout: JSON.stringify([{
        Id: id, Image: `sha256:${"f".repeat(64)}`, Config: { Labels: dockerOwnershipLabelMap(ownership) },
        State: { Running: false, ExitCode: 0 },
      }]) };
    },
  });
  try {
    const snapshot = await observer.capture();
    assert.equal(snapshot.observed.containers[0]?.image_config_digest, `sha256:${"f".repeat(64)}`);
    assert.ok(snapshot.observed.sample_count > 0);
    assert.match(snapshot.observed.issues.join(" "), /Docker timeout/);
    assert.ok(!JSON.stringify(snapshot).includes("private-observer-secret"));
  } finally { await observer.stop(); }
});

test("Docker observer bounds retries per sample without permanently disabling later captures", async () => {
  let calls = 0;
  let healthy = false;
  const observer = startDockerResourceObserver({
    ownership, workerId: "local", collisionDomainId: "docker", reservation, mainLimits: reservation,
    sidecarLimits: {}, intervalMs: 60_000,
    run: async () => { calls += 1; if (!healthy) throw new Error("temporarily unavailable"); return { stdout: "" }; },
  });
  const failed = await observer.capture();
  assert.equal(calls, 3);
  assert.equal(failed.observed.sample_count, 0);
  assert.equal(failed.observed.memory?.attempted_cycles, 3);
  assert.equal(failed.observed.memory?.gaps.filter(gap => gap.reason === "poll-failed").length, 3);
  healthy = true;
  const recovered = await observer.capture();
  assert.equal(recovered.observed.sample_count, 1);
  assert.equal(recovered.observed.memory?.attempted_cycles, 4);
  await observer.stop();
  const stoppedCalls = calls;
  await observer.capture();
  await observer.stop();
  assert.equal(calls, stoppedCalls);
});
