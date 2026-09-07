import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";

test("daemon preparation authenticates before work, validates selection, and streams typed failures", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-prepare-api-"));
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {} });
  await server.start();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const denied = await fetch(`http://127.0.0.1:${server.port}/v1/inference/prepare`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401); await denied.text();
  const client = await daemonClient(root);
  await assert.rejects(client.request("/v1/inference/prepare", { method: "POST", body: JSON.stringify({ model: "cloud/model", device: "cpu", profile: "baseline", offline: true }) }), /invalid local inference/);
  const messages: string[] = [];
  await assert.rejects(client.prepareInference({ model: "local/missing", device: "cpu", profile: "baseline", offline: true }, (message) => messages.push(message)),
    (error: unknown) => typeof (error as { code: unknown }).code === "string" && !/ended without a result/.test((error as Error).message));
  assert.ok(messages.some((message) => message.includes("validating")));
});
