import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostModelProxy } from "../src/model-access/index.js";
import { parseTrainingBinding, registerTrainingEndpoint, resolveTrainingEndpoint } from "../src/model-access/training.js";
import { validateEvalRequest } from "../src/evals/request.js";

const hash = `sha256:${"a".repeat(64)}`;
const binding = () => parseTrainingBinding({ kind: "training-external", bindingId: "binding_test", trainingRunId: "train_test",
  policyLeaseRef: { uri: `cas:${hash}`, digest: hash, mediaType: "application/json" }, expectedPolicyVersion: "runtime-1/update-0",
  fencingToken: "test-fence", expiresAt: new Date(Date.now() + 60_000).toISOString(), endpointRef: "hitch-training:binding_test",
  credentialRef: "hitch-training:binding_test", generationContractDigest: hash, requiredCapture: "exact-policy-tokens-v1",
  api: "chat-completions", maxOutputTokens: 16, maxEpisodeSteps: 4 });

test("training registration is immutable, private, and checks live policy fencing", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-training-")); t.after(() => rm(root, { recursive: true, force: true }));
  const b = binding(); let policy = b.expectedPolicyVersion;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"s".repeat(48)}`);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ schemaVersion: 1, trainingRunId: b.trainingRunId,
      policyVersion: policy, fencingToken: b.fencingToken, state: "serving", generationContractDigest: hash, capture: b.requiredCapture }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const registration = { schema_version: "1", binding: b, base_url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`, credential: "s".repeat(48) };
  await registerTrainingEndpoint(root, registration); await registerTrainingEndpoint(root, registration);
  assert.equal((await stat(path.join(root, "training/bindings/binding_test.json"))).mode & 0o777, 0o600);
  assert.equal((await resolveTrainingEndpoint(root, b)).credential, registration.credential);
  await assert.rejects(registerTrainingEndpoint(root, { ...registration, credential: "q".repeat(48) }), /immutable/);
  policy = "another-policy"; await assert.rejects(resolveTrainingEndpoint(root, b), /frozen policy/);
  assert.throws(() => parseTrainingBinding({ ...b, endpointRef: "http://uncontrolled/v1" }), /controlled Hitch registry/);
});

test("training proxy admits one run and only forwards generation using the private policy credential", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-training-proxy-"));
  let proxy: HostModelProxy | undefined;
  const b = binding(); const calls: string[] = []; let forwarded: Record<string, unknown> = {};
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push(req.url!); res.setHeader("content-type", "application/json");
    if (req.url === "/v1/hitch/run") res.end(JSON.stringify({ runId: body.runId, policyVersion: b.expectedPolicyVersion }));
    else { forwarded = body; assert.equal(req.headers.authorization, `Bearer ${"s".repeat(48)}`); res.end(JSON.stringify({ choices: [], model: b.expectedPolicyVersion })); }
  });
  t.after(async () => {
    try { await proxy?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
  proxy = await HostModelProxy.start({ captureRoot: path.join(root, 'capture'), evalId: `eval_${"b".repeat(32)}`, mode: 'proxy', required: true,
    trainingEndpoint: { schema_version: '1', binding: b, base_url: base, credential: 's'.repeat(48) }, upstreams: { openai: base },
    upstreamAuthorizations: { openai: `Bearer ${'s'.repeat(48)}` }, upstreamWireModels: { openai: b.expectedPolicyVersion },
    credentialValues: ['s'.repeat(48)], bindHost: '127.0.0.1', advertisedHost: '127.0.0.1' });
  const run = `run_${"c".repeat(32)}`;
  assert.equal((await fetch(`${proxy.localBaseUrl}/${run}/openai/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'training/binding_test', messages: [] }) })).status, 200);
  assert.equal(forwarded.model, b.expectedPolicyVersion);
  for (const endpoint of ['generate', 'update_weights_from_tensor', 'hitch/run', 'responses']) assert.equal((await fetch(`${proxy.localBaseUrl}/${run}/openai/${endpoint}`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${proxy.localBaseUrl}/run_${"d".repeat(32)}/health`)).status, 409);
  assert.equal(calls.filter(p => p === '/v1/chat/completions').length, 1);
  assert.equal(JSON.stringify(proxy.route).includes('s'.repeat(48)), false);
});

test("training requests reject hidden retries and unbound training aliases", async t => {
  const dataset = await mkdtemp(path.join(tmpdir(), 'hitch-training-request-')); t.after(() => rm(dataset, { recursive: true, force: true }));
  const base = { dataset, harness_ref: `training-tool@commit:${'a'.repeat(40)}`, model: 'training/binding_test', training_binding: binding(), infrastructure_retries: 0 };
  assert.deepEqual((await validateEvalRequest(base)).training_binding, base.training_binding);
  await assert.rejects(validateEvalRequest({ ...base, attempts: 2 }), /one logical attempt/);
  await assert.rejects(validateEvalRequest({ ...base, infrastructure_retries: 1 }), /zero automatic retries/);
  await assert.rejects(validateEvalRequest({ ...base, training_binding: undefined }), /explicit training binding/);
});

test("fixed training harness appends tool observations and emits a single terminal marker", async t => {
  const run = `run_${'e'.repeat(32)}`; let requests = 0;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); requests++;
    assert.equal(req.headers['idempotency-key'], `${run}-${requests - 1}`);
    if (requests === 2) { assert.equal(body.messages.length, 3); assert.match(body.messages[2].content, /gear-tool-test/); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: requests === 1 ? 'tool_calls' : 'stop', message: requests === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf gear-tool-test' }) } }] }
      : { role: 'assistant', content: 'done' } }], usage: {} }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const child = spawn(process.execPath, ['integrations/training-tool/cli.js', '--model', 'training/binding_test'], { env: { ...process.env,
    HITCH_HARBOR_INTERNAL: '1', HITCH_TRAINING_EXTERNAL: '1', HITCH_TRAINING_RUN_ID: run,
    HITCH_TRAINING_BINDING: JSON.stringify({ binding_id: 'binding_test', max_output_tokens: 16, max_episode_steps: 4 }), OPENAI_API_KEY: 'hitch-training-external',
    OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/${'f'.repeat(48)}/${run}/openai` }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => errors += c); child.stdin.end('use the tool');
  const [code] = await once(child, 'close'); assert.equal(code, 0, errors); assert.equal(requests, 2);
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.type === 'training.terminated'), [{ type: 'training.terminated', termination: 'terminated' }]);
});
