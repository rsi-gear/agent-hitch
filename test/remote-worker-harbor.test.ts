import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { runEval } from "../src/evals/index.js";
import { atomicWriteJSON, sha256JSON, statePaths } from "../src/foundation/index.js";
import { benchmarkTaskDigest, benchmarkVerifierIdentity } from "../src/runs/index.js";
import { TrajectoryProjector, TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/index.js";
import { releaseRemoteHarborOffer, remoteHarborWorker } from "../src/workers/index.js";
import { forceRemove, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const TRIAL = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };

test("packaged worker executes a staged remote eval through Harbor and returns a verifiable result bundle", async (t) => {
  const controllerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-controller-"));
  const workerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-host-"));
  t.after(() => Promise.all([forceRemove(controllerRoot), forceRemove(workerRoot)]));
  const dataset = path.join(controllerRoot, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "");
  const secret = "controller-only-short-ttl-secret";
  const npm = await writeFakeNpm(controllerRoot);
  const harbor = await writeFakeHarbor(controllerRoot, { leakEnvName: "CUSTOM_REMOTE_SECRET" });
  const inspector = await writeResourceInspector(controllerRoot);
  const docker = await writeEmptyDocker(controllerRoot);
  const workerEnv: NodeJS.ProcessEnv = { ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector, HITCH_DOCKER_PATH: docker };
  delete workerEnv.CUSTOM_REMOTE_SECRET;
  const controllerEnv = { ...workerEnv, CUSTOM_REMOTE_SECRET: secret };
  const server = new DaemonServer({
    root: controllerRoot, port: 0, maxConcurrent: 1, logger: () => {},
    resourceCapacity: { ...TRIAL, build_slots: 1 }, evalTrialResources: TRIAL,
    credentialEnv: { CUSTOM_REMOTE_SECRET: secret },
    evalExecutor: (options) => runEval({ ...options, harborExecutable: harbor, env: controllerEnv }),
  });
  await server.start();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const adminToken = (await readFile(statePaths(controllerRoot).token, "utf8")).trim();
  const registration = {
    schema_version: "1" as const, worker_id: "worker_harbor_e2e", provider: "remote-docker",
    collision_domain_id: "docker-engine:remote-e2e", platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "0.1.0" }],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false },
    task_membership: ["known" as const], capacity: { total: TRIAL, reserved_for_system: ZERO, allocatable: TRIAL },
  };
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl, credential });
  const execution = { root: workerRoot, env: workerEnv, harborExecutable: harbor, dockerExecutable: docker, trialBundleGraceMs: 0 };
  const runner = new RemoteWorkerRunner({
    client, capacity: TRIAL, execute: remoteHarborWorker(execution), once: true,
    releaseUnknown: (offer) => releaseRemoteHarborOffer(execution, offer),
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
  });
  const worker = runner.run();
  const admin = await daemonClient(controllerRoot);
  const submitted = await admin.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify({
      request: {
        dataset, harness_ref: "pi@version:1.2.3", max_concurrent: 1, infrastructure_retries: 0,
        pass_env: ["CUSTOM_REMOTE_SECRET"],
      },
      execution: {
        provider: "remote-docker", max_parallelism: 1, resources: { default_trial: TRIAL },
        build: { mode: "backend" }, model_capture: { mode: "native", required: false },
      },
    }),
  });
  const evalId = submitted.eval_id as string;
  const status = await waitFor(async () => {
    const current = await admin.request(`/v1/evals/${evalId}`);
    return current.result ? current : undefined;
  }, 20_000);
  await worker;
  assert.equal((status.result as { status: string }).status, "failed", JSON.stringify(status.result));
  assert.equal(((status.result as { error?: { code?: string } }).error?.code), "eval_has_infrastructure_failures");
  const trials = (status.result as { trials: Array<{ run_id: string; task_id: string; observation_status: string }> }).trials;
  assert.equal(trials.length, 1);
  assert.equal(trials[0]?.task_id, "one");
  assert.equal(trials[0]?.observation_status, "invalid", "the fake Harbor omits a candidate bundle, so Hitch must preserve a diagnostic trial");
  const evidence = await readFile(path.join(controllerRoot, "runs", trials[0]!.run_id, "execution.json"), "utf8");
  assert.match(evidence, /"provider": "remote-docker"/);
  assert.match(evidence, /"worker_id": "worker_harbor_e2e"/);
  assert.equal((await client.listOffers()).length, 0, "the control plane must explicitly release the completed offer");
  for (const root of [controllerRoot, workerRoot]) {
    for (const file of await regularFiles(root)) {
      assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `remote credential leaked into ${path.relative(root, file)}`);
    }
  }
});

test("packaged remote worker runs in-sandbox proxy capture and transports sealed interaction evidence", async (t) => {
  const controllerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-capture-controller-"));
  const workerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-capture-worker-"));
  t.after(() => Promise.all([forceRemove(controllerRoot), forceRemove(workerRoot)]));
  const dataset = path.join(controllerRoot, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), "");
  const npm = await writeFakeNpm(controllerRoot, { packageName: "@openai/codex", binName: "codex" });
  const inspector = await writeResourceInspector(controllerRoot);
  const docker = await writeEmptyDocker(controllerRoot);
  const harbor = await writeCaptureHarbor(controllerRoot);
  const secret = "sk-remote-capture-secret-value";
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "remote-effective", output: Buffer.concat(chunks).toString("utf8"), api_key: secret }));
    });
  });
  const upstreamUrl = await serverUrl(upstream);
  t.after(() => close(upstream));
  const workerEnv: NodeJS.ProcessEnv = {
    ...process.env, HITCH_NPM_PATH: npm, HITCH_HARBOR_PYTHON_PATH: inspector, HITCH_DOCKER_PATH: docker,
    // This fake Harbor runs on the worker host instead of in Docker. Declare
    // that topology explicitly so Linux does not select the real Docker bridge
    // gateway that production in-sandbox capture requires.
    HITCH_MODEL_PROXY_BIND_HOST: "127.0.0.1", HITCH_MODEL_PROXY_ADVERTISED_HOST: "127.0.0.1",
    OPENAI_BASE_URL: `${upstreamUrl}/v1`, OPENAI_API_KEY: secret,
  };
  const server = new DaemonServer({
    root: controllerRoot, port: 0, maxConcurrent: 1, logger: () => {},
    resourceCapacity: { ...TRIAL, build_slots: 1 }, evalTrialResources: TRIAL,
    evalExecutor: (options) => runEval({ ...options, harborExecutable: harbor, env: workerEnv }),
  });
  await server.start();
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const adminToken = (await readFile(statePaths(controllerRoot).token, "utf8")).trim();
  const registration = {
    schema_version: "1" as const, worker_id: "worker_harbor_capture", provider: "remote-docker",
    collision_domain_id: "docker-engine:remote-capture", platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false },
    task_membership: ["known" as const], capacity: { total: TRIAL, reserved_for_system: ZERO, allocatable: TRIAL },
  };
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl, credential });
  const admin = await daemonClient(controllerRoot);
  const submitted = await admin.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify({
      request: {
        dataset, harness_ref: "codex@version:1.2.3", model: "openai/remote", max_concurrent: 1,
        infrastructure_retries: 0,
      },
      execution: {
        provider: "remote-docker", max_parallelism: 1, resources: { default_trial: TRIAL },
        build: { mode: "backend" }, model_capture: { mode: "proxy", required: true },
      },
    }),
  });
  const evalId = submitted.eval_id as string;
  const normalized = JSON.parse(await readFile(path.join(controllerRoot, "evals", evalId, "request.json"), "utf8")) as {
    benchmark_id: string; benchmark_revision: string;
  };
  const trialId = "one__random-1";
  const runId = `run_${sha256JSON({ evalId, trialId }).slice("sha256:".length, "sha256:".length + 32)}`;
  await writeExportedBundle({
    bundle: path.join(controllerRoot, "capture-bundles", evalId), runId, evalId, trialId,
    taskId: "one", benchmarkId: normalized.benchmark_id, benchmarkRevision: normalized.benchmark_revision,
  });
  const execution = { root: workerRoot, env: workerEnv, harborExecutable: harbor, dockerExecutable: docker, trialBundleGraceMs: 0 };
  const workerErrors: string[] = [];
  const workerController = new AbortController();
  const runner = new RemoteWorkerRunner({
    client, capacity: TRIAL, execute: remoteHarborWorker(execution), once: true,
    releaseUnknown: (offer) => releaseRemoteHarborOffer(execution, offer),
    pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50,
    onError: (error) => workerErrors.push((error as Error).stack ?? String(error)),
    signal: workerController.signal,
  });
  const worker = runner.run();
  let status: Record<string, unknown>;
  try {
    status = await waitFor(async () => {
      const current = await admin.request(`/v1/evals/${evalId}`);
      return current.result ? current : undefined;
    }, 20_000);
  } catch (error) {
    const current = await admin.request(`/v1/evals/${evalId}`);
    const offers = await client.listOffers();
    process.stderr.write(`remote capture diagnostic: ${JSON.stringify({ current, offers, workerErrors })}\n`);
    workerController.abort(new Error("test diagnostic timeout"));
    await worker;
    throw new Error(`remote capture timed out: ${JSON.stringify({ current, offers, workerErrors })}`, { cause: error });
  }
  await worker;
  const trial = (status.result as { trials: Array<{ run_id: string }> }).trials[0];
  const diagnostic = trial ? await readFile(path.join(controllerRoot, "runs", trial.run_id, "result.json"), "utf8").catch(() => "missing") : "no trial";
  const workerFiles = await regularFiles(workerRoot);
  const importErrors = await Promise.all(workerFiles.filter((file) => path.basename(file) === "hitch-run-import-error.json")
    .map((file) => readFile(file, "utf8")));
  assert.equal((status.result as { status: string }).status, "succeeded", `${JSON.stringify(status.result)}\nrun result: ${diagnostic}\nimport errors: ${importErrors.join("\n")}\nworker files: ${workerFiles.map((file) => path.relative(workerRoot, file)).join("\n")}`);
  assert.equal(trial?.run_id, runId);
  const runDirectory = path.join(controllerRoot, "runs", runId);
  const ref = JSON.parse(await readFile(path.join(runDirectory, "interactions", "interaction.ref.json"), "utf8")) as {
    topology: string; completeness: string; interaction_count: number;
  };
  assert.equal(ref.topology, "in-sandbox");
  assert.equal(ref.completeness, "complete");
  assert.equal(ref.interaction_count, 1);
  for (const root of [controllerRoot, workerRoot]) {
    for (const file of await regularFiles(root)) {
      assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `remote capture credential leaked into ${path.relative(root, file)}`);
    }
  }
});

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function writeResourceInspector(root: string): Promise<string> {
  const executable = path.join(root, "fake-resource-inspector");
  const declaration = {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false },
    environment_images: [], environment_image_fallbacks: [], environment_builds: [],
  };
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(declaration))});\n`, { mode: 0o755 });
  return executable;
}

async function writeEmptyDocker(root: string): Promise<string> {
  const executable = path.join(root, "fake-empty-docker");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") process.stdout.write("27.4.0\\n");
if (["container", "network", "volume"].includes(args[0]) && args[1] === "ls") process.stdout.write("");
process.exit(0);
`, { mode: 0o755 });
  return executable;
}

async function writeCaptureHarbor(root: string): Promise<string> {
  const executable = path.join(root, "fake-capture-harbor");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
(async () => {
  const capture = config.agents[0].kwargs.model_capture;
  if (!capture || capture.topology !== "in-sandbox" || capture.required !== true) process.exit(3);
  const evalId = config.agents[0].kwargs.eval_id;
  const bundle = path.join(${JSON.stringify(path.join(root, "capture-bundles"))}, evalId);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  const runId = manifest.run_id;
  const local = (value) => value.replace("host.docker.internal", "127.0.0.1").replace("{run_id}", runId);
  const health = await fetch(local(capture.health_url_template));
  if (!health.ok) process.exit(4);
  const response = await fetch(local(capture.base_url_template).replace("{provider}", "openai") + "/responses", {
    method: "POST", headers: {authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({model:"remote-requested",input:"credential=" + process.env.OPENAI_API_KEY}),
  });
  if (!response.ok) process.exit(5);
  const output = path.join(config.jobs_dir, config.job_name);
  const trialId = "one__random-1";
  const trialDirectory = path.join(output, trialId);
  fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:"one"}}));
  fs.cpSync(bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({task_name:"one",trial_name:trialId,verifier_result:{rewards:{reward:1}}}));
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({n_total_trials:1,stats:{n_completed_trials:1,n_errored_trials:0,n_cancelled_trials:0}}));
  process.stdout.write("Results written\\n");
})().catch((error) => { process.stderr.write(String(error)); process.exit(6); });
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

async function writeExportedBundle(options: {
  bundle: string; runId: string; evalId: string; trialId: string; taskId: string; benchmarkId: string; benchmarkRevision: string;
}): Promise<void> {
  await mkdir(options.bundle, { recursive: true });
  const projector = new TrajectoryProjector({ runId: options.runId, cwd: "/app", prompt: "complete", model: "openai/remote", fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory: options.bundle, cwd: "/app", sessionId: projected.header.id, fidelity: "normalized", header: projected.header });
  for (const event of projected.events) writer.append(event);
  const trajectory = await writer.close();
  await atomicWriteJSON(path.join(options.bundle, "trajectory.ref.json"), trajectoryRefV2({
    runId: options.runId, fidelity: "normalized", files: [await canonicalTrajectoryFileRef(options.bundle, trajectory)],
  }));
  await atomicWriteJSON(path.join(options.bundle, "request.json"), { cwd: "/app" });
  await atomicWriteJSON(path.join(options.bundle, "resolution.json"), { schema_version: "1" });
  await atomicWriteJSON(path.join(options.bundle, "result.json"), { schema_version: "1", run_id: options.runId, status: "succeeded", exit_code: 0 });
  await writeFile(path.join(options.bundle, "events.jsonl"), `${JSON.stringify({ type: "run.completed" })}\n`);
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(options.bundle, "manifest.json"), {
    schema_version: "1", run_id: options.runId,
    context: {
      kind: "benchmark_task", benchmark_id: options.benchmarkId, benchmark_revision: options.benchmarkRevision, task_id: options.taskId,
      task_digest: benchmarkTaskDigest(options.benchmarkId, options.benchmarkRevision, options.taskId),
      verifier_identity: benchmarkVerifierIdentity(options.benchmarkId, options.benchmarkRevision),
    },
    parent: { kind: "eval", eval_id: options.evalId, trial_id: options.trialId, attempt: 1 },
    status: "succeeded", harness: { harness_id: "codex", requested_ref: "codex@version:1.2.3", revision_identity: `sha256:${"a".repeat(64)}` },
    model: { provider: "openai", requested_id: "openai/remote", effective_id: "openai/remote", identity_resolved: false },
    protocol: { timeout_ms: 0, workspace_mode: "shared" }, request_ref: "request.json", resolution_ref: "resolution.json",
    result_ref: "result.json", trajectory_ref: "trajectory.ref.json", created_at: now, completed_at: now, sealed: false,
  });
  await atomicWriteJSON(path.join(options.bundle, "bundle.complete.json"), {
    schema_version: "1", run_id: options.runId, eval_id: options.evalId, trial_id: options.trialId, completed_at: now,
  });
}

async function serverUrl(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await operation();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for remote Harbor eval");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
