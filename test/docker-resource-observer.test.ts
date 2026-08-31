import test from "node:test";
import assert from "node:assert/strict";
import { dockerOwnershipLabelMap } from "../src/evals/docker-ownership.js";
import { parseDockerMemoryBytes, parseExecutionEvidence, startDockerResourceObserver } from "../src/evals/index.js";

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
  const labels = dockerOwnershipLabelMap(ownership);
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
  assert.deepEqual(terminal.observed.unavailable_fields, ["cpu_time_ns"]);
  assert.deepEqual(parseExecutionEvidence(terminal), terminal);
});

test("Docker memory parsing is explicit about supported units", () => {
  assert.equal(parseDockerMemoryBytes("1.5GiB / 2GiB"), 1.5 * 1024 ** 3);
  assert.equal(parseDockerMemoryBytes("750kB / 1GB"), 750_000);
  assert.equal(parseDockerMemoryBytes("unknown"), null);
});
