import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "../src/adapters.js";
import type { AdapterRequest } from "../src/adapters.js";

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
  assert.deepEqual(specification.args.slice(-3, -1), ["--patch", path.join(runDirectory, "config", "deepseek-model.json")]);
  assert.equal(specification.args.at(-1), "fix the tests");
  assert.deepEqual(JSON.parse(await readFile(specification.args.at(-2) as string, "utf8")), [{
    id: "agent-default-model",
    config: { provider: "deepseek-official", model: "deepseek-v4-pro" },
  }]);
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
