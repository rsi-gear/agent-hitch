import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { delay, sha256JSON } from "../src/foundation/index.js";
import type { SGLangLauncher } from "../src/inference/index.js";
import { addLocalModel, buildInferenceLock, parseInferenceServiceRecord, runtimeCatalogEntry, SGLangServiceSupervisor } from "../src/inference/index.js";
import { safetensorsFixture } from "../test-support/helpers.js";

test("SGLang supervisor coalesces concurrent starts and releases an idle service once", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-supervisor-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "state");
  const source = path.join(temporary, "model");
  await mkdir(source);
  await writeFile(path.join(source, "config.json"), JSON.stringify({ model_type: "qwen2", torch_dtype: "bfloat16" }));
  await writeFile(path.join(source, "tokenizer.json"), "{}\n");
  await writeFile(path.join(source, "model.safetensors"), safetensorsFixture());
  const model = await addLocalModel({ root, directory: source, name: "coder" });
  const runtime = runtimeCatalogEntry("cuda");
  const built = buildInferenceLock(model, runtime, { backend: "cuda", profile: "baseline" });
  const lock = { ...built, execution: { ...built.execution, idle_ttl_ms: 10 } };
  let starts = 0;
  let stops = 0;
  const launcher: SGLangLauncher = {
    start: async () => {
      starts += 1;
      await delay(10);
      return {
        container_id: "a".repeat(64),
        base_url: "http://127.0.0.1:30000",
        wire_model: "wire-model",
        engine_token: "engine-token",
        admin_token: "admin-token",
        stop: async () => { stops += 1; },
      };
    },
  };
  const events: Record<string, unknown>[] = [];
  const supervisor = new SGLangServiceSupervisor({ root, launcher, onEvent: (event) => events.push(event) });
  const isolationKey = sha256JSON({ run: "shared" });
  const leases = await Promise.all(Array.from({ length: 20 }, (_, index) => supervisor.acquire({
    lock, model, runtime, isolationKey, ownerId: `run_${String(index).padStart(32, "0")}`,
  })));
  assert.equal(starts, 1);
  assert.equal(new Set(leases.map((lease) => lease.service_id)).size, 1);
  await leases[0]!.release();
  await delay(20);
  assert.equal(stops, 0, "other leases keep the shared service alive");
  await Promise.all(leases.slice(1).map((lease) => Promise.all([lease.release(), lease.release()])));
  await delay(30);
  assert.equal(stops, 1);
  const records = await supervisor.list();
  assert.equal(records[0]?.state, "stopped");
  assert.equal(events.filter((event) => event.type === "inference.starting").length, 1);
  assert.equal(events.filter((event) => event.type === "inference.acquired").length, 20);
  await supervisor.close();
  assert.equal(stops, 1);
});

test("persisted inference service records reject unknown or unsafe recovery fields", () => {
  const record = {
    schema_version: "1", service_id: `inference_${"a".repeat(32)}`,
    inference_id: `sha256:${"b".repeat(64)}`, isolation_key: `sha256:${"c".repeat(64)}`,
    state: "ready", epoch: 1, owner_id: `run_${"d".repeat(32)}`, lease_owner_ids: [], backend: "cuda",
    container_id: "e".repeat(64), base_url: "http://127.0.0.1:30000",
    started_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:01.000Z",
  };
  assert.deepEqual(parseInferenceServiceRecord(record), record);
  assert.throws(() => parseInferenceServiceRecord({ ...record, base_url: "http://192.0.2.1:30000" }), /loopback/);
  assert.throws(() => parseInferenceServiceRecord({ ...record, engine_token: "secret" }), /unknown field/);
});
