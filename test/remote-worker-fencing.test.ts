import test from "node:test";
import assert from "node:assert/strict";
import { RemoteWorkerHttpClient } from "../src/control-plane/index.js";

const credential = { schema_version: "1" as const, worker_id: "worker_fencing", generation: 1, token: "a".repeat(64) };
const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };

test("HTTP 401 fences other in-flight requests without waiting for an error body", async () => {
  let requests = 0, cancelled = false, pendingAborted = false;
  const client = new RemoteWorkerHttpClient({ baseUrl: "http://worker.test", credential,
    request: async (_url, init) => {
      requests++;
      if (requests === 1) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { pendingAborted = true; reject(init!.signal!.reason); }, { once: true });
      });
      return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 401 });
    } });
  const pending = assert.rejects(client.listOffers());
  await assert.rejects(client.heartbeat(zero, [], "healthy"), { code: "remote_worker_fenced" });
  await pending;
  assert.equal(cancelled, true); assert.equal(pendingAborted, true); assert.equal(client.fencedSignal.aborted, true);
  await assert.rejects(client.listOffers(), { code: "remote_worker_fenced" }); assert.equal(requests, 2);
});

for (const [status, code] of [[409, "worker_generation_mismatch"], [403, "worker_revoked"]] as const) {
  test(`structured ${code} fences the worker and redacts its bearer`, async () => {
    const client = new RemoteWorkerHttpClient({ baseUrl: "http://worker.test", credential,
      request: async () => new Response(JSON.stringify({ error: { code, message: `denied ${credential.token}` } }), { status }) });
    await assert.rejects(client.listOffers(), error => {
      assert.equal((error as { code: string }).code, "remote_worker_fenced");
      assert.equal((error as Error).message.includes(credential.token), false); return true;
    });
    assert.equal(client.fencedSignal.aborted, true);
  });
}

for (const status of [0, 400, 403, 409, 503]) {
  test(`transient or work-scoped error ${status} does not revoke the worker generation`, async () => {
    let requests = 0;
    const client = new RemoteWorkerHttpClient({ baseUrl: "http://worker.test", credential, request: async () => {
      if (++requests > 1) return new Response(JSON.stringify({ schema_version: "1", offers: [] }));
      if (status === 0) throw new Error("connection reset");
      return new Response(JSON.stringify({ error: { code: "remote_model_binding_invalid", message: "work unavailable" } }), { status });
    } });
    await assert.rejects(client.listOffers()); assert.equal(client.fencedSignal.aborted, false);
    assert.deepEqual(await client.listOffers(), []);
  });
}
