import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DaemonServer, daemonClient } from "../src/daemon/index.js";
import { createEvalProgress, readEvalProgress, replaceInvalidEvalProgressTrial, mergeEvalProgressTrial, writeEvalProgress,
  selectRerunTrialSlots, endpointEvaluationAttemptId, readEndpointEvaluationAttempts, endpointAttemptRequest, admitEndpointEvaluationAttempt, evalRerunSemantics } from "../src/evals/index.js";
import type { EvalRerunResult, EndpointEvaluationAttemptV1, RunEvalOptions, RerunEvalOptions, EvalResult } from "../src/evals/index.js";
import type { EvalRequest, ReadyEndpointBindingV1, EvalTrialRefV1 } from "../src/domain/index.js";
import { persistTerminalEvalResult } from "../src/evals/eval-state.js";
import { cumulativeEndpointUsage } from "../src/evals/endpoint-usage.js";
import { publicEndpointBinding } from "../src/model-access/index.js";
import { atomicWriteJSON, readJSON, sha256JSON, delay } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";
import { controlledEndpointTrial } from "../test-support/controlled-endpoint-eval.js";

const execute = promisify(execFile), cli = path.resolve("dist/bin/hitch.js");
test("actual CLI and existing daemon repair deployment B only for invalid slots, preserving A reward zero, cost and new host credentials", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-endpoint-recovery-")); t.after(() => forceRemove(root));
  const calls: Array<{ model: string; task: string; authorization?: string }> = [];
  const secrets = new Map([["incarnation-a", "private-a"], ["incarnation-b", "private-b"]]);
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), task = body.messages.find((message: { role: string }) => message.role === "user")?.content ?? "probe";
    assert.equal(req.headers.authorization, `Bearer ${secrets.get(body.model)}`);
    if (task.startsWith("task:")) calls.push({ model: body.model, task, authorization: req.headers.authorization });
    if (body.model === "incarnation-a" && task === "task:repair") { res.writeHead(503); res.end('{"error":{"message":"service crashed"}}'); return; }
    const tool = body.tool_choice && body.tool_choice !== "none", usage = { prompt_tokens: 4, completion_tokens: 2 };
    const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: "probe", type: "function", function: { name: "hitch_verify", arguments: "{}" } }] } : { role: "assistant", content: "ready" };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: body.model, choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`, harness = `model-call@commit:${"a".repeat(40)}`;
  const dataset = path.join(root, "dataset"); for (const task of ["zero", "repair"]) { await mkdir(path.join(dataset, task), { recursive: true }); await writeFile(path.join(dataset, task, "task.toml"), ""); }
  let evalStarts = 0, rerunStarts = 0;
  const finish = async (evalId: string, request: EvalRequest, trials: EvalTrialRefV1[], startedAt: string) => {
    const directory = path.join(root, "evals", evalId), succeeded = trials.length === 2 && trials.every(trial => trial.observation_status === "valid");
    return persistTerminalEvalResult(directory, { schema_version: "1", eval_id: evalId, status: succeeded ? "succeeded" : "failed", exit_code: succeeded ? 0 : 13,
      benchmark_id: request.benchmark_id, benchmark_revision: request.benchmark_revision, dataset: request.dataset, trials, endpoint_binding: request.endpoint_binding,
      endpoint_attempts: await readEndpointEvaluationAttempts(directory, request), task_completed: true, started_at: startedAt, completed_at: new Date().toISOString(),
      usage: await cumulativeEndpointUsage(root, evalId, trials.flatMap(trial => trial.run_id ? [trial.run_id] : [])) });
  };
  const evalExecutor = async (options: RunEvalOptions) => {
    evalStarts++; const request = options.normalizedRequest!, evalId = options.evalId!, directory = path.join(root, "evals", evalId), started = new Date().toISOString();
    await atomicWriteJSON(path.join(directory, "plan.json"), { schema_version: "1", eval_id: evalId, dataset: request.dataset, benchmark_id: request.benchmark_id,
      benchmark_revision: request.benchmark_revision, tasks: ["zero", "repair"], attempts: 1, candidate: { endpoint_binding: request.endpoint_binding }, prepared_artifact: { artifact_id: sha256JSON("fixture") }, controller_runtime: { runtime_id: sha256JSON("fixture") } });
    let progress = createEvalProgress({ evalId, benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision, plannedTasks: 2, plannedTrials: 2, startedAt: started });
    for (const task of ["zero", "repair"]) { progress = mergeEvalProgressTrial(progress, await controlledEndpointTrial(root, evalId, request, task, false, options.signal)); await writeEvalProgress(directory, progress); }
    return await finish(evalId, request, progress.trials, started) as unknown as EvalResult;
  };
  const rerunExecutor = async (options: RerunEvalOptions): Promise<EvalRerunResult> => {
    rerunStarts++; const directory = path.join(root, "evals", options.evalId), original = await readJSON<EvalRequest>(path.join(directory, "request.json"));
    let progress = (await readEvalProgress(directory))!;
    const selected = selectRerunTrialSlots(["zero", "repair"], 1, progress, options.selector, { allowVerifierFailures: true });
    const request = endpointAttemptRequest(original, options.endpointAttempt);
    for (const slot of selected) { progress = replaceInvalidEvalProgressTrial(progress, await controlledEndpointTrial(root, options.evalId, request, slot.task_id, true, options.signal)); await writeEvalProgress(directory, progress, { terminalRepair: true }); }
    const result = await finish(options.evalId, original, progress.trials, progress.started_at), now = new Date().toISOString();
    return { schema_version: "1", kind: "eval-rerun", eval_id: options.evalId, rerun_id: options.rerunId!, rerun_type: "candidate-restart", semantics: evalRerunSemantics("candidate-restart"), status: "completed",
      selected_tasks: selected.map(slot => slot.task_id), selected_trials: selected, repaired_tasks: selected.map(slot => slot.task_id), repaired_trials: selected,
      remaining_invalid_tasks: [], remaining_invalid_trials: [], eval_status: result.status as "succeeded" | "failed", started_at: now, completed_at: now };
  };
  const server = new DaemonServer({ root, port: 0, logger: () => {}, maxConcurrent: 1,
    resourceCapacity: { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 1 }, evalExecutor, evalRerunExecutor: rerunExecutor });
  await server.start(); t.after(() => server.close());
  const json = async (args: string[], env: NodeJS.ProcessEnv = {}) => JSON.parse((await execute(process.execPath, [cli, "--root", root, ...args], { env: { ...process.env, ...env }, timeout: 20_000, maxBuffer: 2 ** 20 })).stdout);
  const binding = async (incarnation: string): Promise<ReadyEndpointBindingV1> => {
    const name = incarnation.replaceAll("-", "_"), authName = `TEST_${name.toUpperCase()}`;
    assert.equal(process.env[authName], undefined);
    const config = { schema_version: "1", base_url: base, wire_model: incarnation, api: "chat-completions", auth: { kind: "env" as const, name: authName }, capabilities: { streaming: false, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] } };
    const file = path.join(root, `${name}.json`); await atomicWriteJSON(file, config);
    const registered = await json(["models", "connect", "--name", name, "--file", file, "--persist-credential", "--json"], { [authName]: secrets.get(incarnation)! });
    await json(["models", "inspect", `endpoint/${name}@${registered.endpoint_revision}`, "--verify", "--json"]);
    return { ...registered, generation: { max_output_tokens: 1024, temperature: 0 }, connection: { base_url: base, auth: config.auth }, deployment_receipt: {
      schema_version: "1", model_digest: sha256JSON("same-immutable-model"), wire_model: incarnation, deployment_ref: incarnation, source: "controlled-deployer", service_config: { engine: "controlled-http", engine_version: "1" } } };
  };
  const a = await binding("incarnation-a"), bindingFile = path.join(root, "ready-a.json"), controlFile = path.join(root, "control.json"); await atomicWriteJSON(bindingFile, a);
  const control = { schema_version: "2", key: "controlled-logical-eval", subject_digest: sha256JSON("same subject and conditions"), sequence: 0, action: "start" };
  await atomicWriteJSON(controlFile, control);
  const admitted = await json(["eval", "submit", "--dataset", dataset, "--harness", harness, "--model", a.endpoint_ref, "--model-binding-file", bindingFile,
    "--attempts", "1", "--max-concurrent", "1", "--infrastructure-retries", "0", "--build-mode", "backend", "--control-file", controlFile]);
  const evalId = String(admitted.eval_id), client = await daemonClient(root);
  let first: Record<string, unknown> | undefined;
  for (let i = 0; i < 200; i++) { const current = await client.request(`/v1/evals/${evalId}`); if (current.result) { first = current; break; } await delay(20); }
  assert.ok(first?.result, JSON.stringify(first));
  const initial = first.result as { trials: EvalTrialRefV1[]; usage: Record<string, unknown> };
  assert.equal(initial.trials.find(trial => trial.task_id === "zero")?.reward, 0, JSON.stringify(initial));
  assert.equal(initial.trials.find(trial => trial.task_id === "repair")!.observation_status, "invalid");
  const requestBefore = await readFile(path.join(root, "evals", evalId, "request.json"), "utf8"), planBefore = await readFile(path.join(root, "evals", evalId, "plan.json"), "utf8");
  const b = await binding("incarnation-b"), attempt: EndpointEvaluationAttemptV1 = { schema_version: "1", id: endpointEvaluationAttemptId(publicEndpointBinding(b)), parent_id: endpointEvaluationAttemptId(publicEndpointBinding(a)), endpoint_binding: publicEndpointBinding(b) };
  const attemptFile = path.join(root, "endpoint-attempt.json"), rerunId = `rerun_${"b".repeat(32)}`;
  await atomicWriteJSON(attemptFile, { ...attempt, endpoint_binding: b });
  // Pause is durable; carrying a fresh binding cannot bypass its ordered fence.
  await atomicWriteJSON(controlFile, { ...control, sequence: 1, action: "pause" }); await json(["eval", "control", "--file", controlFile]);
  // Model a retained terminal cancellation projection after every old task ended.
  const sourceControl = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "control.json"));
  const sourceResult = await readJSON<Record<string, unknown>>(path.join(root, "evals", evalId, "result.json"));
  await atomicWriteJSON(path.join(root, "evals", evalId, "control.json"), { ...sourceControl, state: "cancelled" });
  await persistTerminalEvalResult(path.join(root, "evals", evalId), { ...sourceResult, status: "cancelled" });
  await atomicWriteJSON(controlFile, control);
  const args = ["eval", "rerun", evalId, "--invalid", "--daemon", "--rerun-id", rerunId, "--control-file", controlFile, "--endpoint-attempt-file", attemptFile];
  await assert.rejects(json(args), /eval_control_stale|newer eval command/); assert.equal(rerunStarts, 0);
  await atomicWriteJSON(controlFile, { ...control, sequence: 2 });
  // Inject a crash after attempt admission and before rerun submission persistence.
  await admitEndpointEvaluationAttempt(root, path.join(root, "evals", evalId), await readJSON(path.join(root, "evals", evalId, "request.json")), attempt, rerunId);
  assert.equal((await json(["eval", "inspect", evalId, "--json"])).pending_reruns, true, "unsubmitted frozen attempt remains pending");
  const repaired = await json(args); assert.equal(repaired.eval_status, "succeeded");
  await json(args); assert.equal(rerunStarts, 1); assert.equal(evalStarts, 1);
  const final = await json(["eval", "inspect", evalId, "--json"]); assert.equal(final.pending_reruns, false);
  const trials = final.result.trials as EvalTrialRefV1[];
  assert.deepEqual(trials.find(trial => trial.task_id === "zero"), initial.trials.find(trial => trial.task_id === "zero"));
  assert.equal(trials.find(trial => trial.task_id === "repair")!.observation_status, "valid");
  assert.equal(final.result.usage.requests, 3); assert.equal(initial.usage.requests, 2);
  assert.deepEqual(calls.map(call => [call.model, call.task]), [["incarnation-a", "task:zero"], ["incarnation-a", "task:repair"], ["incarnation-b", "task:repair"]]);
  assert.equal(await readFile(path.join(root, "evals", evalId, "request.json"), "utf8"), requestBefore);
  assert.equal(await readFile(path.join(root, "evals", evalId, "plan.json"), "utf8"), planBefore);
  for (const value of [first, final, repaired]) { assert.equal(JSON.stringify(value).includes("private-a"), false); assert.equal(JSON.stringify(value).includes("private-b"), false); assert.equal(JSON.stringify(value).includes(base), false); }
  await atomicWriteJSON(attemptFile, { ...attempt, endpoint_binding: { ...b, generation: { max_output_tokens: 2048 } } });
  await assert.rejects(json(args), /attempt identity differs|already belongs|eval_control_conflict/); assert.equal(rerunStarts, 1);
});

async function attemptFixture(t: import("node:test").TestContext) {
  const { connectEndpoint, resolveEndpoint, saveEndpointVerification } = await import("../src/model-access/index.js");
  const { validateEvalRequest } = await import("../src/evals/index.js");
  const root = await mkdtemp(path.join(tmpdir(), "hitch-attempt-contract-")); t.after(() => forceRemove(root));
  const evalId = `eval_${"a".repeat(32)}`, directory = path.join(root, "evals", evalId), dataset = path.join(root, "dataset");
  for (const task of ["zero", "repair"]) { await mkdir(path.join(dataset, task), { recursive: true }); await writeFile(path.join(dataset, task, "task.toml"), ""); }
  const binding = async (name: string) => {
    await connectEndpoint(root, name, { schema_version: "1", base_url: `http://127.0.0.1:1234/${name}`, wire_model: name, api: "chat-completions", auth: { kind: "none" },
      capabilities: { streaming: false, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] } });
    const ready = await resolveEndpoint(root, `endpoint/${name}`, { max_output_tokens: 1024 });
    await saveEndpointVerification(root, { schema_version: "1", endpoint_revision: ready.endpoint_revision, verified_at: new Date().toISOString(), api: ready.api, streaming: false, tool_calls: true, streamed_tool_calls: false });
    return { ...publicEndpointBinding(ready), deployment_receipt: { schema_version: "1" as const, model_digest: sha256JSON("same model"), wire_model: name,
      deployment_ref: name, source: "fixture", service_config: { engine: "fixture", engine_version: "1" } } };
  };
  const a = await binding("a"), b = await binding("b"), c = await binding("c");
  const request = await validateEvalRequest({ dataset, harness_ref: `training-tool@commit:${"a".repeat(40)}`, model: a.endpoint_ref, endpoint_binding: a, attempts: 1 });
  await atomicWriteJSON(path.join(directory, "request.json"), request);
  await atomicWriteJSON(path.join(directory, "plan.json"), { schema_version: "1", eval_id: evalId, dataset, benchmark_id: request.benchmark_id,
    benchmark_revision: request.benchmark_revision, attempts: 1, tasks: ["zero", "repair"], candidate: {}, prepared_artifact: {}, controller_runtime: {} });
  let progress = createEvalProgress({ evalId, benchmarkId: request.benchmark_id, benchmarkRevision: request.benchmark_revision, plannedTasks: 2, plannedTrials: 2, startedAt: new Date().toISOString() });
  progress = mergeEvalProgressTrial(progress, { task_id: "zero", attempt: 1, trial_id: "zero__initial", run_id: `run_${"a".repeat(32)}` as import("../src/domain/index.js").RunId, observation_status: "valid", reward: 0 });
  await writeEvalProgress(directory, progress);
  const attempt = (next: typeof b, parent = endpointEvaluationAttemptId(a)): EndpointEvaluationAttemptV1 => ({ schema_version: "1", id: endpointEvaluationAttemptId(next), parent_id: parent, endpoint_binding: next });
  return { root, directory, request, a, b, c, attempt };
}

test("new endpoint attempts serialize competing bindings and replay the admission/submission gap", async t => {
  const f = await attemptFixture(t), firstId = `rerun_${"b".repeat(32)}`, secondId = `rerun_${"c".repeat(32)}`;
  const results = await Promise.allSettled([
    admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.b), firstId),
    admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.c), secondId),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const index = results.findIndex(result => result.status === "fulfilled"), next = index === 0 ? f.b : f.c, rerunId = index === 0 ? firstId : secondId;
  const admitted = await admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(next), rerunId);
  assert.deepEqual(admitted.selected_trials, [{ task_id: "repair", attempt: 1 }]);
  assert.equal((await readEndpointEvaluationAttempts(f.directory, f.request)).length, 2);
  const other = index === 0 ? f.c : f.b;
  await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(other, admitted.id), index === 0 ? secondId : firstId), /has not confirmed task termination/);
  await atomicWriteJSON(path.join(f.directory, "reruns", rerunId, "cancellation.json"), { eval_id: path.basename(f.directory), rerun_id: rerunId });
  assert.equal((await admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(other, admitted.id), index === 0 ? secondId : firstId)).parent_id, admitted.id);
});

test("all later same-binding repairs must terminate before another incarnation is admitted", async t => {
  const f = await attemptFixture(t), firstId = `rerun_${"1".repeat(32)}`, laterId = `rerun_${"2".repeat(32)}`, nextId = `rerun_${"3".repeat(32)}`;
  await admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.b), firstId);
  await atomicWriteJSON(path.join(f.directory, "reruns", firstId, "state.json"), { status: "failed" });
  await atomicWriteJSON(path.join(f.directory, "reruns", firstId, "submission.json"), { rerun_id: firstId });
  await atomicWriteJSON(path.join(f.directory, "reruns", laterId, "submission.json"), { rerun_id: laterId });
  await atomicWriteJSON(path.join(f.directory, "reruns", laterId, "state.json"), { status: "running" });
  await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.c, endpointEvaluationAttemptId(f.b)), nextId), /another task repair has not confirmed termination/);
  await atomicWriteJSON(path.join(f.directory, "reruns", laterId, "state.json"), { status: "failed", error: { code: "execution_state_ambiguous" } });
  await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.c, endpointEvaluationAttemptId(f.b)), nextId), /another task repair has not confirmed termination/);
  await atomicWriteJSON(path.join(f.directory, "reruns", laterId, "state.json"), { status: "failed" });
  assert.equal((await admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(f.c, endpointEvaluationAttemptId(f.b)), nextId)).parent_id, endpointEvaluationAttemptId(f.b));
});

test("endpoint recovery rejects a changed model, public condition or training binding", async t => {
  const f = await attemptFixture(t);
  for (const binding of [{ ...f.b, generation: { max_output_tokens: 2048 } }, { ...f.b, deployment_receipt: { ...f.b.deployment_receipt, model_digest: sha256JSON("different model") } }]) {
    await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(binding), `rerun_${"4".repeat(32)}`), /incarnation only/);
  }
  await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, { ...f.request, training_binding: {} } as EvalRequest, f.attempt(f.b), `rerun_${"5".repeat(32)}`), /training or non-endpoint/);
});

test("changed endpoints cannot persist attempt lineage before rejecting an old selected resource approval", async t => {
  const f = await attemptFixture(t);
  const { buildEvalExecutionPlan, deriveTaskResourceRequirement, validateEvalId } = await import("../src/evals/index.js");
  const resources = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const execution = buildEvalExecutionPlan({ evalId: validateEvalId(path.basename(f.directory)), request: f.request,
    candidate: { revisionIdentity: sha256JSON("revision"), artifactId: sha256JSON("artifact") }, tasks: ["zero", "repair"],
    maxParallelism: 1, workItemMode: "task-slots", taskResources: ["repair", "zero"].map(taskId => deriveTaskResourceRequirement({
      taskId, defaultResources: resources, defaultSource: "operator-default", declaration: {
        schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
        provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] } })),
    resourceProfiling: { schema_version: "1", unknown_max_parallelism: 1, requested_parallelism: 4, scope: "process",
      approvals: [{ task_id: "repair", identity_digest: sha256JSON("identity"), approval_digest: sha256JSON("approval") }] } });
  await atomicWriteJSON(path.join(f.directory, "execution-plan.json"), execution);
  for (const [index, binding] of [f.b, f.c].entries()) {
    const rerunId = `rerun_${String(index + 4).repeat(32)}`;
    await assert.rejects(admitEndpointEvaluationAttempt(f.root, f.directory, f.request, f.attempt(binding), rerunId), { code: "eval_rerun_resource_approval_changed" });
    assert.equal(await readJSON(path.join(f.directory, "endpoint-attempts.json"), null), null);
    assert.equal(await readJSON(path.join(f.directory, "reruns", rerunId, "state.json"), null), null);
    assert.equal((await readEndpointEvaluationAttempts(f.directory, f.request)).length, 1);
  }
});


test("host credentials are immutable per revision, private, and usable after the importing environment disappears", async t => {
  const { connectEndpoint, resolveEndpoint, loadFrozenEndpoint, endpointCredential, persistEndpointCredential } = await import("../src/model-access/index.js");
  const { chmod, stat } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "hitch-endpoint-secret-")); t.after(() => forceRemove(root));
  const name = "TEST_LATER_INCARCATION_SECRET";
  await connectEndpoint(root, "later", { schema_version: "1", base_url: "http://127.0.0.1:1234/v1", wire_model: "later", api: "chat-completions", auth: { kind: "env", name },
    capabilities: { streaming: false, tool_calls: true, parallel_tool_calls: false, input_modalities: ["text"] } });
  const ready = await resolveEndpoint(root, "endpoint/later");
  await persistEndpointCredential(root, ready, { [name]: "host-only-secret" });
  const binding = publicEndpointBinding(ready), restored = await loadFrozenEndpoint(root, binding);
  assert.equal(endpointCredential(restored, {}), "host-only-secret");
  assert.equal(JSON.stringify(restored).includes("host-only-secret"), false);
  assert.equal(JSON.stringify(binding).includes("host-only-secret"), false);
  await assert.rejects(persistEndpointCredential(root, ready, { [name]: "different-secret" }), { code: "endpoint_credential_conflict" });
  const file = path.join(root, "private/model-endpoints/credentials", `${ready.endpoint_revision.slice(7)}.json`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644);
  await assert.rejects(loadFrozenEndpoint(root, binding), { code: "endpoint_credential_conflict" });
});


test("published schemas accept explicit endpoint attempts and preserve ordered pause fences", async t => {
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const f = await attemptFixture(t);
  const ajv = new Ajv2020({ strict: false, validateFormats: false, loadSchema: async uri => JSON.parse(await readFile(path.join("docs/schemas", path.basename(new URL(uri).pathname)), "utf8")) });
  const validate = await ajv.compileAsync(JSON.parse(await readFile("docs/schemas/ordered-eval-control.schema.json", "utf8")));
  const rerun = { eval_id: `eval_${"a".repeat(32)}`, input: { rerun_id: `rerun_${"b".repeat(32)}`, rerun_type: "candidate-restart", selector: { mode: "invalid" }, endpoint_attempt: f.attempt(f.b) } };
  const command = { schema_version: "2", key: "schema-attempt", subject_digest: sha256JSON("frozen subject"), sequence: 2, action: "start", rerun };
  assert.equal(validate(command), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...command, action: "pause" }), false);
  assert.equal(validate({ ...command, rerun: { ...rerun, input: { ...rerun.input, selector: { mode: "tasks", task_names: ["repair"] } } } }), false);
  assert.equal(validate({ ...command, rerun: { ...rerun, input: { ...rerun.input, rerun_type: "verifier-only" } } }), false);
});
