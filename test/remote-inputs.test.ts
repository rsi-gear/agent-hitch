import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkInputStore, materializeRemoteTreeEnvelope, parseRemoteTreeEnvelope } from "../src/control-plane/index.js";
import { sha256Bytes } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("remote input store deduplicates content and detects later mutation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-input-"));
  t.after(() => forceRemove(root));
  const store = new RemoteWorkInputStore(root);
  await store.initialize();
  const body = Buffer.from('{"schema_version":"1"}\n');
  const first = await store.put("work-spec", "json", body);
  assert.deepEqual(await store.put("work-spec", "json", body), first);
  const verified = await store.verify(first);
  assert.deepEqual(await readFile(verified.path), body);
  await writeFile(verified.path, Buffer.alloc(body.length, 0x78));
  await assert.rejects(store.verify(first), (error: unknown) => (error as { code?: string }).code === "remote_input_invalid");
});

test("remote tree materialization preserves executable mode and rejects unsafe evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-tree-"));
  t.after(() => forceRemove(root));
  const content = Buffer.from("#!/bin/sh\nexit 0\n");
  const envelope = tree("bin/run", content);
  const destination = path.join(root, "materialized");
  await materializeRemoteTreeEnvelope(envelope, destination);
  assert.deepEqual(await readFile(path.join(destination, "bin", "run")), content);
  assert.equal((await stat(path.join(destination, "bin", "run"))).mode & 0o777, 0o755);
  assert.throws(() => parseRemoteTreeEnvelope(tree("../escape", content)), (error: unknown) => (error as { code?: string }).code === "remote_input_invalid");
  const corrupt = tree("bin/run", content);
  corrupt.files[0]!.sha256 = `sha256:${"f".repeat(64)}`;
  assert.throws(() => parseRemoteTreeEnvelope(corrupt), (error: unknown) => (error as { code?: string }).code === "remote_input_invalid");
});

function tree(file: string, content: Buffer) {
  return {
    schema_version: "1",
    files: [{ path: file, mode: 0o755, size: content.length, sha256: sha256Bytes(content), content_base64: content.toString("base64") }],
  };
}
