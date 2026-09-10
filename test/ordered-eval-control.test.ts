import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { EvalScheduler, ResourceLedger, orderedEvalControl, withLegacyEvalMutation } from "../src/control-plane/index.js";
import type { EvalRerunScheduler, OrderedEvalCommandV2 } from "../src/control-plane/index.js";
import type { EvalId } from "../src/domain/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";

const resources = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
const subject = sha256JSON("frozen Gear evaluation");
const input = { dataset: "demo@1.0", harness_ref: "pi@version:1.2.3", max_concurrent: 1 };
const submission = { schema_version: "1", request: { backend: "harbor", ...input } };
const command = (sequence: number, action: "start" | "pause"): OrderedEvalCommandV2 => ({ schema_version: "2", key: "stable-evaluation", subject_digest: subject, sequence, action });
const code = (name: string) => (error: unknown) => (error as { code?: string }).code === name;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-ordered-eval-"));
  const ledger = new ResourceLedger(resources); ledger.tryAcquire("capacity-blocker", "eval", resources);
  let launches = 0;
  const evals = new EvalScheduler({ root, resources: ledger, trialResources: resources, executor: async () => { launches++; throw new Error("queued eval must not execute"); } });
  await evals.initialize();
  const operations: string[] = [];
  const reruns = { submit: async (evalId: EvalId, value: { rerun_id: string }) => { operations.push(`start:${value.rerun_id}`); return { evalId, rerunId: value.rerun_id, rerunType: "candidate-restart" }; },
    cancel: async (_: EvalId, id: string) => { operations.push(`pause:${id}`); return "cancelled"; }, status: async () => null } as unknown as EvalRerunScheduler;
  t.after(async () => { await evals.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, evals, reruns, operations, launches: () => launches, call: (value: unknown) => orderedEvalControl(root, value, evals, reruns) };
}

test("cold cancellation reserves one eval identity and rejects late/conflicting commands", async t => {
  const s = await fixture(t), paused = await s.call(command(1, "pause"));
  assert.equal(paused.submitted, false); assert.deepEqual(await readdir(path.join(s.root, "evals")), []);
  assert.deepEqual(await s.call(command(1, "pause")), paused);
  await assert.rejects(s.call({ ...command(0, "start"), submission }), code("eval_control_stale"));
  await assert.rejects(s.call(command(1, "start")), code("eval_control_conflict"));
  await assert.rejects(s.call({ ...command(2, "start"), subject_digest: sha256JSON("other") }), code("eval_control_conflict"));
  const started = await s.call({ ...command(2, "start"), submission });
  assert.equal(started.eval_id, paused.eval_id); assert.equal(started.submitted, true); assert.equal(s.launches(), 0);
  await assert.rejects(s.call(command(1, "pause")), code("eval_control_stale"));
  assert.equal((await s.evals.status(started.eval_id as string))?.control.state, "queued");
});

test("lost admission replies reuse the original index and legacy mutations cannot bypass control", async t => {
  const s = await fixture(t), start = { ...command(0, "start"), submission }, first = await s.call(start);
  const bytes = await readFile(path.join(s.root, "evals", first.eval_id as string, "submission.json"));
  assert.deepEqual(await orderedEvalControl(s.root, start, s.evals, s.reruns), first);
  assert.equal((await readdir(path.join(s.root, "evals"))).length, 1);
  await assert.rejects(s.evals.submit(input, { idempotencyKey: command(0, "start").key }), code("eval_control_required"));
  await assert.rejects(withLegacyEvalMutation(s.root, first.eval_id as string, () => s.evals.cancel(first.eval_id as string)), code("eval_control_required"));
  const paused = await s.call(command(1, "pause")); assert.equal(paused.eval_id, first.eval_id);
  assert.equal((await s.evals.status(first.eval_id as string))?.control.state, "cancelled");
  assert.deepEqual(await readFile(path.join(s.root, "evals", first.eval_id as string, "submission.json")), bytes);
});

test("controlled repair admission is durable before cancellation and cancelled repair IDs cannot revive", async t => {
  const s = await fixture(t), first = await s.call({ ...command(0, "start"), submission });
  const id = `rerun_${"a".repeat(32)}`, rerun = { eval_id: first.eval_id as string, input: { rerun_id: id, rerun_type: "candidate-restart", selector: { mode: "invalid" } } };
  await s.call({ ...command(0, "start"), rerun });
  await s.call(command(1, "pause"));
  assert.deepEqual(s.operations, [`start:${id}`, `pause:${id}`]);
  await assert.rejects(s.call({ ...command(0, "start"), rerun }), code("eval_control_stale"));
  await s.call(command(2, "start"));
  await assert.rejects(s.call({ ...command(2, "start"), rerun }), code("eval_rerun_cancelled"));
  const next = { ...rerun, input: { ...rerun.input, rerun_id: `rerun_${"b".repeat(32)}` } };
  assert.equal((await s.call({ ...command(2, "start"), rerun: next })).eval_id, first.eval_id);
});

test("an uncancelled pending repair can be observed under a newer start without changing its identity", async t => {
  const s = await fixture(t), first = await s.call({ ...command(0, "start"), submission });
  const rerun = { eval_id: first.eval_id as string, input: { rerun_id: `rerun_${"d".repeat(32)}`, rerun_type: "candidate-restart", selector: { mode: "invalid" } } };
  const old = await s.call({ ...command(0, "start"), rerun });
  assert.equal((await s.call({ ...command(1, "start"), rerun })).rerun_id, old.rerun_id);
});

test("public CLI and authenticated daemon persist cold pause across restart and reject old submit", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-eval-control-cli-"));
  const create = () => new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {}, evalExecutor: async (options: RunEvalOptions) => {
    const now = new Date().toISOString(); return { schema_version: "1", eval_id: options.evalId!, status: "succeeded", exit_code: 0, started_at: now, completed_at: now };
  } });
  let server = create();
  await server.start();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "pause.json"); await atomicWriteJSON(file, command(1, "pause"));
  const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [executable, "--root", root, "eval", "control", "--file", file]);
  const paused = JSON.parse(result.stdout); assert.equal(paused.submitted, false);
  await server.close(); server = create(); await server.start();
  const client = await daemonClient(root);
  assert.deepEqual(await client.request("/v1/eval-controls", { method: "POST", body: JSON.stringify(command(1, "pause")) }), paused);
  await assert.rejects(client.request("/v1/eval-controls", { method: "POST", body: JSON.stringify({ ...command(0, "start"), submission }) }), /newer eval command/);
  assert.deepEqual(await readdir(path.join(root, "evals")), []);
  const resumeFile = path.join(root, "resume.json"); await atomicWriteJSON(resumeFile, command(2, "start"));
  const admitted = JSON.parse((await promisify(execFile)(process.execPath, [executable, "--root", root, "eval", "submit", "--control-file", resumeFile,
    "--dataset", input.dataset, "--harness", input.harness_ref, "--max-concurrent", "1"])).stdout);
  assert.equal(admitted.eval_id, paused.eval_id); assert.equal(admitted.submitted, true);
  await assert.rejects(client.request(`/v1/evals/${admitted.eval_id}/cancel`, { method: "POST" }), /ordered control/);
});

test("published ordered-command schema accepts canonical commands and rejects ambiguous mutations", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri => JSON.parse(await readFile(path.join("docs/schemas", path.basename(new URL(uri).pathname)), "utf8")) });
  const validate = await ajv.compileAsync(JSON.parse(await readFile("docs/schemas/ordered-eval-control.schema.json", "utf8")));
  const rerun = { eval_id: `eval_${"a".repeat(32)}`, input: { rerun_id: `rerun_${"b".repeat(32)}`, rerun_type: "candidate-restart", selector: { mode: "invalid" } } };
  for (const value of [command(0, "start"), command(1, "pause"), { ...command(2, "start"), submission }, { ...command(2, "start"), rerun }]) assert.equal(validate(value), true, JSON.stringify(validate.errors));
  for (const value of [{ ...command(1, "pause"), submission }, { ...command(2, "start"), submission, rerun }, { ...command(1, "start"), sequence: -1 }, { ...command(1, "start"), credentials: "private" }]) assert.equal(validate(value), false);
});
