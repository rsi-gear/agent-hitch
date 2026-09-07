import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalInferenceManager, ResourceLedger } from "../src/control-plane/index.js";
import { delay, sha256JSON } from "../src/foundation/index.js";
import type { SGLangLauncher } from "../src/inference/index.js";
import { addLocalModel, buildInferenceLock, runtimeCatalogEntry, SGLangServiceSupervisor } from "../src/inference/index.js";
import { safetensorsFixture } from "../test-support/helpers.js";

test("local inference manager coalesces services, isolates run credentials, and releases one resource lease", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-inference-manager-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const source = path.join(temporary, "model");
  await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ model_type: "qwen2", torch_dtype: "bfloat16" }));
  await writeFile(path.join(source, "tokenizer.json"), "{}\n");
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "coder" });
  const runtime = runtimeCatalogEntry("cpu");
  const built = buildInferenceLock(model, runtime, { backend: "cpu", profile: "baseline", cpuThreads: 1 });
  const lockWithoutIdentity = { ...built, execution: { ...built.execution, idle_ttl_ms: 10 } };
  const { inference_id: _oldIdentity, ...identityInput } = lockWithoutIdentity;
  const lock = { ...lockWithoutIdentity, inference_id: sha256JSON(identityInput) };

  let requests = 0;
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
      assert.equal(request.headers.authorization, "Bearer engine-token");
      assert.equal(body.model, "hitch-wire-model");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: body.model, output: "ok" }));
    });
  });
  const upstreamUrl = await serverUrl(upstream);
  t.after(() => close(upstream));
  let starts = 0;
  let stops = 0;
  const launcher: SGLangLauncher = {
    start: async () => {
      starts += 1;
      return {
        container_id: "a".repeat(64), base_url: upstreamUrl, wire_model: "hitch-wire-model",
        engine_token: "engine-token", admin_token: "admin-token", stop: async () => { stops += 1; },
      };
    },
  };
  const ledger = new ResourceLedger({
    cpu_millis: 4_000, memory_bytes: 8 * 1024 ** 3, container_slots: 4, build_slots: 1, ephemeral_disk_bytes: 8 * 1024 ** 3,
  });
  const supervisor = new SGLangServiceSupervisor({ root, launcher });
  const manager = new LocalInferenceManager({
    root,
    resources: ledger,
    supervisor,
    preflight: async () => ({ model, runtime, lock, runtime_cache_hit: true }),
  });
  t.after(() => manager.close());
  const runIds = Array.from({ length: 8 }, (_, index) => `run_${index.toString(16).padStart(32, "0")}`);
  const leases = await Promise.all(runIds.map((runId) => manager.acquire({
    run_id: runId,
    harness_ref: "codex@version:1.0.0",
    selection: { model: "local/coder", device: "cpu", profile: "baseline", offline: true },
    cache_scope_owner: runId,
  })));
  assert.equal(starts, 1);
  assert.equal(ledger.snapshot().allocations.filter((entry) => entry.kind === "inference").length, 1);
  assert.equal(new Set(leases.map((lease) => lease.service_id)).size, 1);
  assert.equal(new Set(leases.map((lease) => lease.credential)).size, leases.length);

  const first = leases[0]!;
  const response = await fetch(new URL("responses", first.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${first.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: first.binding.wire_model, input: "hello" }),
  });
  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  const denied = await fetch(new URL("responses", leases[1]!.binding.base_url), {
    method: "POST",
    headers: { authorization: `Bearer ${first.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: first.binding.wire_model, input: "hello" }),
  });
  assert.equal(denied.status, 401);
  assert.equal(JSON.parse(await readFile(path.join(root, "runs", runIds[0]!, "inference", "lock.json"), "utf8")).inference_id, lock.inference_id);

  await Promise.all(leases.map((lease) => Promise.all([lease.release(), lease.release()])));
  await delay(140);
  assert.equal(stops, 1);
  assert.equal(ledger.snapshot().allocations.filter((entry) => entry.kind === "inference").length, 0);
});

async function serverUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
