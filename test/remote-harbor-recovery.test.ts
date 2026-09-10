import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteWorkerHttpClient } from "../src/control-plane/index.js";
import { daemonClient } from "../src/daemon/index.js";
import type { InferenceServiceRecordV1 } from "../src/domain/index.js";
import { readExecutionLeases } from "../src/evals/index.js";
import { atomicWriteJSON, captureProcessIdentity, delay, inspectProcessIdentity, readJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { forceRemove, writeFakeNpm } from "../test-support/helpers.js";
import { managedCandidateNode } from "../test-support/managed-candidate-node.js";
import { writeCaptureHarbor, writeEmptyDocker, writeExportedBundle, writeResourceInspector } from "../test-support/remote-harbor-model.js";

async function eventually<T>(check: () => Promise<T | undefined>, diagnose: () => string = () => "") {
  const deadline = Date.now() + 30_000;
  for (;;) { const result = await check(); if (result !== undefined) return result;
    assert.ok(Date.now() < deadline, `live candidate recovery timed out: ${diagnose()}`); await delay(25); }
}

test("worker SIGKILL recovery stops the original Harbor process and releases the failed offer without another candidate", { timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "hitch-killed-worker-"));
  const root = path.join(temporary, "controller"), workerRoot = path.join(temporary, "worker");
  const children: Array<ReturnType<typeof spawn>> = [], output: string[] = [];
  let closeNode: (() => Promise<void>) | undefined;
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    await closeNode?.(); await forceRemove(temporary);
  });
  const node = await managedCandidateNode(temporary, root); closeNode = node.close;
  const dataset = path.join(root, "dataset"); await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "");
  const npm = await writeFakeNpm(root, { packageName: "@openai/codex", binName: "codex", version: "0.145.0" });
  const inspector = await writeResourceInspector(root), docker = await writeEmptyDocker(root);
  const reached = path.join(temporary, "candidate-paused.json"), resume = path.join(temporary, "candidate-resume");
  const harbor = await writeCaptureHarbor(root, false, false, { reached, resume });
  const env = { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector, HITCH_DOCKER_PATH: docker,
    HITCH_MODEL_PROXY_BIND_HOST: "127.0.0.1", HITCH_MODEL_PROXY_ADVERTISED_HOST: "127.0.0.1", OPENAI_API_KEY: "foreign-worker-key" };
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    child.stdout!.on("data", chunk => output.push(String(chunk))); child.stderr!.on("data", chunk => output.push(String(chunk)));
    return child;
  };
  const config = path.join(temporary, "daemon.json"); await atomicWriteJSON(config, { root, port: 0, harbor });
  const entry = fileURLToPath(new URL("../test-support/managed-candidate-daemon.js", import.meta.url));
  const first = launch([entry, config]);
  const daemon = await eventually(async () => {
    assert.equal(first.exitCode, null, output.join(""));
    const state = await readJSON<{ port: number; pid: number } | null>(statePaths(root).daemon, null); return state ?? undefined;
  }, () => output.join(""));
  assert.equal(daemon.pid, first.pid);
  const baseUrl = `http://127.0.0.1:${daemon.port}`, admin = await daemonClient(root);
  const capacity = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const registration = { schema_version: "1" as const, worker_id: "worker_live_candidate", provider: "remote-docker",
    collision_domain_id: "docker-engine:live-fixture", platforms: [`${process.platform}-${process.arch}`], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false, managed_model_node: "2" as const }, task_membership: ["known" as const],
    capacity: { total: capacity, allocatable: capacity, reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 } } };
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken: (await readFile(statePaths(root).token, "utf8")).trim(), registration });
  const registrationFile = path.join(temporary, "worker-registration.json"), credentialFile = path.join(temporary, "worker-credential.json");
  await atomicWriteJSON(registrationFile, registration); await atomicWriteJSON(credentialFile, credential);
  const submitted = await admin.request("/v1/evals", { method: "POST", body: JSON.stringify({
    request: { dataset, harness_ref: "codex@version:0.145.0", model: "local/test", max_concurrent: 1, infrastructure_retries: 0,
      local_inference: { inference_id: node.prepared.lock.inference_id, model_node: node.binding } },
    execution: { provider: "remote-docker", max_parallelism: 1, resources: { default_trial: capacity }, build: { mode: "backend" }, model_capture: { mode: "proxy", required: true } },
  }) });
  const evalId = submitted.eval_id as string, directory = path.join(root, "evals", evalId), trialId = "one__random-1";
  const runId = `run_${sha256JSON({ evalId, trialId }).slice(7, 39)}`;
  const request = await readJSON<{ benchmark_id: string; benchmark_revision: string }>(path.join(directory, "request.json"));
  await writeExportedBundle({ bundle: path.join(root, "capture-bundles", evalId), runId, evalId, trialId, taskId: "one",
    benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision, harnessRef: "codex@version:0.145.0",
    managed: { inference_id: node.prepared.lock.inference_id, model_id: node.model.model_id, model_node: node.binding } });
  const worker = launch([fileURLToPath(new URL("../bin/hitch.js", import.meta.url)), "--root", workerRoot, "worker", "run", "--server", baseUrl,
    "--registration", registrationFile, "--credential-file", credentialFile, "--harbor", harbor, "--docker", docker, "--once", "--poll-interval", "50", "--heartbeat-interval", "50"]);
  const workerExit = once(worker, "exit");
  const paused = await eventually(async () => {
    assert.equal(worker.exitCode, null, output.join(""));
    const failed = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null);
    assert.equal(failed, null, JSON.stringify(failed));
    const marker = await readJSON<{ runId: string; pid: number } | null>(reached, null); return marker ?? undefined;
  }, () => output.join(""));
  assert.equal(paused.runId, runId); assert.notEqual(paused.pid, worker.pid);
  const leases = await readExecutionLeases(directory); assert.equal(leases.length, 1); assert.equal(leases[0]!.state, "running");
  const candidateIdentity = await captureProcessIdentity(paused.pid); assert.ok(candidateIdentity);
  const offer = (await new RemoteWorkerHttpClient({ baseUrl, credential }).listOffers()).find(item => item.state === "accepted"); assert.ok(offer);
  const ownershipFile = path.join(statePaths(workerRoot).evals, offer.lease.eval_id, "remote-work", offer.work.work_id,
    `epoch-${String(offer.lease.epoch).padStart(6, "0")}`, "worker-execution.json");
  const ownership = await readJSON<{ phase: string; process: { pid: number } }>(ownershipFile);
  assert.equal(ownership.phase, "executing"); assert.notEqual(ownership.process.pid, paused.pid);
  worker.kill("SIGKILL"); assert.deepEqual(await workerExit, [null, "SIGKILL"]);
  assert.equal(await inspectProcessIdentity(candidateIdentity), "running", "the detached Harbor child actually survived the worker");
  assert.equal((await readJSON<typeof ownership>(ownershipFile)).phase, "executing", "no fault injection edits to durable execution state");
  const restarted = launch([fileURLToPath(new URL("../bin/hitch.js", import.meta.url)), "--root", workerRoot, "worker", "run", "--server", baseUrl,
    "--registration", registrationFile, "--credential-file", credentialFile, "--harbor", harbor, "--docker", docker, "--once", "--poll-interval", "50", "--heartbeat-interval", "50"]);
  const restartedExit = once(restarted, "exit");
  const status = await eventually(async () => {
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null); return result ?? undefined;
  }, () => output.join(""));
  assert.equal(status.status, "failed", `${JSON.stringify(status)}\n${output.join("")}`);
  assert.deepEqual(await restartedExit, [0, null], output.join(""));
  assert.notEqual(await inspectProcessIdentity(candidateIdentity), "running");
  assert.equal((await readJSON<typeof ownership>(ownershipFile)).phase, "released");
  assert.equal(await readFile(path.join(root, "capture-harbor-count"), "utf8"), "1");
  assert.equal(node.requests.filter(request => request.body.input !== "Reply with one word.").length, 1);
  const calls = (await readFile(node.calls, "utf8")).trim().split("\n");
  assert.equal(calls.filter(call => call === "inference.start").length, 1);
  const released = await readExecutionLeases(directory); assert.equal(released.length, 1); assert.equal(released[0]!.state, "released");
  assert.equal(released[0]!.release_confirmation!.execution_epoch, leases[0]!.epoch);
  const finalOffer = await readJSON<typeof offer>(path.join(statePaths(root).workerProtocol, "workers", offer.worker_id, "offers", `${offer.offer_id}.json`));
  assert.equal(finalOffer?.state, "released"); assert.equal(finalOffer?.terminal?.status, "failed");
  assert.equal(output.join("").includes(node.access.engineToken), false); assert.equal(output.join("").includes(credential.token), false);
});
