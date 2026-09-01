import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRun, newRunId } from "../src/runs/index.js";
import type { RunRequestInput } from "../src/runs/index.js";
import { readJSON, sha256JSON } from "../src/foundation/index.js";
import { writeFakeCodex, writeFakeDeepseek, writeFakeOpenCode, writeFakePi } from "../test-support/helpers.js";
import { loadTrajectoryRef, readTrajectory } from "../src/trajectories/store.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readJSONLines(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function request(overrides: Partial<RunRequestInput> = {}): RunRequestInput {
  return {
    agent: "codex",
    model: "",
    cwd: process.cwd(),
    prompt: "hello",
    timeout_ms: 5_000,
    agent_args: [],
    ...overrides,
  };
}

test("run engine records normalized events and a reproducible result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-engine-"));
  const executable = await writeFakeCodex(root);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();
  const events: Record<string, unknown>[] = [];

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:hello");
  assert.ok(events.some((event) => event.type === "session.created"));
  assert.ok(events.some((event) => event.type === "usage.updated"));
  const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", runId, "manifest.json"));
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.agent_version, "codex-cli 9.9.9");
});

test("run engine redacts declared credential values from every persisted evidence file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-engine-credential-redaction-"));
  const executable = path.join(root, "credential-codex");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_secret"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"answer:" + process.env.EVAL_SECRET}}) + "\\n");
  process.stderr.write("debug=" + process.env.EVAL_SECRET + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}) + "\\n");
});
`, { mode: 0o755 });
  await chmod(executable, 0o755);
  const previousExecutable = process.env.HITCH_CODEX_PATH;
  const previousSecret = process.env.EVAL_SECRET;
  const secret = "custom-secret-value-without-provider-prefix";
  process.env.HITCH_CODEX_PATH = executable;
  process.env.EVAL_SECRET = secret;
  t.after(() => {
    restoreEnv("HITCH_CODEX_PATH", previousExecutable);
    restoreEnv("EVAL_SECRET", previousSecret);
  });
  const runId = newRunId();
  const events: Record<string, unknown>[] = [];
  const result = await executeRun({
    runId,
    request: request({
      agent: "codex",
      cwd: root,
      prompt: "do work",
      agent_args: ["--label", secret],
      credential_names: ["EVAL_SECRET"],
    }),
    runsRoot: path.join(root, "runs"),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "answer:[REDACTED]");
  assert.equal(JSON.stringify(events).includes(secret), false);
  const runDirectory = path.join(root, "runs", runId);
  for (const file of await regularFiles(runDirectory)) {
    assert.equal((await readFile(file)).includes(Buffer.from(secret)), false, `credential leaked into ${path.relative(runDirectory, file)}`);
  }
  const manifest = await readJSON<{ agent_args_sha256: string }>(path.join(runDirectory, "manifest.json"));
  assert.equal(manifest.agent_args_sha256, sha256JSON(["--label", "[REDACTED]"]));
  const trajectory = await readJSON<{ redactions: Array<{ rule_id: string; count: number }> }>(path.join(runDirectory, "trajectory.ref.json"));
  assert.ok(trajectory.redactions.some((entry) => entry.rule_id === "known-credential-value-v1" && entry.count >= 1));
});

test("run engine records a canonical trajectory with a trajectory ref", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-trajectory-"));
  const executable = await writeFakeCodex(root);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "succeeded");
  const runDirectory = path.join(root, "runs", runId);
  const ref = await loadTrajectoryRef(runDirectory);
  assert.ok(ref, "trajectory.ref.json must exist");
  assert.equal(ref.run_id, runId);
  assert.equal(ref.fidelity, "provider_native");
  assert.equal(ref.schema_version, "2");
  if (ref.schema_version === "2") {
    assert.ok(ref.files.some((file) => file.role === "provider_events"));
    assert.ok(ref.files.every((file) => !path.isAbsolute(file.path)));
  }
  assert.ok(ref.sha256?.startsWith("sha256:"));
  const { events, header } = await readTrajectory(ref.path);
  assert.equal(events.length > 0, true);
  // seq must be contiguous from zero
  events.forEach((event, index) => assert.equal(event.seq, index));
  assert.equal(header.id, ref.session_id);
  // Turn/step brackets closed
  const types = events.map((event) => event.type);
  assert.ok(types.includes("turn/start"));
  assert.ok(types.includes("turn/end"));
  assert.ok(types.includes("step/start"));
  assert.ok(types.includes("step/end"));
  const lastType = types.at(-1);
  assert.equal(lastType, "turn/end");
});

for (const agent of [
  { id: "pi", env: "HITCH_PI_PATH", version: "pi 0.82.1", write: writeFakePi },
  { id: "opencode", env: "HITCH_OPENCODE_PATH", version: "opencode 1.18.15", write: writeFakeOpenCode },
]) {
  test(`${agent.id} runs through native JSON mode`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), `hitch-${agent.id}-`));
    const executable = await agent.write(root);
    const previous = process.env[agent.env];
    process.env[agent.env] = executable;
    t.after(() => restoreEnv(agent.env, previous));
    const runId = newRunId();
    const events: Record<string, unknown>[] = [];

    const result = await executeRun({
      runId,
      request: request({ agent: agent.id, cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
      runsRoot: path.join(root, "runs"),
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "reply:hello");
    assert.equal(events.filter((event) => event.type === "session.created").length, 1);
    assert.ok(events.some((event) => event.type === "usage.updated"));
    const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", runId, "manifest.json"));
    assert.equal(manifest.agent_version, agent.version);
  });
}

test("DeepSeek runs through its headless plain-text mode", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-"));
  const executable = await writeFakeDeepseek(root, { output: 'first\n\n{"answer":true}' });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();
  const events: Record<string, unknown>[] = [];

  const result = await executeRun({
    runId,
    request: request({ agent: "deepseek", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, 'first\n\n{"answer":true}');
  assert.ok(events.some((event) => event.type === "message.delta"));
  assert.equal(events.some((event) => event.type === "provider.event"), false);
  const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", runId, "manifest.json"));
  assert.equal(manifest.agent_version, "0.1.0-rc.6");
});

test("DeepSeek process uses two terminators and records the exact dash-prefixed user message", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-option-prompt-"));
  const argvLog = path.join(root, "dsh-argv.json");
  const executable = await writeFakeDeepseek(root, { argvLog, nativeSession: true });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();
  const prompt = "- starts with a dash";

  const result = await executeRun({
    runId,
    request: request({ agent: "deepseek", cwd: root, prompt, timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "succeeded");
  const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
  assert.deepEqual(argv.slice(-3), ["--", "--", prompt]);
  const providerRows = await readJSONLines(path.join(
    root,
    "runs",
    runId,
    "trajectory",
    "provider",
    "deepseek-session.jsonl",
  ));
  const userMessage = providerRows.find((row) => row.type === "user/message");
  const content = (userMessage?.data as { content?: Array<{ text?: string }> } | undefined)?.content;
  assert.equal(content?.[0]?.text, prompt, "the parser escape must not reach DSH's first user message");
});

test("DeepSeek plain-text trajectory records minimal fidelity with preserved output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-trajectory-"));
  const executable = await writeFakeDeepseek(root, { output: "reply:hello" });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();

  const result = await executeRun({
    runId,
    request: request({ agent: "deepseek", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:hello");
  const ref = await loadTrajectoryRef(path.join(root, "runs", runId));
  assert.ok(ref);
  assert.equal(ref.fidelity, "minimal");
  const { events } = await readTrajectory(ref.path);
  const assistant = events.find((event) => event.type === "assistant/message");
  assert.ok(assistant);
  const data = assistant.data as { message: { content: Array<{ text?: string }> } };
  assert.equal(data.message.content.map((block) => block.text ?? "").join(""), "reply:hello");
  assert.equal((assistant.data as Record<string, unknown>).interrupted, undefined);
});

test("DeepSeek imports its native session with tool events, usage, and original timing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-native-"));
  const executable = await writeFakeDeepseek(root, {
    output: "stdout fallback",
    nativeSession: true,
    nativeChildSession: true,
  });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();
  const runDirectory = path.join(root, "runs", runId);

  const result = await executeRun({
    runId,
    request: request({
      agent: "deepseek",
      model: "deepseek/deepseek-v4-flash",
      cwd: root,
      prompt: "hello",
      timeout_ms: 5_000,
      agent_args: [],
    }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "native final");
  assert.equal(result.effective_model, "deepseek-v4-flash");
  const ref = await loadTrajectoryRef(runDirectory);
  assert.ok(ref);
  assert.equal(ref.fidelity, "provider_native");
  assert.equal(ref.provider_session_id, "session-native");
  const rawRef = await readJSON<{ files: Array<{ role: string; path: string }> }>(path.join(runDirectory, "trajectory.ref.json"));
  assert.ok(rawRef.files.some((file) => file.role === "provider_events" && file.path === "trajectory/provider/deepseek-session.jsonl"));
  assert.ok(rawRef.files.some((file) => file.role === "provider_events" && file.path === "trajectory/provider/deepseek-child-session-1.jsonl"));
  assert.ok(rawRef.files.some((file) => file.role === "provider_transcript"));

  const { header, events } = await readTrajectory(ref.path);
  assert.equal(header.id, runId);
  assert.equal(events.length, 14);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 14 }, (_, index) => index));
  assert.ok((events.at(-1)?.time ?? 0) - (events[0]?.time ?? 0) > 800);
  assert.equal(events[0]?.type, "permission/preset");
  assert.equal(events[0]?.ignorable, true);
  assert.ok(events.some((event) => event.type === "tool/call"));
  assert.ok(events.some((event) => event.type === "tool/result"));
  const assistant = events.findLast((event) => event.type === "assistant/message");
  assert.ok(assistant);
  const assistantData = assistant.data as Record<string, unknown>;
  assert.equal(assistantData.interrupted, undefined);
  assert.deepEqual(assistantData.usage, {
    inputTokens: 21,
    outputTokens: 5,
    cacheReadTokens: 4,
    reasoningTokens: 2,
  });

  const providerRows = await readJSONLines(path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"));
  assert.equal(providerRows[1]?.type, "permission/preset");
  assert.equal(providerRows[1]?.ignorable, undefined);
  const manifest = await readJSON<{ model: { effective_id: string } }>(path.join(runDirectory, "manifest.json"));
  assert.equal(manifest.model.effective_id, "deepseek-v4-flash");
});

test("DeepSeek timeout seals an open native turn without masking timed_out", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-timeout-native-"));
  const executable = await writeFakeDeepseek(root, {
    nativeSession: true,
    nativeSessionState: "open",
    delayMs: 2_000,
  });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();
  const runDirectory = path.join(root, "runs", runId);

  const result = await executeRun({
    runId,
    request: request({ agent: "deepseek", cwd: root, prompt: "slow", timeout_ms: 100, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "timed_out");
  assert.equal((result.error as { code: string }).code, "timed_out");
  assert.equal(result.trajectory_warning, undefined);
  const ref = await loadTrajectoryRef(runDirectory);
  assert.ok(ref, "the interrupted native session must still produce a canonical trajectory");
  assert.equal(ref.fidelity, "provider_native");
  const { events } = await readTrajectory(ref.path);
  assert.equal(events.at(-2)?.type, "step/end");
  assert.equal(events.at(-1)?.type, "turn/end");
  const terminal = events.at(-1)?.data as { reason?: { kind?: string; reason?: { reason?: string } } };
  assert.equal(terminal.reason?.kind, "aborted");
  assert.equal(terminal.reason?.reason?.reason, "timeout");

  // Provider evidence remains the original open log; only the canonical copy
  // receives Hitch's synthetic recovery boundary.
  const providerRows = await readJSONLines(path.join(runDirectory, "trajectory/provider/deepseek-session.jsonl"));
  assert.equal(providerRows.at(-1)?.type, "assistant/chunk");
});

test("trajectory recording failure remains secondary to an established timeout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-timeout-trajectory-failure-"));
  const executable = await writeFakeDeepseek(root, {
    nativeSession: true,
    nativeSessionState: "invalid",
    delayMs: 2_000,
  });
  const previous = process.env.HITCH_DEEPSEEK_PATH;
  process.env.HITCH_DEEPSEEK_PATH = executable;
  t.after(() => restoreEnv("HITCH_DEEPSEEK_PATH", previous));
  const runId = newRunId();
  const runDirectory = path.join(root, "runs", runId);

  const result = await executeRun({
    runId,
    request: request({ agent: "deepseek", cwd: root, prompt: "slow", timeout_ms: 100, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.exit_code, 8);
  assert.equal((result.error as { code: string }).code, "timed_out");
  const warning = result.trajectory_warning as { code: string; message: string };
  assert.equal(warning.code, "trajectory_recording_failed");
  assert.match(warning.message, /nested turn\/start/);
  const saved = await readJSON<Record<string, unknown>>(path.join(runDirectory, "result.json"));
  assert.equal(saved.status, "timed_out");
  assert.equal((saved.error as { code: string }).code, "timed_out");
  const manifest = await readJSON<Record<string, unknown>>(path.join(runDirectory, "manifest.json"));
  assert.equal(manifest.status, "timed_out");
  assert.equal((manifest.trajectory_warning as { code: string }).code, "trajectory_recording_failed");
  const controlEvents = await readJSONLines(path.join(runDirectory, "events.jsonl"));
  assert.ok(controlEvents.some((event) => event.type === "run.failed" && event.status === "timed_out"));
  assert.ok(controlEvents.some((event) => event.type === "trajectory.recording_failed"));
});

test("run request validation returns typed invalid input for malformed cwd", async () => {
  await assert.rejects(
    executeRun({
      runId: newRunId(),
      request: { agent: "codex", cwd: {} as string, prompt: "hello" },
      runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_input" && (error as { exitCode?: number }).exitCode === 2,
  );
  await assert.rejects(
    executeRun({
      runId: newRunId(),
      request: { agent: "codex", prompt: "hello", surprise: true } as RunRequestInput,
      runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_input" && (error as { exitCode?: number }).exitCode === 2,
  );
});

test("run engine terminates the process tree on timeout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-timeout-"));
  const executable = await writeFakeCodex(root, { delayMs: 2_000 });
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));

  const result = await executeRun({
    runId: newRunId(),
    request: request({ agent: "codex", cwd: root, prompt: "slow", timeout_ms: 50, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.exit_code, 8);
});

test("timed-out runs preserve a valid trajectory with a terminal boundary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-timeout-trajectory-"));
  const executable = await writeFakeCodex(root, { delayMs: 2_000 });
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "slow", timeout_ms: 50, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "timed_out");
  const ref = await loadTrajectoryRef(path.join(root, "runs", runId));
  assert.ok(ref, "timed-out runs must still record a trajectory ref");
  const { events } = await readTrajectory(ref.path);
  const last = events.at(-1);
  assert.equal(last?.type, "turn/end");
  const turnEnd = last?.data as { reason?: { kind?: string } };
  assert.equal(turnEnd.reason?.kind, "aborted");
});

test("an interrupted run with an open tool call records a readable trajectory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-open-tool-"));
  // Fake codex emits a tool start (command_execution) and then stalls; the
  // engine timeout must interrupt it with an open tool call in the step.
  const executable = path.join(root, "open-tool-codex");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_fake"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.started",item:{id:"call_1",type:"command_execution"}}) + "\\n");
  setTimeout(() => {}, 60_000);
});
`, { mode: 0o755 });
  await chmod(executable, 0o755);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "open tool", timeout_ms: 100, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });
  assert.equal(result.status, "timed_out");

  // The trajectory must be structurally valid (open tool call paired with an
  // unknown-outcome result before step/end) and readable by consumers.
  const ref = await loadTrajectoryRef(path.join(root, "runs", runId));
  assert.ok(ref);
  const { events } = await readTrajectory(ref.path);
  const results = events.filter((event) => event.type === "tool/result");
  assert.equal(results.length, 1);
  const resultData = results[0]?.data as { error?: { code: string }; message: { source: { callId: string } } };
  assert.equal(resultData.message.source.callId, "call_1");
  assert.equal(resultData.error?.code, "TOOL_OUTCOME_UNKNOWN");
});

test("a successful process exit with an open tool call cannot yield a succeeded run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-open-tool-success-"));
  // Fake codex emits a tool start and then exits 0 without a tool result.
  // The harness claimed success with an open tool call: trajectory
  // finalization must fail, and the run must not be reported succeeded
  // (spec §5.4: a completed run has no open call).
  const executable = path.join(root, "open-tool-success-codex");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_fake"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.started",item:{id:"call_1",type:"command_execution"}}) + "\\n");
  process.exit(0);
});
`, { mode: 0o755 });
  await chmod(executable, 0o755);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "open tool success", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });
  assert.notEqual(result.status, "succeeded");
  assert.equal((result.error as { code: string }).code, "trajectory_recording_failed");
  assert.equal(result.exit_code, 12);
  // No succeeded result.json is persisted.
  const saved = await readJSON<{ status: string }>(path.join(root, "runs", runId, "result.json"));
  assert.notEqual(saved.status, "succeeded");
});

test("run engine preserves the complete ordered final reply", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-output-"));
  const executable = await writeFakeCodex(root, { splitReply: true });
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const result = await executeRun({
    runId: newRunId(),
    request: request({ agent: "codex", cwd: root, prompt: "complete", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
  });
  assert.equal(result.output, "reply:complete");
});

test("event observers cannot strand an otherwise successful run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-observer-"));
  const executable = await writeFakeCodex(root);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();
  const runsRoot = path.join(root, "runs");
  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "observer", timeout_ms: 5_000, agent_args: [] }),
    runsRoot,
    onEvent: () => { throw new Error("observer failed"); },
  });
  assert.equal(result.status, "succeeded");
  assert.equal((await readJSON<Record<string, unknown>>(path.join(runsRoot, runId, "manifest.json"))).status, "succeeded");
});

test("spawn failure still finalizes the run record", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-spawn-failure-"));
  const executable = path.join(root, "broken-codex");
  await writeFile(executable, "#!/definitely/missing/interpreter\n", { mode: 0o755 });
  await chmod(executable, 0o755);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();
  const runsRoot = path.join(root, "runs");

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot,
  });

  assert.equal(result.status, "failed");
  assert.equal((result.error as { code: string }).code, "launch_failed");
  assert.equal(result.exit_code, 6);
  const manifest = await readJSON<Record<string, unknown>>(path.join(runsRoot, runId, "manifest.json"));
  assert.equal(manifest.status, "failed");
  assert.ok(await readJSON<unknown>(path.join(runsRoot, runId, "result.json")));
});

test("preparation failures still emit a terminal JSONL event", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-preparation-failure-"));
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = path.join(root, "missing-codex");
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();
  const events: Record<string, unknown>[] = [];

  const result = await executeRun({
    runId,
    request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "failed");
  assert.equal((result.error as { code: string }).code, "revision_not_found");
  assert.ok(events.some((event) => event.type === "run.failed" && (event.error as { code: string }).code === "revision_not_found"));
  const persisted = await readJSONLines(path.join(root, "runs", runId, "events.jsonl"));
  assert.ok(persisted.some((event) => event.type === "run.failed"));
});

test("run engine launches the harness in the isolated execution workspace", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-isolated-workspace-"));
  const executable = await writeFakeCodex(root);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const result = await executeRun({
    runId: newRunId(),
    request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
    runsRoot: path.join(root, "runs"),
    root,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:hello");
});

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files.sort();
}
