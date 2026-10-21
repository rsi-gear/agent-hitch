import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBenchmark } from "../src/benchmarks/index.js";
import { exportStandardBenchmarkDataset } from "../src/evals/index.js";

function python(args: string[], expected = 0): string {
  const result = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout;
}

async function grade(args: string[], env: NodeJS.ProcessEnv, expected = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", args, { env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: "1" } });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("error", reject);
    child.on("close", status => {
      try { assert.equal(status, expected, output); resolve(); } catch (error) { reject(error); }
    });
  });
}

type WireRequest = {
  model: string;
  input: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string; detail?: string }> }>;
  text: { format: { name: string; schema: { properties: Record<string, unknown> } } };
  stream: boolean; store: boolean; tools: unknown[]; tool_choice: string; reasoning?: { effort: string };
};

async function proxy(t: test.TestContext) {
  let mode = "ok";
  const requests: Array<{ body: WireRequest; authorization: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/responses");
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as WireRequest;
    requests.push({ body, authorization: request.headers.authorization });
    if (mode === "429") { response.writeHead(429); response.end(JSON.stringify({ error: request.headers.authorization })); return; }
    const prompt = body.input.flatMap(message => message.content.map(part => part.text ?? "")).join("\n");
    const reasoning = `fixture ${request.headers.authorization}`;
    let result: Record<string, unknown>;
    if (body.text.format.name === "hitch_proxy_smoke") {
      result = { ok: true };
    } else if (body.text.format.name === "jobbench_rubric") {
      const count = prompt.includes("first block") ? 2 : 1;
      const passed = mode !== "fail" && prompt.includes("first block");
      result = { criteria_results: Array.from({ length: count }, (_, index) => ({ index, passed, reasoning, evidence: "submitted work" })),
        rubric_passed: passed, overall_reasoning: reasoning };
    } else if (body.text.format.name === "lab_deliverable_match") {
      result = Object.fromEntries(Object.keys(body.text.format.schema.properties).map(key => [key,
        mode === "matcher-invalid" ? "outside-output.txt" : mode === "matcher-null" ? null : "unrelated.csv"]));
      if (mode === "matcher-keys") result = { unexpected: "unrelated.csv" };
    } else {
      result = { reasoning, verdict: mode === "fail" || prompt.includes("File not found:") || prompt.includes("No agent output found") ? "fail" : "pass" };
    }
    if (mode === "schema") result = { unexpected: true };
    const text = mode === "bad-json" ? "not JSON" : JSON.stringify(result);
    const message = { type: "message", role: "assistant", status: mode === "item-incomplete" ? "in_progress" : "completed",
      content: mode === "refusal" ? [{ type: "refusal", refusal: "refused" }] : [{ type: "output_text", text }] };
    const payload = JSON.stringify({ object: "response", status: mode === "incomplete" ? "incomplete" : "completed",
      output: [{ type: "reasoning", summary: [] }, message, ...(mode === "tool" ? [{ type: "function_call", name: "unexpected" }] : [])] });
    if (mode === "interrupted") {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) + 100 });
      response.end(payload.slice(0, -30)); return;
    }
    if (mode === "sse-interrupted") {
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end(`data: ${payload}\n\n`); return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(payload);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, setMode(value: string) { mode = value; } };
}

async function assertRedacted(directory: string) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, file.name);
    if (file.isDirectory()) await assertRedacted(target);
    else assert.doesNotMatch(await readFile(target, "utf8"), /synthetic-private-cliproxy-key/);
  }
}

test("CLIProxy profiles import, compile and grade through HTTP while preserving official prompts, attachments and LAB matching", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-cliproxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = JSON.parse(python(["test-support/benchmark_producers_fixture.py", path.join(root, "source")])) as Record<string, string>;
  const endpoint = await proxy(t);
  await grade(["benchmark-packages/cliproxy/smoke.py", "--base-url", endpoint.baseUrl, "--allow-http", "--model", "explicit-codex-model"],
    { HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY: "synthetic-private-cliproxy-key" });
  for (const kind of ["jobbench", "lab"]) {
    const output = path.join(root, kind), compiled = path.join(root, `${kind}-compiled`);
    const common = [`benchmark-packages/${kind}/import.py`, "--source", source[kind]!, ...(kind === "jobbench"
      ? ["--source-revision", source.jobbench_revision!, "--snapshot", source.snapshot!, "--dataset-revision", "a".repeat(40), "--task", "main--fixture-profession--task1"]
      : ["--revision", source.lab_revision!, "--task", "area/review/scenario-01"])];
    const model = kind === "jobbench" ? ["--judge-model", "explicit-codex-model"] : ["--judges", "explicit-codex-model"];
    const profile = ["--judge-profile", "cliproxy-codex"];
    if (kind === "lab") {
      python([...common, ...profile, "--judges", "first-model", "second-model", "--judge-base-url", endpoint.baseUrl, "--judge-allow-http", "--out", output], 1);
      python([...common, ...profile, ...model, "--judge-api", "openai-chat-completions", "--judge-base-url", endpoint.baseUrl, "--judge-allow-http", "--out", output], 1);
    }
    python([...common, ...profile, "--out", output], 1); // No implicit paid-model or endpoint fallback.
    python([...common, ...profile, ...model, "--out", output], 1);
    python([...common, ...profile, ...model, "--judge-base-url", endpoint.baseUrl, "--out", output], 1); // HTTP opt-in required.
    python([...common, ...profile, ...model, "--judge-base-url", endpoint.baseUrl, "--judge-allow-http", "--out", output]);
    const benchmark = await loadBenchmark(output), task = benchmark.tasks[0]!;
    await exportStandardBenchmarkDataset(output, compiled);
    const tests = path.join(compiled, task.id, "tests");
    const locked = JSON.parse(await readFile(path.join(tests, "judge.json"), "utf8"));
    assert.equal(locked.profile, "cliproxy-codex");
    assert.equal(locked[kind === "jobbench" ? "workers" : "parallel"], 1);
    assert.match(await readFile(path.join(compiled, task.id, "task.toml"), "utf8"), kind === "jobbench" ? /HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY/ : /HITCH_LAB_JUDGE_CLIPROXY_API_KEY/);
    assert.doesNotMatch(await readFile(path.join(output, "source-manifest.json"), "utf8"), /synthetic-private-cliproxy-key/);
    const evidence = path.join(root, `${kind}-evidence`), logs = path.join(root, `${kind}-logs`);
    await mkdir(evidence); await writeFile(path.join(evidence, "answer.txt"), "submitted legal work");
    const env = { PYTHONPATH: source.stubs, JUDGE_API_KEY: "synthetic-private-cliproxy-key", CLIPROXY_API_KEY: "synthetic-private-cliproxy-key" };
    const run = (expected = 0, extra: NodeJS.ProcessEnv = {}) => grade([path.join(tests, "hitch_grade.py"), "--tests", tests, "--output", evidence, "--logs", logs], { ...env, ...extra }, expected);
    endpoint.setMode("ok"); const first = endpoint.requests.length;
    await run();
    const reward = JSON.parse(await readFile(path.join(logs, "reward.json"), "utf8"));
    assert.equal(reward[kind === "jobbench" ? "reward" : "lab_all_pass"], kind === "jobbench" ? 0.3333 : 1);
    const requests = endpoint.requests.slice(first);
    for (const { body, authorization } of requests) {
      assert.equal(authorization, "Bearer synthetic-private-cliproxy-key"); assert.equal(body.model, "explicit-codex-model");
      assert.equal(body.stream, false); assert.equal(body.store, false); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none");
      assert.equal("temperature" in body, false); assert.equal("max_tokens" in body, false); assert.equal("max_completion_tokens" in body, false);
    }
    const body = requests[0]!.body;
    if (kind === "jobbench") {
      assert.deepEqual(body.input.map(message => message.role), ["system", "developer", "user"]);
      assert.deepEqual(body.input[2]!.content.map(part => part.type), ["input_text", "input_image", "input_text", "input_image"]);
      assert.equal(body.input[2]!.content[1]!.image_url, "data:image/png;base64,iVBORw0KGgo=");
      assert.equal(body.input[2]!.content[1]!.detail, "high");
      assert.equal(body.input[2]!.content[3]!.image_url, "https://example.invalid/fixture.png");
    } else {
      assert.deepEqual(Object.keys(body.text.format.schema.properties), ["reasoning", "verdict"]);
      assert.ok(requests.some(request => JSON.stringify(request.body).includes("first passes")));
      assert.ok(requests.some(request => JSON.stringify(request.body).includes("second passes")));
      await rename(path.join(evidence, "answer.txt"), path.join(evidence, "unrelated.csv"));
      const beforeMatch = endpoint.requests.length;
      await run();
      assert.equal(JSON.parse(await readFile(path.join(logs, "reward.json"), "utf8")).lab_all_pass, 1);
      const matcher = endpoint.requests.slice(beforeMatch).find(request => request.body.text.format.name === "lab_deliverable_match");
      assert.ok(matcher); assert.match(JSON.stringify(matcher.body.input), /Match each unresolved deliverable/);
      assert.match(JSON.stringify(matcher.body.input), /Preview: submitted legal work/);
      for (const mode of ["matcher-invalid", "matcher-keys"]) {
        endpoint.setMode(mode); await run(1); await assert.rejects(readFile(path.join(logs, "reward.json")));
      }
      endpoint.setMode("matcher-null"); await run();
      assert.equal(JSON.parse(await readFile(path.join(logs, "reward.json"), "utf8")).lab_all_pass, 0, "valid null retains official missing-deliverable behavior");
      await rename(path.join(evidence, "unrelated.csv"), path.join(evidence, "answer.txt"));
    }
    endpoint.setMode("fail"); await run();
    assert.equal(JSON.parse(await readFile(path.join(logs, "reward.json"), "utf8"))[kind === "jobbench" ? "reward" : "lab_all_pass"], 0);
    for (const mode of ["429", "incomplete", "item-incomplete", "refusal", "tool", "bad-json", "schema", "interrupted", "sse-interrupted"]) {
      endpoint.setMode(mode); await run(1); await assert.rejects(readFile(path.join(logs, "reward.json")), mode);
      await assertRedacted(logs);
    }
    endpoint.setMode("ok"); await run(); // Artifact-only regrade recovers after failure and removes stale scores.
    await assertRedacted(logs);
    const provenance = JSON.parse(await readFile(path.join(logs, "judge-provenance.json"), "utf8"));
    assert.equal(provenance.transport.api, "openai-responses"); assert.equal(provenance.transport.base_url, endpoint.baseUrl);
    if (kind === "lab") assert.equal(provenance.matching_transport.model, "explicit-codex-model");
    await rm(path.join(evidence, "answer.txt"));
    const beforeEmpty = endpoint.requests.length;
    await run();
    assert.equal(JSON.parse(await readFile(path.join(logs, "reward.json"), "utf8"))[kind === "jobbench" ? "reward" : "lab_all_pass"], 0);
    if (kind === "jobbench") assert.equal(endpoint.requests.length, beforeEmpty, "empty JobBench output makes no model call");
    await run(1, { JUDGE_API_KEY: "", CLIPROXY_API_KEY: "", OPENAI_API_KEY: "candidate-key-must-not-fallback" });
    await assert.rejects(readFile(path.join(logs, "reward.json")));
  }
});
