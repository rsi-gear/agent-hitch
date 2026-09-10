import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RemoteWorkerHttpClient, remoteExecutionBindingDigest } from "../src/control-plane/index.js";
import { sha256JSON, statePaths } from "../src/foundation/index.js";

import { workerAdmissionFixture as fixture } from "../test-support/worker-admission.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("authenticated acceptance preserves original v1 identity and admits one immutable execution process", async t => {
  const f = await fixture(t);
  const accepted = await f.client.accept(f.offer, f.ownership, f.receipt.sent_at);
  const admitted = (await f.admission())!;
  assert.equal(admitted.execution_process, null);
  assert.equal(admitted.ownership_digest, sha256JSON(f.ownership));
  assert.equal(accepted.accept_receipt_digest, sha256JSON(f.receipt));
  assert.equal(remoteExecutionBindingDigest(accepted), remoteExecutionBindingDigest(f.offer));
  await f.client.authorizeProcess(accepted, f.ownership, f.executionProcess);
  await f.client.authorizeProcess(accepted, f.ownership, f.executionProcess);
  assert.deepEqual((await f.admission())!.execution_process, f.executionProcess);
  assert.deepEqual(await f.client.accept(f.offer, f.ownership, f.receipt.sent_at), accepted);
  assert.equal((await f.protocol.getOffer(f.offer.worker_id, f.offer.offer_id))!.schema_version, "1");
  await assert.rejects(f.protocol.acceptOffer(f.offer.worker_id, f.receipt), /downgraded/);
  await assert.rejects(f.protocol.acceptOffer(f.offer.worker_id, f.receipt, { ...f.ownership, docker_engine_id: "replaced" }), /cannot be replaced/);
  await assert.rejects(f.protocol.authorizeExecutionProcess(f.offer.worker_id, f.offer.offer_id, 1, sha256JSON(f.ownership), { ...f.executionProcess, pid: 1003 }), /cannot be replaced/);
  await assert.rejects(f.protocol.authorizeExecutionProcess(f.offer.worker_id, f.offer.offer_id, 1, sha256JSON("wrong owner"), f.executionProcess), /matching execution admission/);
  assert.deepEqual((await f.admission())!.execution_process, f.executionProcess);
});

test("legacy accepted offers cannot acquire retrospective ownership or process authority", async t => {
  const f = await fixture(t);
  await assert.rejects(f.authorize(), /original accepted generation/);
  await f.protocol.acceptOffer(f.offer.worker_id, f.receipt);
  await assert.rejects(f.accept(), /cannot be attached after acceptance/);
  await assert.rejects(f.authorize(), /matching execution admission/);
  assert.equal(await f.admission(), null);
});

test("accept retry repairs publication interrupted after durable admission without changing its timestamp", async t => {
  const f = await fixture(t), index = path.join(statePaths(f.root).workerProtocol, "leases", `${f.lease.lease_id}.json`);
  await mkdir(index, { recursive: true });
  await assert.rejects(f.accept());
  const admitted = (await f.admission())!;
  assert.equal(admitted.execution_process, null);
  assert.equal((await f.protocol.getOffer(f.offer.worker_id, f.offer.offer_id))!.state, "offered");
  await assert.rejects(f.authorize(), /original accepted generation/);
  await rm(index, { recursive: true });
  const accepted = await f.accept();
  assert.equal(accepted.accepted_at, admitted.accepted_at);
  assert.deepEqual(await f.admission(), admitted);
  assert.equal(JSON.parse(await readFile(index, "utf8")).offer_id, accepted.offer_id);
});

for (const operation of ["accept", "process"] as const) {
  test(`generation rotation fences ${operation} admission while waiting to publish`, async t => {
    const f = await fixture(t); if (operation === "process") await f.accept();
    const before = await f.admission(), original = await f.protocol.getOffer(f.offer.worker_id, f.offer.offer_id);
    const entered = deferred(), resume = deferred();
    f.registry.beforePublication = async () => { entered.resolve(); await resume.promise; };
    const pending = operation === "accept" ? f.accept() : f.authorize();
    const rejected = assert.rejects(pending, error => (error as { code?: string }).code === "worker_generation_mismatch"); void rejected.catch(() => {});
    try { await entered.promise; await f.registry.register(f.registration); } finally { resume.resolve(); }
    await rejected;
    assert.deepEqual(await f.admission(), before);
    assert.deepEqual(await f.protocol.getOffer(f.offer.worker_id, f.offer.offer_id), original);
  });

  test(`old authenticated bearer cannot claim a fresh generation in a slow ${operation} request`, async t => {
    const f = await fixture(t); if (operation === "process") await f.accept();
    const before = await f.admission(), authenticated = deferred(); f.registry.onAuthenticated = authenticated.resolve;
    const body = JSON.stringify(operation === "accept"
      ? { schema_version: "2", offer_id: f.offer.offer_id, generation: 2, nonce: f.offer.nonce, sent_at: f.receipt.sent_at, ownership: f.ownership }
      : { schema_version: "2", offer_id: f.offer.offer_id, generation: 2, ownership_digest: sha256JSON(f.ownership), process: f.executionProcess });
    let request!: http.ClientRequest;
    const response = new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      request = http.request(`${f.baseUrl}/v2/workers/${f.offer.worker_id}/offers/${f.offer.offer_id}/${operation}`, {
        method: "POST", headers: { authorization: `Bearer ${f.registered.token}`, "content-length": Buffer.byteLength(body), "content-type": "application/json" },
      }, incoming => { let text = ""; incoming.on("data", chunk => { text += chunk; }); incoming.once("end", () => resolve({ status: incoming.statusCode, text })); incoming.once("error", reject); });
      request.once("error", reject); request.write(body.slice(0, 5));
    });
    void response.catch(() => {}); t.after(() => { request.destroy(); });
    await authenticated.promise; await f.registry.register(f.registration); request.end(body.slice(5));
    const result = await response;
    assert.equal(result.status, 409); assert.equal(JSON.parse(result.text).error.code, "worker_generation_mismatch");
    assert.deepEqual(await f.admission(), before);
  });
}

test("completed work and a newer credential cannot authorize a late original Harbor launch", async t => {
  const f = await fixture(t); await f.accept();
  const { accepted: _, ...receipt } = f.receipt;
  await f.protocol.completeOffer(f.offer.worker_id, { ...receipt, lease_id: f.lease.lease_id, epoch: 1, status: "failed", artifacts: [] });
  await assert.rejects(f.authorize(), /original accepted generation/);
  await f.registry.register(f.registration);
  await assert.rejects(f.protocol.authorizeExecutionProcess(f.offer.worker_id, f.offer.offer_id, 2, sha256JSON(f.ownership), f.executionProcess), /original accepted generation/);
  assert.equal((await f.admission())!.execution_process, null);
});

test("ownership schema and parser reject unbound or private fields", async t => {
  const f = await fixture(t); await f.accept();
  const admission = (await f.admission())!;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(JSON.parse(await readFile(new URL("../../docs/schemas/remote-worker-execution-admission.schema.json", import.meta.url), "utf8")));
  assert.equal(validate(admission), true, ajv.errorsText(validate.errors));
  await f.authorize(); assert.equal(validate(await f.admission()), true, ajv.errorsText(validate.errors));
  for (const ownership of [{ ...f.ownership, private_root: "/private/root" }, { ...f.ownership, binding_digest: sha256JSON("other offer") },
    { ...f.ownership, worker_process: { ...f.ownership.worker_process, token: "private" } }]) {
    await assert.rejects(f.protocol.acceptOffer(f.offer.worker_id, f.receipt, ownership));
  }
  assert.equal(validate({ ...admission, ownership: { ...f.ownership, private_root: "/private/root" } }), false);
  assert.equal(validate({ ...admission, execution_process: { ...f.executionProcess, start_identity: undefined } }), false);
  assert.equal(validate({ ...admission, schema_version: "1" }), false);
});

test("client refuses cacheable or substituted admission and process responses before granting a launch", async t => {
  const f = await fixture(t), accepted = await f.accept();
  for (const action of ["accept", "process"] as const) for (const corrupt of ["cache", "ownership", "process"] as const) {
    const client = new RemoteWorkerHttpClient({ baseUrl: f.baseUrl,
      credential: { schema_version: "1", worker_id: f.offer.worker_id, generation: 1, token: f.registered.token },
      request: async (url, init) => {
        const response = await fetch(url, init), body = await response.json() as { admission: Record<string, unknown> };
        const headers = new Headers(response.headers);
        if (corrupt === "cache") headers.delete("cache-control");
        if (corrupt === "ownership") body.admission.ownership_digest = sha256JSON("other ownership");
        if (corrupt === "process") body.admission.execution_process = { ...f.executionProcess, pid: f.ownership.worker_process.pid };
        return new Response(JSON.stringify(body), { status: response.status, headers });
      } });
    await assert.rejects(action === "accept" ? client.accept(f.offer, f.ownership, f.receipt.sent_at) : client.authorizeProcess(accepted, f.ownership, f.executionProcess));
  }
});
