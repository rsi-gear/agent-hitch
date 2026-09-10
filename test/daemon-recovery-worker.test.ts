import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonServer } from "../src/daemon/index.js";
import { RemoteWorkerHttpClient } from "../src/control-plane/index.js";
import { statePaths } from "../src/foundation/index.js";

test("workers can authenticate and reconnect while daemon recovery still gates new tasks", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-recovery-worker-"));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = new DaemonServer({ root, port: 0, maxConcurrent: 1,
    discoverHarnesses: async () => { enter(); await gate; return []; }, logger: () => {} });
  const startup = server.start();
  t.after(async () => { release(); await startup.catch(() => {}); await server.close(); await rm(root, { recursive: true, force: true }); });
  await entered;
  const baseUrl = `http://127.0.0.1:${server.port}`, adminToken = (await readFile(statePaths(root).token, "utf8")).trim();
  assert.equal((await (await fetch(`${baseUrl}/health`)).json() as { status: string }).status, "starting");
  const tasks = await fetch(`${baseUrl}/v1/evals`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(tasks.status, 503); assert.equal((await tasks.json() as { error: { code: string } }).error.code, "daemon_recovering");
  const zero = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  const capacity = { ...zero, cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1 };
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration: {
    schema_version: "1", worker_id: "worker_reconnect", provider: "remote-docker", collision_domain_id: "docker-engine:remote",
    platforms: [`${process.platform}-${process.arch}`], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: false, model_proxy: false, isolated_same_task_attempts: false }, task_membership: ["known"],
    capacity: { total: capacity, reserved_for_system: zero, allocatable: capacity },
  } });
  const worker = new RemoteWorkerHttpClient({ baseUrl, credential });
  await worker.heartbeat(zero, []); assert.deepEqual(await worker.listOffers(), []);
  assert.equal((await fetch(`${baseUrl}/v1/workers/${credential.worker_id}/offers?generation=${credential.generation}`)).status, 401);
  release(); await startup;
  assert.equal((await (await fetch(`${baseUrl}/health`)).json() as { status: string }).status, "running");
  assert.equal((await fetch(`${baseUrl}/v1/workers`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 200);
});
