import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RemoteWorkerHttpClient, RemoteWorkerRunner } from "../src/control-plane/index.js";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { runEval as runEvalProduction, rerunEval, verifyImportedRemoteVerifierSource } from "../src/evals/index.js";
import type { RunEvalOptions } from "../src/evals/index.js";
import type { EvalTrialRefV1 } from "../src/domain/index.js";
import { atomicWriteJSON, sha256JSON, statePaths, runCommand } from "../src/foundation/index.js";
import { parseTrainingBinding, trainingProxyIdentity, registerTrainingEndpoint } from "../src/model-access/index.js";
import { releaseRemoteHarborOffer, remoteHarborWorker } from "../src/workers/index.js";
import { parseRemoteHarborWorkSpec } from "../src/workers/remote-harbor-work-spec.js";
import { forceRemove, prepareHostHarborArtifactForTest, writeFakeHarbor, writeFakeNpm } from "../test-support/helpers.js";
import { verifyRemoteModelRecovery, verifyRemoteRerunDaemonRecovery } from "../test-support/remote-model-recovery.js";

import { writeResourceInspector, writeEmptyDocker, writeCaptureHarbor, writeExportedBundle } from "../test-support/remote-harbor-model.js";

const ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
const TRIAL = { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const runEval = (options: RunEvalOptions) => runEvalProduction({ ...options, harborArtifactBuilder: prepareHostHarborArtifactForTest });

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
  await server.close();
  for (const root of [controllerRoot, workerRoot]) {
    for (const file of await regularFiles(root)) {
      assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `remote credential leaked into ${path.relative(root, file)}`);
    }
  }
});

for (const mode of ["api", "api-verifier-source", "managed", "managed-verifier-source-recovery", "training", "training-verifier-source", "api-repair", "managed-repair", "managed-recovery", "training-recovery"]) test(`packaged remote worker captures and imports ${mode} model evidence`, async (t) => {
  const managed = mode.startsWith("managed"), training = mode.startsWith("training"), repair = mode.endsWith("repair");
  const captureSource = mode.includes("verifier-source");
  const inferenceId = `sha256:${"8".repeat(64)}` as const, modelId = `sha256:${"9".repeat(64)}` as const;
  const modelNode = { schema_version: "2" as const, node_id: "model-test", generation: "generation-1", runtime_digest: inferenceId, launcher: "process" as const };
  let acquisitions = 0, releases = 0, generations = 0;
  const controllerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-capture-controller-"));
  const workerRoot = await mkdtemp(path.join(tmpdir(), "hitch-remote-capture-worker-"));
  t.after(() => Promise.all([forceRemove(controllerRoot), forceRemove(workerRoot)]));
  const dataset = path.join(controllerRoot, "dataset");
  await mkdir(path.join(dataset, "one"), { recursive: true });
  await writeFile(path.join(dataset, "one", "task.toml"), captureSource ? '[verifier]\nenvironment_mode = "separate"\n' : "");
  const trainingBinding = parseTrainingBinding({ kind: "training-external", bindingId: "remote_training", trainingRunId: "train_remote",
    policyLeaseRef: { uri: `cas:${inferenceId}`, digest: inferenceId, mediaType: "application/json" }, expectedPolicyVersion: "runtime/step-1",
    fencingToken: "test-fence", expiresAt: new Date(Date.now() + 60_000).toISOString(), endpointRef: "hitch-training:remote_training",
    credentialRef: "hitch-training:remote_training", generationContractDigest: inferenceId, requiredCapture: "exact-policy-tokens-v1",
    api: "chat-completions", maxOutputTokens: 16, maxEpisodeSteps: 4 });
  const harnessRef = training ? await trainingHarnessRef(controllerRoot) : "codex@version:1.2.3";
  let boundRun: string | undefined;
  const npm = await writeFakeNpm(controllerRoot, { packageName: "@openai/codex", binName: "codex" });
  const inspector = await writeResourceInspector(controllerRoot);
  const docker = await writeEmptyDocker(controllerRoot);
  const harbor = await writeCaptureHarbor(controllerRoot, repair, captureSource);
  const secret = "sk-remote-capture-secret-value-123456789";
  const upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (training) {
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/lease") {
          response.end(JSON.stringify({ schemaVersion: 1, trainingRunId: trainingBinding.trainingRunId, policyVersion: trainingBinding.expectedPolicyVersion,
            fencingToken: trainingBinding.fencingToken, state: "serving", generationContractDigest: inferenceId, capture: trainingBinding.requiredCapture })); return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (request.url === "/v1/hitch/run") {
          assert.ok(!boundRun || boundRun === body.runId); boundRun = body.runId;
          response.end(JSON.stringify({ runId: boundRun, policyVersion: trainingBinding.expectedPolicyVersion })); return;
        }
        assert.equal(request.url, "/v1/chat/completions"); assert.ok(boundRun); generations++;
        assert.equal(request.headers["idempotency-key"], `${boundRun}-${generations - 1}`);
        assert.equal(body.model, trainingBinding.expectedPolicyVersion);
        if (generations > 1) assert.match(body.messages.at(-1).content, new RegExp(`remote-tool-${generations - 1}`));
        response.setHeader("x-gear-receipt-id", `receipt-${generations}`);
        response.end(JSON.stringify({ model: trainingBinding.expectedPolicyVersion, choices: [{ finish_reason: generations < 3 ? "tool_calls" : "stop",
          message: generations < 3 ? { role: "assistant", content: null, tool_calls: [{ id: `call-${generations}`, type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: `printf remote-tool-${generations}` }) } }] } : { role: "assistant", content: "done" } }] })); return;
      }
      generations++;
      if (managed) {
        assert.equal(request.headers.authorization, `Bearer ${secret}`);
        assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).model, "hitch-wire-model");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "remote-effective", output: Buffer.concat(chunks).toString("utf8"), ...(!managed ? { api_key: secret } : {}) }));
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
    OPENAI_BASE_URL: managed || training ? "http://127.0.0.1:1/v1" : `${upstreamUrl}/v1`, OPENAI_API_KEY: managed || training ? "foreign-worker-key" : secret,
  };
  const scopes: string[] = [];
  const inferenceCoordinator: import("../src/domain/index.js").ManagedInferenceCoordinator = {
    acquire: async input => {
        acquisitions++; scopes.push(input.cache_scope_owner); assert.deepEqual(input.selection.model_node, modelNode);
        assert.equal(input.selection.inference_id, inferenceId);
        return {
          binding: { kind: "managed-node" as const, model_node: modelNode, inference_id: inferenceId, api: "responses" as const,
            base_url: `${upstreamUrl}/v1`, wire_model: "hitch-wire-model", credential_env_name: "HITCH_LOCAL_MODEL_TOKEN",
            capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text" as const] } },
          credential: secret, lock: { inference_id: inferenceId, model_id: modelId, model_node: modelNode, generation: { max_output_tokens: 16 } } as never,
          service_id: `inference_${"a".repeat(32)}`, service_epoch: 1, release: async () => { releases++; },
        };
      }
  };
  const serverOptions: ConstructorParameters<typeof DaemonServer>[0] = {
    root: controllerRoot, port: 0, maxConcurrent: 1, logger: () => {},
    resourceCapacity: repair ? { cpu_millis: 100, memory_bytes: 64 * 1024 ** 2, container_slots: 0, build_slots: 1 } : { ...TRIAL, build_slots: 1 }, evalTrialResources: TRIAL,
    evalExecutor: (options) => runEval({ ...options, harborExecutable: harbor, env: workerEnv,
      ...(managed ? { inferenceCoordinator } : {}),
    }),
    evalRerunExecutor: (options) => rerunEval({ ...options, harborExecutable: harbor, env: workerEnv,
      ...(managed ? { inferenceCoordinator } : {}),
    }),
  };
  const server = new DaemonServer(serverOptions);
  await server.start();
  if (training) await registerTrainingEndpoint(controllerRoot, { schema_version: "1", binding: trainingBinding, base_url: `${upstreamUrl}/v1`, credential: secret });
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const adminToken = (await readFile(statePaths(controllerRoot).token, "utf8")).trim();
  const registration = {
    schema_version: "1" as const, worker_id: "worker_harbor_capture", provider: "remote-docker",
    collision_domain_id: "docker-engine:remote-capture", platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false,
      ...(repair ? { physical_work: "2" as const } : {}),
      ...(captureSource ? { verifier_source: "2" as const } : {}),
      ...(managed ? { managed_model_node: "2" as const } : {}),
      ...(training ? { training_external_binding: "2" as const } : {}) },
    task_membership: ["known" as const], capacity: { total: TRIAL, reserved_for_system: ZERO, allocatable: TRIAL },
  };
  const credential = await RemoteWorkerHttpClient.register({ baseUrl, adminToken, registration });
  const client = new RemoteWorkerHttpClient({ baseUrl, credential });
  const admin = await daemonClient(controllerRoot);
  const submitted = await admin.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify({
      request: {
        dataset, harness_ref: harnessRef, model: managed ? "local/test" : training ? `training/${trainingBinding.bindingId}` : "openai/remote", max_concurrent: 1,
        ...(managed ? { local_inference: { inference_id: inferenceId, model_node: modelNode } } : {}),
        ...(training ? { training_binding: trainingBinding } : {}),
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
    ...(managed ? { managed: { inference_id: inferenceId, model_id: modelId, model_node: modelNode } } : {}),
    ...(training ? { training: trainingProxyIdentity(trainingBinding), harnessRef } : {}),
  });
  const execution = { root: workerRoot, env: workerEnv, harborExecutable: harbor, dockerExecutable: docker, trialBundleGraceMs: 0 };
  const workerErrors: string[] = [];
  const workerController = new AbortController();
  const runner = new RemoteWorkerRunner({
    client, capacity: TRIAL, execute: async input => {
      const spec = JSON.parse(input.inputs.get("work-spec")!.toString());
      assert.equal(spec.schema_version, managed || training || captureSource ? "2" : "1");
      assert.equal(spec.verifier_source, captureSource ? "2" : undefined);
      assert.throws(() => parseRemoteHarborWorkSpec({ ...spec, work: { ...spec.work, task_ids: ["wrong-task"] } }, input.offer), /work graph/);
      if (training) {
        assert.throws(() => parseRemoteHarborWorkSpec({ ...spec, request: { ...spec.request, infrastructure_retries: 1 } }, input.offer), /single-attempt/);
        assert.throws(() => parseRemoteHarborWorkSpec({ ...spec, request: { ...spec.request, training_binding: { ...spec.request.training_binding, fencingToken: "other" } } }, input.offer), /single-attempt/);
      }
      if (managed) {
        assert.throws(() => parseRemoteHarborWorkSpec({ ...spec, model_binding: { ...spec.model_binding, credential: "private" } }, input.offer), /binding fields/);
        assert.throws(() => parseRemoteHarborWorkSpec({ ...spec, model_binding: { ...spec.model_binding, model_node: { ...modelNode, generation: "changed" } } }, input.offer), /differs from its request/);
      }
      return remoteHarborWorker(execution)(input);
    }, once: true,
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
  assert.equal((status.result as { status: string }).status, repair ? "failed" : "succeeded", `${JSON.stringify(status.result)}\nrun result: ${diagnostic}\nimport errors: ${importErrors.join("\n")}\nworker files: ${workerFiles.map((file) => path.relative(workerRoot, file)).join("\n")}`);
  assert.equal(trial?.run_id, runId);
  if (captureSource) {
    const files = await regularFiles(path.join(controllerRoot, "evals", evalId, "harbor"));
    const manifestFile = files.find(file => path.basename(file) === "verifier-source.json");
    assert.ok(manifestFile, "controller must retain source evidence after worker release");
    const source = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.equal(source.status, "available"); assert.equal(source.run_id, runId);
    assert.equal(await readFile(path.join(path.dirname(manifestFile), "verifier-source/artifacts/patch.diff"), "utf8"), "original candidate patch\n");
    assert.equal(source.source_result_digest, sha256JSON(JSON.parse(await readFile(path.join(path.dirname(manifestFile), "result.json"), "utf8"))));
    const frozenRequest = JSON.parse(await readFile(path.join(controllerRoot, "evals", evalId, "request.json"), "utf8"));
    assert.deepEqual(await verifyImportedRemoteVerifierSource({ root: controllerRoot, runId,
      trialDirectory: path.dirname(manifestFile), taskDirectory: path.join(frozenRequest.dataset, "one") }), source);
    assert.equal((await client.listOffers()).length, 0);
  }
  const runDirectory = path.join(controllerRoot, "runs", runId);
  const ref = JSON.parse(await readFile(path.join(runDirectory, "interactions", "interaction.ref.json"), "utf8")) as {
    topology: string; completeness: string; interaction_count: number;
  };
  assert.equal(ref.topology, "in-sandbox");
  assert.equal(ref.completeness, "complete");
  assert.equal(ref.interaction_count, training ? 3 : 1);
  assert.equal(generations, training ? 3 : 1);
  if (training) {
    assert.equal(boundRun, runId);
    const manifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.training_external, trainingProxyIdentity(trainingBinding));
  }
  if (managed) {
    assert.equal(acquisitions, 1); assert.equal(releases, 1);
    const manifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.model.inference_id, inferenceId); assert.deepEqual(manifest.model.model_node, modelNode);
    assert.equal(manifest.model.effective_id, modelId);
  }
  if (mode.endsWith("recovery")) {
    await verifyRemoteModelRecovery(controllerRoot, evalId, runId);
    assert.equal(generations, training ? 3 : 1, "recovering acknowledged results must not call the model again");
    if (captureSource) {
      const files = await regularFiles(path.join(controllerRoot, "evals", evalId, "harbor"));
      const sourceFile = files.find(file => path.basename(file) === "verifier-source.json")!;
      const request = JSON.parse(await readFile(path.join(controllerRoot, "evals", evalId, "request.json"), "utf8"));
      assert.equal((await verifyImportedRemoteVerifierSource({ root: controllerRoot, runId, trialDirectory: path.dirname(sourceFile),
        taskDirectory: path.join(request.dataset, "one") })).status, "available");
    }
  }
  await assert.rejects(admin.request(`/v1/evals/${evalId}/reruns`, {
    method: "POST", body: JSON.stringify({ rerun_type: "verifier-only", selector: { mode: "invalid" } }),
  }), (error: unknown) => (error as { code?: string }).code === (training ? "training_rerun_fenced" : "remote_rerun_unavailable"));
  if (repair) {
    const rerunId = `rerun_${"b".repeat(32)}`, repairedTrialId = "one__random-2";
    const repairedRunId = `run_${sha256JSON({ evalId, trialId: repairedTrialId }).slice(7, 39)}`;
    const bundle = path.join(controllerRoot, "capture-bundles", evalId);
    await forceRemove(bundle);
    await writeExportedBundle({ bundle, runId: repairedRunId, evalId, trialId: repairedTrialId, taskId: "one",
      benchmarkId: normalized.benchmark_id, benchmarkRevision: normalized.benchmark_revision,
      ...(managed ? { managed: { inference_id: inferenceId, model_id: modelId, model_node: modelNode } } : {}),
    });
    await admin.request(`/v1/evals/${evalId}/reruns`, { method: "POST", body: JSON.stringify({ rerun_id: rerunId, selector: { mode: "invalid" } }) });
    const repairAbort = new AbortController(); t.after(() => repairAbort.abort());
    const repairWorker = new RemoteWorkerRunner({ client, capacity: TRIAL, execute: remoteHarborWorker(execution), once: true,
      releaseUnknown: offer => releaseRemoteHarborOffer(execution, offer), signal: repairAbort.signal,
      pollIntervalMs: 50, heartbeatIntervalMs: 50, retryIntervalMs: 50 }).run();
    const completed = await waitFor(async () => {
      const current = await admin.request(`/v1/evals/${evalId}/reruns/${rerunId}`);
      return ["completed", "failed", "cancelled"].includes(String((current.state as { status?: string }).status)) ? current : undefined;
    }, 20_000);
    if ((completed.state as { status: string }).status !== "completed") repairAbort.abort();
    await repairWorker;
    assert.equal((completed.state as { status: string }).status, "completed", JSON.stringify(completed));
    assert.deepEqual((completed.result as { repaired_tasks: string[] }).repaired_tasks, ["one"]);
    assert.equal((completed.result as { eval_status: string }).eval_status, "succeeded");
    const progress = JSON.parse(await readFile(path.join(controllerRoot, "evals", evalId, "progress.json"), "utf8"));
    assert.equal(progress.trials[0].run_id, repairedRunId);
    const executionEvidence = JSON.parse(await readFile(path.join(controllerRoot, "runs", repairedRunId, "execution.json"), "utf8"));
    assert.equal(executionEvidence.provider, "remote-docker"); assert.equal(executionEvidence.worker_id, registration.worker_id);
    const initialExecution = JSON.parse(await readFile(path.join(runDirectory, "execution.json"), "utf8"));
    assert.notEqual(executionEvidence.work_id, initialExecution.work_id); assert.notEqual(executionEvidence.lease_id, initialExecution.lease_id);
    if (managed) { assert.deepEqual(scopes, [evalId, `${evalId}:${rerunId}`]); assert.equal(acquisitions, 2); assert.equal(releases, 2); }
    if (managed) await verifyRemoteModelRecovery(controllerRoot, evalId, repairedRunId, { rerunId, prior: (status.result as { trials: EvalTrialRefV1[] }).trials[0]! });
    await verifyRemoteRerunDaemonRecovery({ server, options: serverOptions, root: controllerRoot, evalId, rerunId,
      prior: (status.result as { trials: EvalTrialRefV1[] }).trials[0]! });
    if (managed) { assert.equal(acquisitions, 2, "completion recovery must not restart the model service"); assert.equal(releases, 2); }
    assert.equal(generations, 2);
  }
  await server.close();
  for (const root of [controllerRoot, workerRoot]) {
    for (const file of await regularFiles(root)) {
      if ((managed || training) && root === controllerRoot && (file.includes(`${path.sep}model-routes${path.sep}`)
        || file.includes(`${path.sep}training${path.sep}bindings${path.sep}`))) continue;
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

async function trainingHarnessRef(root: string): Promise<string> {
  const source = path.join(root, "training-source");
  await mkdir(path.join(source, "integrations/training-tool"), { recursive: true });
  await writeFile(path.join(source, "integrations/training-tool/cli.js"), await readFile("integrations/training-tool/cli.js"), { mode: 0o755 });
  await writeFile(path.join(source, "package.json"), '{"type":"module"}');
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Hitch Test", "-c", "user.email=test@hitch.invalid", "commit", "-m", "training fixture"]]) {
    await runCommand("git", args, { cwd: source });
  }
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: source });
  return `training-tool@git+${pathToFileURL(source).href}#${result.stdout.trim()}`;
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
