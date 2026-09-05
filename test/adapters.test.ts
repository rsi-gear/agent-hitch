import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "../src/adapters/index.js";
import type { AdapterRequest } from "../src/adapters/index.js";

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    cwd: "/workspace",
    model: "provider/model",
    prompt: "a long prompt",
    agent_args: ["--extra-flag"],
    workspace_mode: "shared",
    harness_ref: "pi@installed",
    timeout_ms: 0,
    ...overrides,
  };
}

test("Pi and OpenCode adapters use their native JSON modes with prompt stdin", () => {
  const base = request();

  assert.deepEqual(getAdapter("pi").process(base, "/bin/pi"), {
    executable: "/bin/pi",
    args: ["--mode", "json", "--no-session", "--model", "provider/model", "--extra-flag"],
    input: "a long prompt",
  });
  assert.deepEqual(getAdapter("opencode").process(base, "/bin/opencode"), {
    executable: "/bin/opencode",
    args: ["run", "--format", "json", "--dir", "/workspace", "--model", "provider/model", "--extra-flag"],
    input: "a long prompt",
  });
});

test("Codex adapter only uses --ephemeral when the installed version supports it", () => {
  const base = request({ model: "gpt-test", prompt: "hello", agent_args: [] });
  const adapter = getAdapter("codex");
  const oldVersion = adapter.process(base, "/bin/codex", { observed_version: "codex-cli 0.92.0" }) as { args: string[] };
  const newVersion = adapter.process(base, "/bin/codex", { observed_version: "codex-cli 0.99.0" }) as { args: string[] };
  assert.equal(oldVersion.args.includes("--ephemeral"), false);
  assert.equal(newVersion.args.includes("--ephemeral"), true);
  assert.equal(oldVersion.args.includes("--skip-git-repo-check"), true);
});

test("Claude adapter emits matched structured tool lifecycle events", () => {
  const adapter = getAdapter("claude");
  const started = adapter.translate?.({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file: "README.md" } }] },
  }) ?? [];
  const completed = adapter.translate?.({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "done" }] }] },
  }) ?? [];

  assert.deepEqual(started, [{ type: "tool.started", call_id: "tool_1", name: "Read", input: { file: "README.md" } }]);
  assert.deepEqual(completed, [{ type: "tool.completed", call_id: "tool_1", status: "succeeded", output: "done" }]);
});

test("Claude adapter preserves every text block in order", () => {
  const events = getAdapter("claude").translate?.({
    type: "assistant",
    message: { content: [{ type: "text", text: "first " }, { type: "text", text: "second" }] },
  }) ?? [];
  assert.deepEqual(events, [
    { type: "message.delta", text: "first " },
    { type: "message.delta", text: "second" },
  ]);
});

test("Claude result exposes the authoritative complete final reply", () => {
  const events = getAdapter("claude").translate?.({
    type: "result",
    result: "complete final answer",
    usage: { input_tokens: 10, output_tokens: 4 },
  }) ?? [];
  assert.deepEqual(events, [
    { type: "message.completed", text: "complete final answer" },
    { type: "usage.updated", usage: { input_tokens: 10, output_tokens: 4 } },
  ]);
});

test("Pi adapter preserves streaming text, final text, usage, and tool lifecycle", () => {
  const adapter = getAdapter("pi");
  assert.deepEqual(adapter.translate?.({ type: "session", id: "session_1" }) ?? [], [
    { type: "session.created", session_id: "session_1" },
  ]);
  assert.deepEqual(adapter.translate?.({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  }) ?? [], [{ type: "message.delta", text: "hello" }]);
  assert.deepEqual(adapter.translate?.({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }],
      usage: { input: 3, output: 2 },
      stopReason: "stop",
    },
  }) ?? [], [
    { type: "message.completed", text: "final" },
    { type: "usage.updated", usage: { input: 3, output: 2 } },
  ]);
  assert.deepEqual(adapter.translate?.({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "README.md" },
  }) ?? [], [{ type: "tool.started", call_id: "call_1", name: "read", input: { path: "README.md" } }]);
  assert.deepEqual(adapter.translate?.({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: "done" },
    isError: false,
  }) ?? [], [{
    type: "tool.completed",
    call_id: "call_1",
    name: "read",
    status: "succeeded",
    output: { content: "done" },
  }]);
});

test("OpenCode adapter normalizes its terminal tool events and emits one session per run", () => {
  const adapter = getAdapter("opencode");
  const state: Record<string, unknown> = {};
  const started = adapter.translate?.({
    type: "step_start",
    sessionID: "session_1",
    part: { type: "step-start", id: "part_1" },
  }, state) ?? [];
  const text = adapter.translate?.({
    type: "text",
    sessionID: "session_1",
    part: { type: "text", text: "hello" },
  }, state) ?? [];
  const tool = adapter.translate?.({
    type: "tool_use",
    sessionID: "session_1",
    part: {
      id: "part_2",
      callID: "call_1",
      tool: "bash",
      state: { status: "error", input: { command: "false" }, error: "exit 1" },
    },
  }, state) ?? [];
  const usage = adapter.translate?.({
    type: "step_finish",
    sessionID: "session_1",
    part: { tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 3, write: 0 } }, cost: 0.01 },
  }, state) ?? [];

  assert.deepEqual(started, [
    { type: "session.created", session_id: "session_1" },
    {
      type: "provider.event",
      provider_type: "step_start",
      native: { type: "step_start", sessionID: "session_1", part: { type: "step-start", id: "part_1" } },
    },
  ]);
  assert.deepEqual(text, [{ type: "message.delta", text: "hello" }]);
  assert.deepEqual(tool, [{
    type: "tool.completed",
    call_id: "call_1",
    name: "bash",
    status: "failed",
    input: { command: "false" },
    output: "exit 1",
    native: {
      id: "part_2",
      callID: "call_1",
      tool: "bash",
      state: { status: "error", input: { command: "false" }, error: "exit 1" },
    },
  }]);
  assert.deepEqual(usage, [{
    type: "usage.updated",
    usage: { input: 4, output: 2, reasoning: 1, cache: { read: 3, write: 0 }, cost: 0.01 },
  }]);
});

test("DeepSeek adapter runs the headless profile with an isolated home and model patch", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-adapter-"));
  const runtimeHome = path.join(runDirectory, "runtime-home");
  const specification = await getAdapter("deepseek").process({
    ...request({ model: "deepseek-official/deepseek-v4-pro", prompt: "fix the tests" }),
    agent_args: ["--patch", "/workspace/custom.yml"],
  }, "/bin/dsh", { run_directory: runDirectory, runtime_home: runtimeHome });

  assert.equal(specification.executable, "/bin/dsh");
  assert.equal(specification.input, "");
  assert.deepEqual(specification.env, { DSH_HOME: runtimeHome });
  assert.deepEqual(specification.args.slice(0, 4), ["--profile", "headless", "--patch", "/workspace/custom.yml"]);
  assert.deepEqual(specification.args.slice(-5, -3), ["--patch", path.join(runDirectory, "config", "deepseek-runtime.json")]);
  assert.deepEqual(specification.args.slice(-3, -1), ["--", "--"]);
  assert.equal(specification.args.at(-1), "fix the tests");
  assert.deepEqual(JSON.parse(await readFile(specification.args.at(-4) as string, "utf8")), [
    {
      id: "session-persistence-jsonl",
      config: {
        root: path.join(runtimeHome, "sessions"),
        compression: "none",
        packChunks: false,
      },
    },
    {
      id: "agent-default-model",
      config: { provider: "deepseek-official", model: "deepseek-v4-pro" },
    },
  ]);
});

test("DeepSeek adapter terminates both DSH option parsers before every prompt shape", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "hitch-deepseek-prompt-argv-"));
  const patchFile = path.join(runDirectory, "config", "deepseek-runtime.json");
  const prompts = [
    "normal task",
    "- starts with a dash",
    "--help",
    "--patch attacker-controlled-value",
    "multi-line\ntask",
    "",
  ];

  for (const prompt of prompts) {
    const specification = await getAdapter("deepseek").process({
      ...request({ model: "deepseek-official/deepseek-v4-pro", prompt }),
      agent_args: [],
    }, "/bin/dsh", { run_directory: runDirectory, runtime_home: path.join(runDirectory, "runtime-home") });
    assert.deepEqual(specification.args.slice(-5), ["--patch", patchFile, "--", "--", prompt]);
  }
});

test("DeepSeek adapter preserves multiline plain-text output including JSON-looking lines", () => {
  const adapter = getAdapter("deepseek");
  const state: Record<string, unknown> = {};
  const events = ["first", "", '{"answer":true}'].flatMap((line) => adapter.translateLine?.(line, state) ?? []);
  assert.deepEqual(events, [
    { type: "message.delta", text: "first" },
    { type: "message.delta", text: "\n" },
    { type: "message.delta", text: '\n{"answer":true}' },
  ]);
});


test("Codex keeps final text separate and records open command outcome as unknown", () => {
  const adapter = getAdapter("codex");
  const state = {};
  adapter.translate?.({ type: "item.started", item: { id: "server", type: "command_execution", command: "npm start", status: "in_progress" } }, state);
  const complete = adapter.translate?.({ type: "item.completed", item: { id: "msg", type: "agent_message", text: "Final answer" } }, state);
  assert.deepEqual(complete, [{ type: "message.completed", text: "Final answer" }]);
  const closed = adapter.translate?.({ type: "turn.completed", usage: { input_tokens: 4 } }, state) ?? [];
  assert.equal(closed[0]?.type, "tool.completed");
  assert.equal((closed[0] as {status: string}).status, "unknown");
  assert.equal((closed[0] as {call_id: string}).call_id, "server");
  assert.deepEqual(adapter.translate?.({type: "turn.completed"}, state), []);
});

test("Codex completed command preserves output and exit status", () => {
  const adapter = getAdapter("codex");
  const result = adapter.translate?.({type: "item.completed", item: {id:"cmd", type:"command_execution", status:"completed", exit_code:0, aggregated_output:"hello"}}) ?? [];
  assert.equal((result[0] as {status:string}).status, "succeeded");
  assert.equal((result[0] as {output:string}).output, "hello");
  const failed = adapter.translate?.({type: "item.completed", item: {id:"cmd", type:"command_execution", status:"completed", exit_code:1}}) ?? [];
  assert.equal((failed[0] as {status:string}).status, "failed");
});
