import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { RemoteWorkerHttpClient, RemoteWorkerRunner, writeRemoteWorkerCredential } from "../src/control-plane/index.js";
import type { ExecutionObservationSourceV2 } from "../src/domain/index.js";
import { LocalExecutionObserver } from "../src/workers/index.js";
import { runCommand, sha256JSON, statePaths } from "../src/foundation/index.js";
import { observationFixture, observationRegistration, OBSERVATION_ZERO, waitObservation } from "../test-support/execution-observation.js";

const cli = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
const nonce = "b".repeat(32);
function controllerObserver(): ExecutionObservationSourceV2 {
  return { initialize: async () => {}, observeRuntime: async () => observationFixture().runtime,
    observe: async () => { throw new Error("remote provider observation must not probe Docker on the controller"); } };
}

test("remote observation is worker-authenticated and a slow probe does not stop runner heartbeats", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-worker-observation-http-"));
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {}, executionObserver: controllerObserver() });
  await server.start();
  const stop = new AbortController(); let running: Promise<void> | undefined;
  t.after(async () => { stop.abort(); await running; await server.close(); await rm(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.port}`, registration = observationRegistration();
  const adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl, credential }), admin = await daemonClient(root);
  const endpoint = `${baseUrl}/v2/workers/${credential.worker_id}/execution-observation?generation=1`;
  for (const headers of [{}, { authorization: `Bearer ${adminToken}` }]) assert.equal((await fetch(endpoint, { headers })).status, 401);
  const wrongGeneration = await fetch(endpoint.replace("generation=1", "generation=2"), { headers: { authorization: `Bearer ${credential.token}` } });
  assert.equal((await wrongGeneration.json() as { error: { code: string } }).error.code, "worker_generation_mismatch");
  assert.equal(await client.pollExecutionObservation(stop.signal), null);
  let probes = 0, finishProbe!: () => void;
  const workerObserver: ExecutionObservationSourceV2 = {
    initialize: async () => {}, observeRuntime: async () => observationFixture().runtime,
    observe: async signal => {
      probes += 1;
      await new Promise<void>((resolve, reject) => {
        finishProbe = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return observationFixture();
    },
  };
  let heartbeats = 0;
  const heartbeat = client.heartbeat.bind(client);
  client.heartbeat = async (...args) => { await heartbeat(...args); heartbeats += 1; };
  const errors: unknown[] = [];
  const runner = new RemoteWorkerRunner({ client, capacity: registration.capacity.allocatable, signal: stop.signal, pollIntervalMs: 50, heartbeatIntervalMs: 50,
    executionObserver: workerObserver, execute: async () => { throw new Error("an observation must not execute work"); }, onError: error => errors.push(error) });
  running = runner.run();
  const observing = admin.request("/v2/execution-observation", { method: "POST", body: JSON.stringify({ schema_version: "2", provider: registration.provider, nonce }) });
  void observing.catch(() => {});
  await waitObservation(async () => probes === 1);
  const before = heartbeats;
  await waitObservation(async () => heartbeats >= before + 3);
  assert.equal(probes, 1);
  const record = (await admin.request(`/v1/workers/${credential.worker_id}`)).worker as { worker: { capacity: { allocated: unknown } }; active_leases: unknown[] };
  assert.deepEqual(record.worker.capacity.allocated, OBSERVATION_ZERO); assert.deepEqual(record.active_leases, []);
  finishProbe();
  const result = await observing;
  assert.equal(result.nonce, nonce); assert.equal(result.generation, 1); assert.equal(result.provider, registration.provider);
  assert.deepEqual(result.worker_runtime, observationFixture().runtime);
  assert.equal(result.environment_digest, sha256JSON(result.environment));
  assert.equal(JSON.stringify(result).includes(credential.token), false);
  assert.deepEqual(errors, []);
});

test("packaged worker CLI observes its own executable selections and returns fresh evidence through the public CLI", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-packaged-worker-observation-"));
  const workerRoot = path.join(root, "worker-state"), harbor = path.join(root, "harbor"), docker = path.join(root, "docker"), info = path.join(root, "info.json");
  await writeFile(harbor, `#!${process.execPath}\nconsole.log('harbor 0.21.0');\n`, { mode: 0o755 });
  await writeFile(info, JSON.stringify({ ID: "packaged-worker-engine-1", ServerVersion: "28.1.0", OSType: "linux", Architecture: "x86_64" }));
  await writeFile(docker, `#!${process.execPath}\nif(process.argv[2]==='info') process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(info)})); else if(process.argv.slice(2).join(' ')==='buildx version') console.log('buildx v0.23.0'); else process.exit(42);\n`, { mode: 0o755 });
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => {}, executionObserver: new LocalExecutionObserver({ root }) });
  await server.start();
  const baseUrl = `http://127.0.0.1:${server.port}`, registration = observationRegistration();
  const adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration });
  const registrationFile = path.join(root, "registration.json"), credentialFile = path.join(root, "worker-credential.json");
  await writeFile(registrationFile, JSON.stringify(registration)); await writeRemoteWorkerCredential(credentialFile, credential);
  const child = spawn(process.execPath, [cli, "--root", workerRoot, "worker", "run", "--server", baseUrl,
    "--registration", registrationFile, "--credential-file", credentialFile, "--harbor", harbor, "--docker", docker, "--poll-interval", "50ms", "--heartbeat-interval", "100ms"],
  { env: { ...process.env, HITCH_HARBOR_PATH: "/wrong/controller/harbor", HITCH_DOCKER_PATH: "/wrong/controller/docker" }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); }); child.stderr.on("data", chunk => { errors += chunk.toString(); });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; await server.close(); await rm(root, { recursive: true, force: true }); });
  await waitObservation(async () => output.includes("Running worker_observed"));
  const observe = async (requestNonce: string) => JSON.parse((await runCommand(process.execPath,
    [cli, "--root", root, "worker", "observe", registration.provider, "--nonce", requestNonce, "--json"], { timeoutMs: 45_000 })).stdout);
  const first = await observe(nonce);
  assert.equal(first.worker_id, registration.worker_id); assert.equal(first.generation, 1);
  assert.equal(first.environment.docker.engine_id, "packaged-worker-engine-1");
  assert.equal(first.worker_runtime.unchanged, true); assert.equal(first.daemon_runtime.unchanged, true);
  assert.equal(first.worker_runtime.current.runtime_id, first.daemon_runtime.current.runtime_id);
  assert.equal(JSON.stringify(first).includes(workerRoot), false); assert.equal(JSON.stringify(first).includes(credential.token), false);
  await writeFile(info, JSON.stringify({ ID: "packaged-worker-engine-2", ServerVersion: "28.1.0", OSType: "linux", Architecture: "x86_64" }));
  const second = await observe("c".repeat(32));
  assert.equal(second.nonce, "c".repeat(32)); assert.equal(second.environment.docker.engine_id, "packaged-worker-engine-2");
  assert.notEqual(second.environment_digest, first.environment_digest);
  child.kill("SIGTERM"); await exited;
  assert.equal(errors, "");
});
