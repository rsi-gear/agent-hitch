import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportRegistryBundle, importRegistryBundle, verifyRegistryManifest, validateRegistryBundle, localRegistry } from "../src/resources/oci-registry-bundle.js";
import { DockerResourceImageProvider, hash } from "../src/resources/index.js";
import { ociBundle, pax, tar, tarEntry } from "../test-support/oci-layer-fixture.js";
import { DockerRegistryResolver } from "../src/images/index.js";
import { DEFAULT_RESOURCE_LIMITS } from "../src/resources/object-store.js";

test("offline OCI transport preserves exact manifest/blob bytes and validates before registry publication", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-oci-bundle-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const { config, blobs, manifest } = ociBundle([tar(tarEntry("data", Buffer.from("image data")))]);
  const image = { kind: "oci-image" as const, manifestDigest: hash(manifest), platform: "linux/amd64" }, uploaded = new Map<string, Buffer>(); let publications = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET') { const body = url.pathname.includes('/manifests/') ? Buffer.from(manifest) : blobs.get(url.pathname.split('/').at(-1)! as `sha256:${string}`); response.writeHead(body ? 200 : 404).end(body); }
    else if (request.method === 'HEAD') response.writeHead(uploaded.has(url.pathname.split('/').at(-1)!) ? 200 : 404).end();
    else if (request.method === 'POST') response.writeHead(202, { location: '/v2/test/blobs/uploads/one' }).end();
    else if (request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks);
      if (url.pathname.includes('/manifests/')) { assert.equal(bytes.toString(), manifest); publications++; }
      else { assert.equal(hash(bytes), url.searchParams.get('digest')); uploaded.set(hash(bytes), bytes); }
      response.writeHead(201).end();
    } else response.writeHead(400).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`, reference = `127.0.0.1:${port}/test@${image.manifestDigest}`, file = path.join(directory, 'bundle');
  await exportRegistryBundle(image, reference, file, { maxBytes: 1024 * 1024, minFreeBytes: 0 });
  assert.equal(await importRegistryBundle(image, file, reference, origin), manifest);
  assert.deepEqual(uploaded, blobs); assert.equal(publications, 1);
  const bytes = await readFile(file); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; const bad = path.join(directory, 'bad'); await writeFile(bad, bytes);
  await assert.rejects(importRegistryBundle(image, bad, reference, origin), /digest mismatch/); assert.equal(publications, 1);
  await assert.rejects(exportRegistryBundle(image, reference, path.join(directory, 'budget'), { maxBytes: 2, minFreeBytes: 0 }), /budget/);
  assert.throws(() => verifyRegistryManifest(manifest, image, hash('wrong config')), /actual Docker/);
  const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] });
  assert.throws(() => verifyRegistryManifest(index, { ...image, manifestDigest: hash(index) }, hash(config)), /not an index/);
  assert.throws(() => localRegistry('http://example.com'), /loopback/);
  await assert.rejects(importRegistryBundle(image, file, `localhost:9999/test@${image.manifestDigest}`, origin), /configured local registry/);
});

test("OCI import rejects expansion bombs, sparse formats, escaped paths and invalid layers before publishing anything", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-oci-layer-budget-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const normal = tar(tarEntry("etc", Buffer.alloc(0), "5"), tarEntry("etc/value", Buffer.from("value")), tarEntry("link", Buffer.alloc(0), "2", "etc/value"));
  const checksum = Buffer.from(normal); checksum[0] = checksum[0]! ^ 1;
  const cases = [
    { label: "bomb", layers: [tar(tarEntry("bomb", Buffer.alloc(2 * 1024 ** 2)))], budget: { maxExpandedBytes: 64 * 1024, maxFiles: 100 }, error: /expanded byte budget/ },
    { label: "entries", layers: [normal], budget: { maxExpandedBytes: 1024 ** 2, maxFiles: 2 }, error: /entry budget/ },
    { label: "aggregate", layers: [normal, normal], budget: { maxExpandedBytes: normal.length, maxFiles: 100 }, error: /expanded byte budget/ },
    { label: "escape", layers: [tar(tarEntry("../outside"))], error: /unsafe OCI layer path/ },
    { label: "pax-escape", layers: [tar(tarEntry("pax", pax("path", "/outside"), "x"), tarEntry("safe"))], error: /unsafe OCI layer path/ },
    { label: "pax-sparse", layers: [tar(tarEntry("pax", pax("GNU.sparse.realsize", "1099511627776"), "x"), tarEntry("safe"))], error: /unsupported OCI PAX/ },
    { label: "sparse", layers: [tar(tarEntry("sparse", Buffer.alloc(0), "S"))], error: /unsupported OCI tar entry/ },
    { label: "symlink-escape", layers: [tar(tarEntry("link", Buffer.alloc(0), "2", "../outside"))], error: /link escape/ },
    { label: "hardlink-escape", layers: [tar(tarEntry("link", Buffer.alloc(0), "1", "/outside"))], error: /unsafe OCI layer path/ },
    { label: "symlink-parent", layers: [tar(tarEntry("link", Buffer.alloc(0), "2", "etc"), tarEntry("link/value"))], error: /non-directory/ },
    { label: "duplicate", layers: [tar(tarEntry("same"), tarEntry("./same"))], error: /duplicate OCI/ },
    { label: "checksum", layers: [checksum], error: /checksum/ },
    { label: "truncated", layers: [tarEntry("short", Buffer.from("x"), "0", "", 2048)], error: /truncated/ },
    { label: "unknown-codec", layers: [normal], types: ["application/vnd.oci.image.layer.v1.tar+zstd"], error: /unsupported OCI layer media/ },
    { label: "wrong-diffid", layers: [normal], diffIds: [hash("wrong")], error: /uncompressed layer digest/ },
  ];
  for (const c of cases) {
    const bundle = ociBundle(c.layers, c.types, c.diffIds), file = path.join(directory, c.label); await writeFile(file, bundle.bytes);
    await assert.rejects(importRegistryBundle(bundle.image, file, `${origin.slice(7)}/test@${bundle.image.manifestDigest}`, origin, undefined, c.budget), c.error, c.label);
    assert.equal(requests, 0, c.label);
  }
  const valid = ociBundle([normal, tar(tarEntry("pax", pax("path", "long/" + "x".repeat(200)), "x"), tarEntry("short", Buffer.from("x")))], ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip"]);
  const file = path.join(directory, "valid"); await writeFile(file, valid.bytes);
  const checked = await validateRegistryBundle(valid.image, file); assert.equal(checked.usage.files, 5); assert.ok(checked.usage.expandedBytes > 0);
  const raw = path.join(directory, "docker-save"); await writeFile(raw, normal);
  const provider = new DockerResourceImageProvider(directory, { [valid.image.manifestDigest]: `localhost:1234/test@${valid.image.manifestDigest}` });
  await assert.rejects(provider.importArchive(valid.image, raw), /unvalidated Docker archives/);
  await assert.rejects(provider.validateArchive(valid.image, raw), /unvalidated Docker archives/);
});

test("cache-only OCI admission requires verified platform manifest proof and rechecks actual config", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hitch-oci-proof-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = hash("actual image config"), manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: config, size: 19 }, layers: [] });
  const resource = { kind: "oci-image" as const, manifestDigest: hash(manifest), platform: "linux/amd64" }, reference = `offline.invalid/image@${resource.manifestDigest}`;
  let actualConfig = config;
  const resolver = { id: "verified-local-test", async resolve(_reference: string, _platform: string, signal?: AbortSignal) {
    assert.ok(signal); signal.throwIfAborted();
    return { reference, manifest_digest: resource.manifestDigest, config_digest: actualConfig, platform: resource.platform };
  } };
  const provider = new DockerResourceImageProvider(root, { [resource.manifestDigest]: reference }, resolver, {}, "cache-only");
  await assert.rejects(provider.resolve(resource), /cache-only OCI manifest proof missing/);
  const file = path.join(root, "store/benchmark-resources/oci-manifests", `${resource.manifestDigest.slice(7)}.json`);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ manifest }));
  assert.equal((await provider.resolve(resource)).configDigest, config);
  actualConfig = hash("changed Docker config");
  await assert.rejects(provider.resolve(resource), /cache identity changed|actual Docker/);
  actualConfig = config; await writeFile(file, JSON.stringify({ manifest: manifest + " " }));
  await assert.rejects(provider.resolve(resource), /manifest digest mismatch/);
  await assert.rejects(provider.resolve({ ...resource, indexDigest: hash("index") }), /index membership/);
  const abort = new AbortController(); abort.abort(new Error("cancelled test"));
  await assert.rejects(provider.resolve(resource, abort.signal), /cancelled test/);
});

test("online OCI admission validates expanded layers before Docker pull and cleans its bounded staging", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-oci-online-budget-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = ociBundle([tar(tarEntry("bomb", Buffer.alloc(2 * 1024 ** 2)))]);
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    const body = request.url!.includes("/manifests/") ? Buffer.from(bundle.manifest) : bundle.blobs.get(request.url!.split("/").at(-1)! as `sha256:${string}`);
    response.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const reference = `127.0.0.1:${(server.address() as { port: number }).port}/test@${bundle.image.manifestDigest}`;
  const docker = path.join(directory, "docker"), calls = path.join(directory, "calls.jsonl");
  await writeFile(docker, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(1);\n`, { mode: 0o755 });
  const provider = new DockerResourceImageProvider(directory, { [bundle.image.manifestDigest]: reference }, new DockerRegistryResolver({ policy: "cache-first", dockerExecutable: docker }), {}, "cache-first", { ...DEFAULT_RESOURCE_LIMITS, maxTotalBytes: 64 * 1024, minFreeBytes: 0 });
  await assert.rejects(provider.resolve(bundle.image), error => {
    const cause = (error as Error).cause as Error; assert.match(cause.message, /expanded byte budget/); return true;
  });
  const attempts = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(attempts.length, 1); assert.deepEqual(attempts[0].slice(0, 2), ["image", "inspect"]);
  assert.deepEqual(await readdir(path.join(directory, "store/benchmark-resources/staging")), []);
});
