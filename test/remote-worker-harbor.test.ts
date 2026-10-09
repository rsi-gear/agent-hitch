import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { runEval as runEvalProduction } from "../src/evals/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import { statePaths } from "../src/foundation/index.js";
import { releaseRemoteHarborOffer, remoteHarborWorker } from "../src/workers/index.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import { writeResourceInspector, writeEmptyDocker } from "../test-support/remote-harbor-model.js";
import { regularFiles, waitFor } from "../test-support/remote-worker-harbor.js";
import { fixtureImage, fixtureImageManifest, fixtureReference, resourceFixture } from "../test-support/resource-fixture.js";
import { configuredResourceStore, hash, resourceRequest, type ResourceRoot } from "../src/resources/index.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const TRIAL = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const runEval = (options: RunEvalOptions) => runEvalProduction({ ...options, harborArtifactBuilder: prepareHostHarborArtifactForTest });

for (const resourceAware of [false, true]) test(`packaged worker executes a staged ${resourceAware ? "resource v3" : "legacy"} remote eval through Harbor and returns a verifiable result bundle`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-remote-controller-"));
  const fixture = resourceAware ? await resourceFixture(directory, 1, ["one"]) : undefined;
  const controllerRoot = fixture?.store.root ?? directory;
  const workerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-host-"));
  t.after(() => Promise.all([forceRemove(directory), forceRemove(workerRoot)]));
  const dataset = fixture?.source ?? path.join(controllerRoot, "dataset");
  if (!fixture) { await mkdir(path.join(dataset, "one"), { recursive: true }); await writeFile(path.join(dataset, "one", "task.toml"), ""); }
  const secret = "controller-only-short-ttl-secret";
  const npm = await writeFakeNpm(controllerRoot);
  const harbor = await writeFakeHarbor(controllerRoot, { leakEnvName: "CUSTOM_REMOTE_SECRET" });
  const inspector = await writeResourceInspector(controllerRoot);
  const docker = await writeEmptyDocker(controllerRoot);
  if (resourceAware) {
    const inspection = { Id: hash("fixture OCI config"), Os: "linux", Architecture: "amd64", RepoDigests: [fixtureReference], RootFS: { Layers: [] } };
    await writeFile(docker, (await readFile(docker, "utf8")).replace("process.exit(0);", `if (args[0] === "image" && args[1] === "inspect") process.stdout.write(${JSON.stringify(JSON.stringify(inspection))});\nprocess.exit(0);`));
    const previous = process.env.HITCH_DOCKER_PATH; process.env.HITCH_DOCKER_PATH = docker;
    t.after(() => { if (previous === undefined) delete process.env.HITCH_DOCKER_PATH; else process.env.HITCH_DOCKER_PATH = previous; });
    for (const root of [controllerRoot, workerRoot]) {
      await resourceRequest(root, "configure", { protocol: "hitch-resource-host@1", transport: { [fixtureImage.manifestDigest]: fixtureReference }, imagePolicy: "cache-only", platform: fixtureImage.platform, workspace: { mode: "copy" } });
      const proofs = path.join(root, "store/benchmark-resources/oci-manifests"); await mkdir(proofs, { recursive: true });
      await writeFile(path.join(proofs, `${fixtureImage.manifestDigest.slice(7)}.json`), JSON.stringify({ manifest: fixtureImageManifest }));
    }
    // Observe the actual private tree passed through the worker/backend wrapper.
    const check = `const task = path.join(config.datasets[0].path, "one");
if (!fs.readFileSync(path.join(task,"environment/candidate/data/input.txt"),"utf8").startsWith("shared input") || fs.existsSync(path.join(task,"environment/candidate/answer.txt"))) throw new Error("resource role isolation failed");
if (fs.readFileSync(path.join(task,"tests/answer.txt"),"utf8") !== "verifier only") throw new Error("verifier resource missing");
fs.writeFileSync(${JSON.stringify(path.join(workerRoot, "materialization-observed"))}, task);`;
    await writeFile(harbor, (await readFile(harbor, "utf8")).replace("const output = path.join(config.jobs_dir, config.job_name);", `${check}\nconst output = path.join(config.jobs_dir, config.job_name);`));
  }
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
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false, ...(resourceAware ? { benchmark_resources: "1" as const } : {}) },
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
  if (resourceAware) {
    assert.match(await readFile(path.join(workerRoot, "materialization-observed"), "utf8"), /benchmark-resources\/workspaces/);
    const store = (await configuredResourceStore(workerRoot)).store;
    assert.equal((await readdir(path.join(store.directory, "workspaces"))).length, 0, "sealed diagnostic execution must release its private workspace");
    const retained = JSON.parse(await readFile(path.join(controllerRoot, "runs", trials[0]!.run_id, "resource.execution.json"), "utf8"));
    const controllerStore = (await configuredResourceStore(controllerRoot)).store;
    const root = await controllerStore.readRecord<ResourceRoot>("roots", `run:${trials[0]!.run_id}`);
    assert.equal(root?.state, "active"); assert.equal(root?.purpose, "sealed-run");
    assert.ok(root?.closure.objectDigests.includes(retained.materializedTree.manifestDigest));
    assert.ok(retained.proofObjects.reduce((n: number, p: { size: number }) => n + p.size, 0) < 13_000, "public input bytes must not be sent back in result JSON");
    await rm(path.join(workerRoot, "store/benchmark-resources"), { recursive: true });
    for (const digest of root!.closure.objectDigests) await controllerStore.objects.verify(digest);
  }
  await server.close();
  for (const root of [controllerRoot, workerRoot]) {
    for (const file of await regularFiles(root)) {
      assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `remote credential leaked into ${path.relative(root, file)}`);
    }
  }
});
