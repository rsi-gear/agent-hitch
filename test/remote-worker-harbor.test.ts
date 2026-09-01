import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { runEval } from "../src/evals/index.js";
import { statePaths } from "../src/foundation/index.js";
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

async function waitFor<T>(operation: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await operation();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for remote Harbor eval");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
