import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResourceDelivery, exportResourceBundle, hash, identity, importResourceBundle, parseResourceDelivery, receiveResourceDelivery, ResourceStore, selectResources, type ResourceDelivery, type ResourceObjectReader } from "../src/resources/index.js";
import { FixtureImageProvider, resourceFixture } from "../test-support/resource-fixture.js";

function sealDelivery(delivery: ResourceDelivery): ResourceDelivery {
  const { digest: _digest, ...body } = delivery;
  return { ...body, digest: identity(body.protocol, body) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("delivery rejects missing, duplicate, undeclared and substituted OCI identities before side effects", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-transfer-closure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, dataset } = await resourceFixture(directory, 1);
  const delivery = await createResourceDelivery(store, selectResources(dataset, ["task-0"]), "sender", 1);
  const image = delivery.images[0]!;
  const extra = { ...image, resource: { ...image.resource, manifestDigest: hash("undeclared image") }, reference: `example.test/extra@${hash("undeclared image")}` };
  const cases = [
    { label: "missing", images: [] },
    { label: "duplicate", images: [image, image] },
    { label: "undeclared", images: [image, extra] },
    { label: "platform", images: [{ ...image, resource: { ...image.resource, platform: "linux/arm64" } }] },
    { label: "index", images: [{ ...image, resource: { ...image.resource, indexDigest: hash("another index") } }] },
  ];
  for (const item of cases) {
    const malformed = sealDelivery({ ...delivery, images: item.images });
    assert.throws(() => parseResourceDelivery(malformed), /delivery images.*selection/, item.label);
    const provider = new FixtureImageProvider(); let reads = 0;
    const receiver = new ResourceStore(path.join(directory, item.label), { images: provider, limits: { minFreeBytes: 0 } });
    await assert.rejects(receiveResourceDelivery(receiver, malformed, async () => { reads++; return (async function* () {})(); }, "receiver", 1), /delivery images.*selection/);
    assert.equal(provider.calls, 0); assert.equal(reads, 0);
  }
});

test("offline bundle rejects extra OCI archives before invoking its image provider", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-bundle-closure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, dataset } = await resourceFixture(directory, 1), bundle = path.join(directory, "bundle");
  const index = await exportResourceBundle(store, selectResources(dataset, ["task-0"]), bundle, "sender");
  const extraDigest = hash("undeclared image"), originalImage = index.delivery.images[0]!, archive = index.archives[0]!;
  const extra = { ...originalImage, resource: { ...originalImage.resource, manifestDigest: extraDigest }, reference: `example.test/extra@${extraDigest}` };
  const delivery = sealDelivery({ ...index.delivery, images: [...index.delivery.images, extra] });
  const body = { protocol: index.protocol, delivery, archives: [...index.archives, { ...archive, manifestDigest: extraDigest }] };
  await writeFile(path.join(bundle, "oci", extraDigest.slice(7)), await readFile(path.join(bundle, "oci", archive.manifestDigest.slice(7))));
  await writeFile(path.join(bundle, "index.json"), JSON.stringify({ ...body, digest: identity(body.protocol, body) }));
  let validations = 0, imports = 0;
  const provider = new FixtureImageProvider();
  provider.validateArchive = async () => { validations++; return { expandedBytes: 0, files: 0 }; };
  provider.importArchive = async () => { imports++; };
  const receiver = new ResourceStore(path.join(directory, "receiver"), { images: provider, limits: { minFreeBytes: 0 } });
  await assert.rejects(importResourceBundle(receiver, bundle, "receiver"), /delivery images.*selection/);
  assert.equal(validations, 0); assert.equal(imports, 0); assert.equal(provider.calls, 0);
});

for (const phase of ["reader", "iterator"] as const) test(`cancellation interrupts a stalled ${phase} and releases the store lock`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-transfer-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, dataset } = await resourceFixture(directory, 1);
  const delivery = await createResourceDelivery(store, selectResources(dataset, ["task-0"]), "sender", 1);
  const receiver = new ResourceStore(path.join(directory, "receiver"), { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  const entered = deferred(), unblock = deferred(), abort = new AbortController();
  let returned = false;
  const stream: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() { return this; },
    async next() { entered.resolve(); await unblock.promise; return { done: true, value: undefined }; },
    // An uncooperative cleanup must not retain the destination lock either.
    async return() { returned = true; await unblock.promise; return { done: true, value: undefined }; },
  };
  const reader: ResourceObjectReader = async (_item, signal) => {
    assert.ok(signal);
    if (phase === "reader") { entered.resolve(); await unblock.promise; }
    return stream;
  };
  const operation = receiveResourceDelivery(receiver, delivery, reader, "receiver", 1, abort.signal)
    .then(() => ({ error: undefined }), error => ({ error }));
  await entered.promise;
  const reason = new Error(`cancel stalled ${phase}`); abort.abort(reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("transfer ignored cancellation")), 1000); })]);
    assert.equal(result.error, reason);
    assert.deepEqual(await readdir(path.join(receiver.directory, "staging")), []);
    await receiver.locked(async () => {});
    if (phase === "iterator") assert.equal(returned, true);
    await assert.rejects(receiver.objects.verify(delivery.objects[0]!.digest), /ENOENT/);
  } finally {
    clearTimeout(timer); unblock.resolve(); await operation;
  }
});
