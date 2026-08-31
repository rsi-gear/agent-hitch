import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createExecutionLease,
  heartbeatExecutionLease,
  markExecutionLeaseLost,
  parseExecutionLease,
  readExecutionLeases,
  recoverExecutionLeases,
  reissueExecutionLease,
} from "../src/evals/index.js";

const reservation = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
const identity = {
  evalId: "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workId: "work_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  worker: {
    workerId: "worker_local_test",
    provider: "local-docker",
    collisionDomainId: "docker:test",
    parentAllocationId: "allocation_cccccccccccccccccccccccccccccccc",
  },
};

test("execution lease persists accepted, running, and released states", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-execution-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await createExecutionLease({ evalDirectory: directory, ...identity, reservation, ttlMs: 60_000 });
  assert.equal(handle.current().state, "accepted");
  assert.equal((await handle.markRunning()).state, "running");
  const released = await handle.release();
  assert.equal(released.state, "released");
  assert.ok(released.terminal_at);
  assert.deepEqual(await readExecutionLeases(directory), [released]);
  assert.equal((await handle.release()).state, "released");
});

test("execution lease heartbeat slides expiry and rejects terminal renewal", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-execution-lease-heartbeat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await createExecutionLease({ evalDirectory: directory, ...identity, reservation, ttlMs: 250 });
  const initial = await handle.markRunning(1);
  await delay(5);
  const renewed = await heartbeatExecutionLease({
    evalDirectory: directory,
    leaseId: handle.leaseId,
    expectedEpoch: 1,
    ttlMs: 500,
  });
  assert.ok(Date.parse(renewed.heartbeat_at as string) > Date.parse(initial.heartbeat_at as string));
  assert.ok(Date.parse(renewed.expires_at) > Date.parse(initial.expires_at));
  await handle.release(1);
  await assert.rejects(
    heartbeatExecutionLease({ evalDirectory: directory, leaseId: handle.leaseId, expectedEpoch: 1 }),
    (error: unknown) => (error as { code?: string }).code === "lease_not_active",
  );
});

test("reissuing a proven-live lease increments epoch and fences the old worker", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-execution-lease-reissue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldWorker = await createExecutionLease({ evalDirectory: directory, ...identity, reservation, ttlMs: 60_000 });
  await oldWorker.markRunning(1);
  const recovered = await reissueExecutionLease({
    evalDirectory: directory,
    leaseId: oldWorker.leaseId,
    expectedEpoch: 1,
  });
  assert.equal(recovered.state, "running");
  assert.equal(recovered.epoch, 2);
  await assert.rejects(oldWorker.heartbeat(1), (error: unknown) => (error as { code?: string }).code === "lease_epoch_mismatch");
  await assert.rejects(oldWorker.release(1), (error: unknown) => (error as { code?: string }).code === "lease_epoch_mismatch");
  assert.equal((await heartbeatExecutionLease({
    evalDirectory: directory,
    leaseId: oldWorker.leaseId,
    expectedEpoch: 2,
  })).epoch, 2);
  const lost = await markExecutionLeaseLost({ evalDirectory: directory, leaseId: oldWorker.leaseId, expectedEpoch: 2 });
  assert.equal(lost.state, "lost");
  assert.equal(lost.epoch, 3);
});

test("recovery marks active execution leases lost without changing terminal leases", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-execution-lease-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = await createExecutionLease({ evalDirectory: directory, ...identity, reservation, ttlMs: 60_000 });
  await active.markRunning();
  const terminal = await createExecutionLease({
    evalDirectory: directory,
    ...identity,
    workId: "work_dddddddddddddddddddddddddddddddd",
    reservation,
    ttlMs: 60_000,
  });
  await terminal.release();
  const recovered = await recoverExecutionLeases(directory);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.lease_id, active.leaseId);
  assert.equal(recovered[0]?.state, "lost");
  assert.equal(recovered[0]?.epoch, 2);
  await assert.rejects(active.heartbeat(1), (error: unknown) => (error as { code?: string }).code === "lease_epoch_mismatch");
  assert.deepEqual((await readExecutionLeases(directory)).map((lease) => lease.state).sort(), ["lost", "released"]);
});

test("execution lease parser rejects terminal state without terminal timestamp", () => {
  const now = new Date().toISOString();
  assert.throws(() => parseExecutionLease({
    schema_version: "1",
    lease_id: "lease_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    work_id: identity.workId,
    eval_id: identity.evalId,
    worker_id: identity.worker.workerId,
    provider: identity.worker.provider,
    collision_domain_id: identity.worker.collisionDomainId,
    reservation,
    state: "lost",
    epoch: 1,
    issued_at: now,
    expires_at: now,
  }), /terminal state is inconsistent/);
});
