import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExecutionLease, parseExecutionLease, readExecutionLeases, recoverExecutionLeases } from "../src/evals/index.js";

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
