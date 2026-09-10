import assert from "node:assert/strict";
import { remoteCanaryWorker } from "./canary-worker-host.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { readExecutionLeases, reapOwnedDockerResources, runEval, validateEvalId } from "../src/evals/index.js";
import { parseTrainingBinding } from "../src/model-access/index.js";
import { atomicWriteJSON, runCommand, sha256JSON, statePaths } from "../src/foundation/index.js";

// Real Harbor/Docker and public worker CLI against a separately supervised native gateway.
// The node independently verifies exact receipts; neither script certifies a training runtime.
const python = process.env.HITCH_HARBOR_TEST_PYTHON;
const image = process.env.HITCH_TRAINING_CANARY_IMAGE;
assert.ok(python && image, "Set HITCH_HARBOR_TEST_PYTHON and HITCH_TRAINING_CANARY_IMAGE (local bash-capable image)");
const harbor = path.join(path.dirname(python), "harbor");
const cli = path.resolve("dist/bin/hitch.js");
const root = await mkdtemp(path.join(tmpdir(), "hitch-native-remote-training-"));
const externalFile = process.env.HITCH_NATIVE_CANARY_BINDING;
const output = process.env.HITCH_NATIVE_CANARY_OUTPUT;
const taskInputFile = process.env.HITCH_NATIVE_CANARY_TASK_INPUT;
assert.ok(taskInputFile, "Set HITCH_NATIVE_CANARY_TASK_INPUT");
const taskInput = JSON.parse(await readFile(taskInputFile, "utf8")) as { kind: string; instruction: string; image_id: string };
assert.equal(taskInput.kind, "native-diagnostic-task-input");
assert.equal(typeof taskInput.instruction, "string");
assert.ok(externalFile && output, "Set HITCH_NATIVE_CANARY_BINDING and HITCH_NATIVE_CANARY_OUTPUT");
await mkdir(output, { recursive: true });
const external = JSON.parse(await readFile(externalFile, "utf8")) as { binding: unknown; credential: string; base_url: string };
const binding = parseTrainingBinding(external.binding);
const secret = external.credential;
const endpoint = new URL(external.base_url);
assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(endpoint.pathname, "/v1"); assert.match(secret, /^[a-f0-9]{64}$/);
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
assert.equal(inspected.Id, taskInput.image_id);
assert.equal(`${inspected.Os}/${inspected.Architecture}`, "linux/amd64");
const version = (await runCommand(python, ["-c", 'import importlib.metadata; print(importlib.metadata.version("harbor"))'], { timeoutMs: 10_000 })).stdout.trim();
assert.equal(version, "0.21.0");
const localEngine = (await runCommand("docker", ["info", "--format", "{{.ID}}"], { timeoutMs: 10_000 })).stdout.trim();
const remoteWorker = await remoteCanaryWorker(root, workerRoot);
const workerObservation = await remoteWorker?.observe(inspected.Id, localEngine);
const engine = workerObservation?.engine ?? localEngine;
const server = new DaemonServer({ root: controllerRoot, port: 0, maxConcurrent: 1,
  resourceCapacity: { ...resource, build_slots: 1 }, evalTrialResources: resource,
  evalExecutor: options => runEval({ ...options, harborExecutable: harbor, env }), logger: () => {} });
let worker: ReturnType<typeof spawn> | undefined;
let workerDone: Promise<number | null> | undefined;
const workerLog = createWriteStream(path.join(root, "worker.log"));
let evalId: ReturnType<typeof validateEvalId> | undefined;
let passed = false;
const summary: Record<string, unknown> = { kind: "native-harbor-training-transport-diagnostic", validated_gpu: false, worker_host: remoteWorker ? "ssh" : "local-process", root, harbor: version, image_id: inspected.Id, docker_engine_digest: sha256JSON(engine) };
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
  await atomicWriteJSON(bindingFile, { schema_version: "1", binding, base_url: external.base_url, credential: secret });
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
  const taskReward = result.trials[0]!.reward;
  assert.ok(taskReward === 0 || taskReward === 1, "the task verifier must return a valid binary reward");
  const boundRun = result.trials[0]!.run_id;
  const evidence = await runCommand(process.execPath, [cli, "--root", controllerRoot, "training", "evidence", boundRun!, "--json"], { env, timeoutMs: 10_000 });
  await writeFile(path.join(root, "training-evidence.json"), evidence.stdout);
  const nativeEvidence = JSON.parse(evidence.stdout) as { termination: string; training_external: { policy_version: string }; result: { trajectory: { path: string } } };
  assert.equal(nativeEvidence.termination, "terminated");
  assert.equal(nativeEvidence.training_external.policy_version, binding.expectedPolicyVersion);
  const trajectoryPath = nativeEvidence.result.trajectory.path;
  assert.ok(!path.isAbsolute(trajectoryPath) && !trajectoryPath.split("/").includes(".."));
  const trajectory = await readFile(path.join(controllerRoot, "runs", boundRun, trajectoryPath), "utf8");
  const events = trajectory.trim().split("\n").map(line => JSON.parse(line) as { data?: { provider_type?: string; native?: { receipt_id?: string } } });
  const toolCalls = events.filter(event => event.data?.provider_type === "tool.completed").length;
  const responses = events.filter(event => event.data?.provider_type === "provider.response");
  assert.ok(toolCalls >= 2 && responses.length >= 2, "two sequential tool calls and a subsequent model reply are required");
  assert.ok(responses.every(event => /^receipt_[a-f0-9]{32}$/.test(event.data?.native?.receipt_id ?? "")));
  const receiptIds = responses.map(event => event.data!.native!.receipt_id!);
  assert.equal(new Set(receiptIds).size, receiptIds.length);
  await writeFile(path.join(output, "trajectory.jsonl"), trajectory);
  await writeFile(path.join(output, "training-evidence.json"), evidence.stdout);
  const verifier = await runCommand(process.execPath, [cli, "--root", controllerRoot, "verifier", "inspect", boundRun, "--json"], { env, timeoutMs: 10_000 });
  await writeFile(path.join(output, "verifier.json"), verifier.stdout);
  await atomicWriteJSON(path.join(output, "eval-inspection.json"), current);

  const leases = await readExecutionLeases(path.join(controllerRoot, "evals", evalId));
  assert.equal(leases.length, 1); assert.equal(leases[0]!.state, "released");
  assert.ok(leases[0]!.release_confirmation);
  assert.equal(await Promise.race([workerDone, new Promise(resolve => setTimeout(() => resolve("timeout"), 10_000))]), 0);
  await remoteWorker?.collect();
  for (const directory of [path.join(controllerRoot, "runs"), path.join(controllerRoot, "evals"), workerRoot]) {
    for (const file of await regularFiles(directory)) assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `model credential leaked into ${file}`);
  }
  Object.assign(summary, { status: "passed", task_reward: taskReward, task_succeeded: taskReward === 1,
    eval_id: evalId, run_id: boundRun, model_calls: responses.length, tool_calls: toolCalls, receipt_ids: receiptIds, lease_id: leases[0]!.lease_id, private_model_credential_in_public_files: false });
  passed = true;
} catch (error) {
  Object.assign(summary, { status: "failed", error: error instanceof Error ? error.message : String(error) });
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
  await atomicWriteJSON(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary));
}
assert.equal(summary.cleanup_proven, true, "owned Docker resources were not all released");

async function prepareInputs(): Promise<string> {
  const task = path.join(dataset, "one"), source = path.join(root, "training-source");
  await mkdir(path.join(task, "environment"), { recursive: true }); await mkdir(path.join(task, "tests"));
  await writeFile(path.join(task, "instruction.md"), taskInput.instruction);
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
