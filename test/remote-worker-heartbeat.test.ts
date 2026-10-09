import test from "node:test";
import assert from "node:assert/strict";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";

for (const firstFails of [false, true]) {
  test(`worker heartbeats retain publication order after a delayed ${firstFails ? "failed" : "successful"} request`, async () => {
    const requested: string[] = [], published: string[] = [];
    let started!: () => void, release!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const client = new RemoteWorkerHttpClient({
      baseUrl: "http://127.0.0.1:1",
      credential: { schema_version: "1", worker_id: "worker_heartbeat", generation: 1, token: "a".repeat(64) },
      request: async (_url, options) => {
        const health = JSON.parse(String(options?.body)).health as string;
        requested.push(health);
        if (requested.length === 1) {
          started();
          await barrier;
          if (firstFails) throw new Error("injected heartbeat failure");
        }
        published.push(health);
        return new Response("{}", { status: 200 });
      },
    });
    const runner = new RemoteWorkerRunner({
      client,
      capacity: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 },
      execute: async () => { throw new Error("heartbeat must not execute work"); },
    });
    const first = runner.heartbeat("healthy");
    await firstStarted;
    const second = runner.heartbeat("degraded");
    let results!: PromiseSettledResult<void>[];
    try {
      // The second observation must not reach the server while an older
      // request can still overwrite it. No timer or scheduling delay is used.
      assert.deepEqual(requested, ["healthy"]);
    } finally {
      release();
      results = await Promise.allSettled([first, second]);
    }
    assert.deepEqual(results.map(result => result.status), [firstFails ? "rejected" : "fulfilled", "fulfilled"]);
    if (firstFails) assert.match(String((results[0] as PromiseRejectedResult).reason), /injected heartbeat failure/);
    assert.deepEqual(requested, ["healthy", "degraded"]);
    assert.deepEqual(published, firstFails ? ["degraded"] : ["healthy", "degraded"]);
  });
}

test("stopping a worker discards queued heartbeats after the in-flight request settles", async () => {
  const controller = new AbortController();
  let started!: () => void, release!: () => void, requests = 0;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const client = new RemoteWorkerHttpClient({
    baseUrl: "http://127.0.0.1:1",
    credential: { schema_version: "1", worker_id: "worker_heartbeat", generation: 1, token: "a".repeat(64) },
    request: async () => {
      requests++;
      started();
      await barrier;
      return new Response("{}", { status: 200 });
    },
  });
  const runner = new RemoteWorkerRunner({
    client, signal: controller.signal,
    capacity: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 },
    execute: async () => { throw new Error("heartbeat must not execute work"); },
  });
  const first = runner.heartbeat();
  await firstStarted;
  const second = runner.heartbeat();
  controller.abort(new Error("worker stopped"));
  release();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal((results[1] as PromiseRejectedResult).reason, controller.signal.reason);
  assert.equal(requests, 1);
});
