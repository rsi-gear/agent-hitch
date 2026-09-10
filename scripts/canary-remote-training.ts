import assert from "node:assert/strict";
import { remoteCanaryWorker } from "./canary-worker-host.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { readExecutionLeases, reapOwnedDockerResources, runEval, validateEvalId } from "../src/evals/index.js";
import { parseTrainingBinding } from "../src/model-access/index.js";
import { atomicWriteJSON, runCommand, sha256JSON, statePaths } from "../src/foundation/index.js";

// Real Harbor/Docker and public worker CLI, with a deterministic model fixture.
// This cannot certify native token facts, Slime training, or a GPU runtime.
const python = process.env.HITCH_HARBOR_TEST_PYTHON;
const image = process.env.HITCH_TRAINING_CANARY_IMAGE;
assert.ok(python && image, "Set HITCH_HARBOR_TEST_PYTHON and HITCH_TRAINING_CANARY_IMAGE (local bash-capable image)");
const harbor = path.join(path.dirname(python), "harbor");
const cli = path.resolve("dist/bin/hitch.js");
const root = await mkdtemp(path.join(tmpdir(), "hitch-real-remote-training-"));
const controllerRoot = path.join(root, "controller"), workerRoot = path.join(root, "worker");
const privateRoot = path.join(root, "private"), dataset = path.join(root, "dataset");
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const resource = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const env: NodeJS.ProcessEnv = { ...process.env, HITCH_HARBOR_PYTHON_PATH: python };
delete env.HITCH_TEST_HOST_ARTIFACT_BUILDER;
const imageInfo = await runCommand("docker", ["image", "inspect", image, "--format", "{{json .}}"], { timeoutMs: 10_000 });
const inspected = JSON.parse(imageInfo.stdout) as { Id: string; Os: string; Architecture: string };
assert.match(inspected.Id, /^sha256:[a-f0-9]{64}$/);
assert.equal(`${inspected.Os}/${inspected.Architecture}`, "linux/amd64");
const version = (await runCommand(python, ["-c", 'import importlib.metadata; print(importlib.metadata.version("harbor"))'], { timeoutMs: 10_000 })).stdout.trim();
assert.equal(version, "0.21.0");
const localEngine = (await runCommand("docker", ["info", "--format", "{{.ID}}"], { timeoutMs: 10_000 })).stdout.trim();
const remoteWorker = await remoteCanaryWorker(root, workerRoot);
const workerObservation = await remoteWorker?.observe(inspected.Id, localEngine);
const engine = workerObservation?.engine ?? localEngine;
const hash = sha256JSON({ canary: "remote-training", image: inspected.Id });
const secret = randomBytes(32).toString("hex");
const binding = parseTrainingBinding({ kind: "training-external", bindingId: "canary_training", trainingRunId: "train_canary",
  policyLeaseRef: { uri: `cas:${hash}`, digest: hash, mediaType: "application/json" }, expectedPolicyVersion: "canary/update-0",
  fencingToken: randomBytes(16).toString("hex"), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  endpointRef: "hitch-training:canary_training", credentialRef: "hitch-training:canary_training",
  generationContractDigest: hash, requiredCapture: "exact-policy-tokens-v1", api: "chat-completions", maxOutputTokens: 64, maxEpisodeSteps: 4 });
let boundRun: string | undefined, generations = 0;
const protocolErrors: string[] = [];
const upstream = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    try {
      assert.ok(request.headers.authorization === `Bearer ${secret}`, "missing private model credential");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/lease") {
        response.end(JSON.stringify({ schemaVersion: 1, trainingRunId: binding.trainingRunId, policyVersion: binding.expectedPolicyVersion,
          fencingToken: binding.fencingToken, state: "serving", generationContractDigest: hash, capture: binding.requiredCapture })); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/v1/hitch/run") {
        assert.ok(!boundRun || boundRun === body.runId, "binding acquired another canonical run");
        boundRun = body.runId; response.end(JSON.stringify({ runId: boundRun, policyVersion: binding.expectedPolicyVersion })); return;
      }
      assert.equal(request.url, "/v1/chat/completions"); assert.ok(boundRun);
      assert.equal(request.headers["idempotency-key"], `${boundRun}-${generations}`);
      assert.equal(body.model, binding.expectedPolicyVersion);
      if (generations === 1) assert.match(body.messages.at(-1).content, /first-tool/);
      if (generations === 2) assert.match(body.messages.at(-1).content, /first-toolsecond-tool/);
      generations++;
      assert.ok(generations <= 3, "unexpected extra model generation");
      const command = generations === 1
        ? "printf first-tool > /tmp/gear-canary.txt; cat /tmp/gear-canary.txt"
        : "printf second-tool >> /tmp/gear-canary.txt; cat /tmp/gear-canary.txt";
      response.setHeader("x-gear-receipt-id", `fixture-receipt-${generations}`);
      response.end(JSON.stringify({ model: binding.expectedPolicyVersion, choices: [{ index: 0,
        finish_reason: generations < 3 ? "tool_calls" : "stop", message: generations < 3
          ? { role: "assistant", content: null, tool_calls: [{ id: `call-${generations}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
          : { role: "assistant", content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } catch (error) {
      protocolErrors.push(error instanceof Error ? error.message : String(error));
      response.statusCode = 500; response.end(JSON.stringify({ error: "canary model protocol mismatch" }));
    }
  });
});
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
const server = new DaemonServer({ root: controllerRoot, port: 0, maxConcurrent: 1,
  resourceCapacity: { ...resource, build_slots: 1 }, evalTrialResources: resource,
  evalExecutor: options => runEval({ ...options, harborExecutable: harbor, env }), logger: () => {} });
let worker: ReturnType<typeof spawn> | undefined;
let workerDone: Promise<number | null> | undefined;
const workerLog = createWriteStream(path.join(root, "worker.log"));
let evalId: ReturnType<typeof validateEvalId> | undefined;
let passed = false;
const summary: Record<string, unknown> = { kind: "real-harbor-training-transport-canary", validated_gpu: false, worker_host: remoteWorker ? "ssh" : "local-process", root, harbor: version, image_id: inspected.Id, docker_engine_digest: sha256JSON(engine) };
console.log(JSON.stringify({ event: "canary-start", root, image_id: inspected.Id }));
try {
  const harness = await prepareInputs();
  await server.start();
  const registration = { schema_version: "1", worker_id: "worker_real_training", provider: "remote-docker",
    collision_domain_id: `docker-engine:${engine}`, platforms: ["linux-x64"], backends: [{ id: "harbor", version }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false, training_external_binding: "2" },
    task_membership: ["known"], capacity: { total: resource, reserved_for_system: zero, allocatable: resource } };
  const registrationFile = path.join(privateRoot, "registration.json"), credentialFile = path.join(privateRoot, "worker-credential.json");
  const bindingFile = path.join(privateRoot, "binding.json");
  await atomicWriteJSON(registrationFile, registration);
  await atomicWriteJSON(bindingFile, { schema_version: "1", binding, base_url: `${upstreamUrl}/v1`, credential: secret });
  await runCommand(process.execPath, [cli, "--root", controllerRoot, "training", "register", "--file", bindingFile], { env, timeoutMs: 10_000 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  await runCommand(process.execPath, [cli, "worker", "register", "--server", baseUrl, "--registration", registrationFile,
    "--admin-token-file", statePaths(controllerRoot).token, "--credential-file", credentialFile], { env, timeoutMs: 10_000 });
  worker = remoteWorker ? await remoteWorker.start(server.port, registrationFile, credentialFile) : spawn(process.execPath, [cli, "--root", workerRoot, "worker", "run", "--server", baseUrl, "--registration", registrationFile,
    "--credential-file", credentialFile, "--harbor", harbor, "--docker", "/usr/local/bin/docker", "--once", "--poll-interval", "100ms", "--heartbeat-interval", "1s"], { env, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout!.pipe(workerLog, { end: false }); worker.stderr!.pipe(workerLog, { end: false });
  workerDone = new Promise((resolve, reject) => { worker!.once("error", reject); worker!.once("exit", code => resolve(code)); });
  void workerDone.catch(() => {});
  const admin = await daemonClient(controllerRoot);
  const submitted = await admin.request("/v1/evals", { method: "POST", body: JSON.stringify({
    request: { dataset, harness_ref: harness, model: `training/${binding.bindingId}`, training_binding: binding,
      max_concurrent: 1, attempts: 1, infrastructure_retries: 0, timeout_ms: 120_000, setup_timeout_ms: 120_000 },
    execution: { provider: "remote-docker", max_parallelism: 1, resources: { default_trial: resource },
      build: { mode: "backend" }, model_capture: { mode: "proxy", required: true } },
  }) });
  evalId = validateEvalId(String(submitted.eval_id));
  console.log(JSON.stringify({ event: "eval-submitted", eval_id: evalId }));
  const deadline = Date.now() + 5 * 60_000;
  let current: Record<string, unknown> = {}, previous = "";
  while (Date.now() < deadline) {
    current = await admin.request(`/v1/evals/${evalId}`);
    const phase = JSON.stringify(current.control);
    if (phase !== previous) { previous = phase; console.log(JSON.stringify({ event: "eval-control", control: current.control })); }
    if (current.result) break;
    if (worker.exitCode !== null && worker.exitCode !== 0) throw new Error(`worker exited before result (${worker.exitCode})`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await atomicWriteJSON(path.join(root, "eval-inspection.json"), current);
  assert.ok(current.result, "real Harbor candidate timed out");
  const result = current.result as { status: string; trials: Array<{ run_id: string; observation_status: string; reward?: number }> };
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.trials.length, 1); assert.equal(result.trials[0]!.observation_status, "valid");
  assert.equal(result.trials[0]!.reward, 1);
  assert.equal(result.trials[0]!.run_id, boundRun);
  assert.equal(generations, 3); assert.deepEqual(protocolErrors, []);
  const evidence = await runCommand(process.execPath, [cli, "--root", controllerRoot, "training", "evidence", boundRun!, "--json"], { env, timeoutMs: 10_000 });
  await writeFile(path.join(root, "training-evidence.json"), evidence.stdout);
  const leases = await readExecutionLeases(path.join(controllerRoot, "evals", evalId));
  assert.equal(leases.length, 1); assert.equal(leases[0]!.state, "released");
  assert.ok(leases[0]!.release_confirmation);
  assert.equal(await Promise.race([workerDone, new Promise(resolve => setTimeout(() => resolve("timeout"), 10_000))]), 0);
  await remoteWorker?.collect();
  for (const directory of [path.join(controllerRoot, "runs"), path.join(controllerRoot, "evals"), workerRoot]) {
    for (const file of await regularFiles(directory)) assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `model credential leaked into ${file}`);
  }
  Object.assign(summary, { status: "passed", eval_id: evalId, run_id: boundRun, model_calls: generations, tool_calls: 2, lease_id: leases[0]!.lease_id, private_model_credential_in_public_files: false });
  passed = true;
} catch (error) {
  Object.assign(summary, { status: "failed", error: error instanceof Error ? error.message : String(error), protocol_errors: protocolErrors });
  throw error;
} finally {
  if (evalId && !passed) {
    const admin = await daemonClient(controllerRoot).catch(() => undefined);
    await admin?.request(`/v1/evals/${evalId}/cancel`, { method: "POST", body: "{}" }).catch(() => {});
  }
  try { await remoteWorker?.stop(); } catch (error) { summary.remote_stop_error = error instanceof Error ? error.message : String(error); }
  if (worker && worker.exitCode === null) worker.kill("SIGTERM");
  if (workerDone) await Promise.race([workerDone.catch(() => null), new Promise(resolve => setTimeout(resolve, 10_000))]);
  if (worker && worker.exitCode === null) { worker.kill("SIGKILL"); await workerDone?.catch(() => null); }
  workerLog.end();
  await server.close();
  upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  const leases = evalId ? await readExecutionLeases(path.join(controllerRoot, "evals", evalId)).catch(() => []) : [];
  const leaseIds = leases.map(lease => lease.lease_id);
  const cleanup = await Promise.all([
    reapOwnedDockerResources({ root: controllerRoot, leaseIds, env }),
    remoteWorker ? remoteWorker.cleanup(leaseIds).catch(error => ({ issues: [String(error)], retained: [] }))
      : reapOwnedDockerResources({ root: workerRoot, leaseIds, env }),
  ]);
  if (remoteWorker && !passed) await remoteWorker.collect().catch(error => { summary.remote_collection_error = String(error); });
  summary.cleanup_proven = !summary.remote_stop_error && cleanup.every(report => report.issues.length === 0 && report.retained.length === 0);
  await atomicWriteJSON(path.join(root, "summary.json"), summary);
  console.log(JSON.stringify(summary));
}
assert.equal(summary.cleanup_proven, true, "owned Docker resources were not all released");

async function prepareInputs(): Promise<string> {
  const task = path.join(dataset, "one"), source = path.join(root, "training-source");
  await mkdir(path.join(task, "environment"), { recursive: true }); await mkdir(path.join(task, "tests"));
  await writeFile(path.join(task, "instruction.md"), "Use two bash tool calls to write first-toolsecond-tool into /tmp/gear-canary.txt.\n");
  await writeFile(path.join(task, "environment/Dockerfile"), `FROM ${inspected.Id}\n`);
  await writeFile(path.join(task, "task.toml"), `schema_version="1.4"\n[agent]\ntimeout_sec=120\n[environment]\ndocker_image="${inspected.Id}"\ncpus=1\nmemory_mb=1024\n[verifier]\ntimeout_sec=30\n`);
  await writeFile(path.join(task, "tests/test.sh"), '#!/bin/bash\nset -eu\nmkdir -p /logs/verifier\nif test -f /tmp/gear-canary.txt && test "$(cat /tmp/gear-canary.txt)" = first-toolsecond-tool; then\n  printf "1" > /logs/verifier/reward.txt\nelse\n  printf "0" > /logs/verifier/reward.txt\nfi\n', { mode: 0o755 });
  await mkdir(path.join(source, "integrations/training-tool"), { recursive: true });
  await writeFile(path.join(source, "integrations/training-tool/cli.js"), await readFile("integrations/training-tool/cli.js"), { mode: 0o755 });
  await writeFile(path.join(source, "package.json"), '{"type":"module"}');
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Hitch Canary", "-c", "user.email=canary@hitch.invalid", "commit", "-m", "fixed training harness canary"]]) await runCommand("git", args, { cwd: source, timeoutMs: 10_000 });
  const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: source, timeoutMs: 10_000 })).stdout.trim();
  return `training-tool@git+${pathToFileURL(source).href}#${commit}`;
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(file)); else if (entry.isFile()) files.push(file);
  }
  return files;
}
