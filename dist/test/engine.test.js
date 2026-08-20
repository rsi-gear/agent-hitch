import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRun, newRunId } from "../src/engine.js";
import { readJSON } from "../src/fs.js";
import { writeFakeCodex, writeFakeDeepseek, writeFakeOpenCode, writeFakePi } from "../test-support/helpers.js";
import { loadTrajectoryRef, readTrajectory } from "../src/trajectories/store.js";
function restoreEnv(name, value) {
    if (value === undefined)
        delete process.env[name];
    else
        process.env[name] = value;
}
async function readJSONLines(file) {
    return (await readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function request(overrides = {}) {
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
    const events = [];
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
    const manifest = await readJSON(path.join(root, "runs", runId, "manifest.json"));
    assert.equal(manifest.status, "succeeded");
    assert.equal(manifest.agent_version, "codex-cli 9.9.9");
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
    assert.equal(ref.fidelity, "normalized");
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
        const events = [];
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
        const manifest = await readJSON(path.join(root, "runs", runId, "manifest.json"));
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
    const events = [];
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
    const manifest = await readJSON(path.join(root, "runs", runId, "manifest.json"));
    assert.equal(manifest.agent_version, "0.1.0-rc.6");
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
    const data = assistant.data;
    assert.equal(data.message.content.map((block) => block.text ?? "").join(""), "reply:hello");
});
test("run request validation returns typed invalid input for malformed cwd", async () => {
    await assert.rejects(executeRun({
        runId: newRunId(),
        request: { agent: "codex", cwd: {}, prompt: "hello" },
        runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }), (error) => error.code === "invalid_input" && error.exitCode === 2);
    await assert.rejects(executeRun({
        runId: newRunId(),
        request: { agent: "codex", prompt: "hello", surprise: true },
        runsRoot: path.join(tmpdir(), "unused-hitch-runs"),
    }), (error) => error.code === "invalid_input" && error.exitCode === 2);
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
    const turnEnd = last?.data;
    assert.equal(turnEnd.reason?.kind, "aborted");
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
        request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
        runsRoot,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "launch_failed");
    assert.equal(result.exit_code, 6);
    const manifest = await readJSON(path.join(runsRoot, runId, "manifest.json"));
    assert.equal(manifest.status, "failed");
    assert.ok(await readJSON(path.join(runsRoot, runId, "result.json")));
});
test("preparation failures still emit a terminal JSONL event", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-preparation-failure-"));
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = path.join(root, "missing-codex");
    t.after(() => restoreEnv("HITCH_CODEX_PATH", previous));
    const runId = newRunId();
    const events = [];
    const result = await executeRun({
        runId,
        request: request({ agent: "codex", cwd: root, prompt: "hello", timeout_ms: 5_000, agent_args: [] }),
        runsRoot: path.join(root, "runs"),
        onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "revision_not_found");
    assert.ok(events.some((event) => event.type === "run.failed" && event.error.code === "revision_not_found"));
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
//# sourceMappingURL=engine.test.js.map