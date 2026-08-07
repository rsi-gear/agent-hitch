import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRun, newRunId } from "../src/engine.js";
import { readJSON } from "../src/fs.js";
import { writeFakeCodex } from "../test-support/helpers.js";

test("run engine records normalized events and a reproducible result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-engine-"));
  const executable = await writeFakeCodex(root);
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const runId = newRunId();
  const events = [];

  const result = await executeRun({
    runId,
    request: { agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] },
    runsRoot: path.join(root, "runs"),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:hello");
  assert.ok(events.some((event) => event.type === "session.created"));
  assert.ok(events.some((event) => event.type === "usage.updated"));
  const manifest = await readJSON(path.join(root, "runs", runId, "manifest.json"));
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.agent_version, "codex-cli 9.9.9");
});

test("run request validation returns typed invalid input for malformed cwd", async () => {
  await assert.rejects(
    executeRun({
      runId: newRunId(),
      request: { agent: "codex", cwd: {}, prompt: "hello" },
      runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }),
    (error) => error.code === "invalid_input" && error.exitCode === 2,
  );
  await assert.rejects(
    executeRun({
      runId: newRunId(),
      request: { agent: "codex", prompt: "hello", surprise: true },
      runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }),
    (error) => error.code === "invalid_input" && error.exitCode === 2,
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
    request: { agent: "codex", cwd: root, prompt: "slow", timeout_ms: 50, agent_args: [] },
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.exit_code, 8);
});

test("run engine preserves the complete ordered final reply", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-output-"));
  const executable = await writeFakeCodex(root, { splitReply: true });
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
  const result = await executeRun({
    runId: newRunId(),
    request: { agent: "codex", cwd: root, prompt: "complete", timeout_ms: 5_000, agent_args: [] },
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
    request: { agent: "codex", cwd: root, prompt: "observer", timeout_ms: 5_000, agent_args: [] },
    runsRoot,
    onEvent: () => { throw new Error("observer failed"); },
  });
  assert.equal(result.status, "succeeded");
  assert.equal((await readJSON(path.join(runsRoot, runId, "manifest.json"))).status, "succeeded");
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
    request: { agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] },
    runsRoot,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "launch_failed");
  assert.equal(result.exit_code, 6);
  const manifest = await readJSON(path.join(runsRoot, runId, "manifest.json"));
  assert.equal(manifest.status, "failed");
  assert.ok(await readJSON(path.join(runsRoot, runId, "result.json")));
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
