import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { localInferenceDaemonEnvironment } from "../src/inference/index.js";
import { parseDaemonResourcePolicy } from "../src/cli/commands/daemon.js";
import { ResourceLedger } from "../src/control-plane/index.js";

test("automatic inference daemon admission includes cache disk and detected GPUs", async () => {
  const env = await localInferenceDaemonEnvironment("/state", {}, {
    freeDiskBytes: async () => 16 * 1024 ** 3,
    run: async () => ({ stdout: "GPU 0: H100 (UUID: GPU-a)\nGPU 1: H100 (UUID: GPU-b)\n", stderr: "" }),
  });
  const policy = await parseDaemonResourcePolicy([], 4, { env, detect: async () => ({ cpu_millis: 8000, memory_bytes: 16 * 1024 ** 3 }) });
  const ledger = new ResourceLedger(policy.capacity);
  const lease = ledger.tryAcquire("local-inference", "inference", {
    cpu_millis: 2000, memory_bytes: 2 * 1024 ** 3, container_slots: 1, build_slots: 0,
    gpu_count: 1, ephemeral_disk_bytes: 4 * 1024 ** 3,
  });
  assert.ok(lease, "default daemon must admit the inference lock's disk reservation");
  assert.equal(policy.capacity.gpu_count, 2);
  lease.release();
  assert.equal(ledger.snapshot().allocations.length, 0);
});

test("automatic capacity preserves explicit zero limits and handles absent state directories", async () => {
  const explicit = { HITCH_CAPACITY_GPUS: "0", HITCH_CAPACITY_EPHEMERAL_DISK_MIB: "0" };
  const result = await localInferenceDaemonEnvironment("/state", explicit, {
    freeDiskBytes: async () => { throw new Error("must not probe explicit limits"); },
    run: async () => { throw new Error("must not probe explicit limits"); },
  });
  assert.deepEqual(result, explicit);
  const cpu = await localInferenceDaemonEnvironment(path.join(tmpdir(), `hitch-missing-${process.pid}`, "nested"), {}, {
    run: async () => { throw new Error("no NVIDIA device"); },
  });
  assert.ok(Number.isSafeInteger(Number(cpu.HITCH_CAPACITY_EPHEMERAL_DISK_MIB)));
  assert.equal(cpu.HITCH_CAPACITY_GPUS, undefined);
});
