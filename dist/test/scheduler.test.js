import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { atomicWriteJSON, readJSON } from "../src/fs.js";
import { writeFakeCodex } from "../test-support/helpers.js";
import { delay } from "../src/process.js";
function request(overrides = {}) {
    return { agent: "codex", cwd: "/tmp", prompt: "work", timeout_ms: 5_000, agent_args: [], ...overrides };
}
test("scheduler can cancel a queued run without launching it", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-scheduler-"));
    const executable = await writeFakeCodex(root, { delayMs: 500 });
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    t.after(() => {
        if (previous === undefined)
            delete process.env.HITCH_CODEX_PATH;
        else
            process.env.HITCH_CODEX_PATH = previous;
    });
    const scheduler = new Scheduler({ runsRoot: path.join(root, "runs"), maxConcurrent: 1 });
    t.after(() => scheduler.shutdown());
    await scheduler.initialize();
    const base = request({ cwd: root });
    const first = await scheduler.submit(base);
    const second = await scheduler.submit(base);
    assert.equal(await scheduler.cancel(second), true);
    const status = await scheduler.status(second);
    assert.equal((status?.result).status, "cancelled");
    assert.equal((await readJSON(path.join(root, "runs", second, "workspace.json"))).status, "cancelled");
    await scheduler.cancel(first);
    const firstStatus = await waitForResult(scheduler, first);
    assert.equal((firstStatus?.result).status, "cancelled");
});
test("scheduler fails ambiguous interrupted work instead of replaying it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-recovery-"));
    const runsRoot = path.join(root, "runs");
    const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const directory = path.join(runsRoot, runId);
    await mkdir(directory, { recursive: true });
    await atomicWriteJSON(path.join(directory, "manifest.json"), {
        schema_version: "1",
        run_id: runId,
        status: "running",
    });
    await atomicWriteJSON(path.join(directory, "workspace.json"), {
        schema_version: "1",
        run_id: runId,
        mode: "copy",
        status: "running",
        retained: true,
    });
    const scheduler = new Scheduler({ runsRoot, maxConcurrent: 1 });
    await scheduler.initialize();
    const status = await scheduler.status(runId);
    assert.equal((status?.result).status, "failed");
    assert.equal((status?.result).error.code, "daemon_restarted");
    assert.equal((await readJSON(path.join(directory, "workspace.json"))).status, "orphaned");
});
test("scheduler starts runs in FIFO order at bounded concurrency", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-fifo-"));
    const executable = await writeFakeCodex(root, { delayMs: 30 });
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    t.after(() => {
        if (previous === undefined)
            delete process.env.HITCH_CODEX_PATH;
        else
            process.env.HITCH_CODEX_PATH = previous;
    });
    const started = [];
    const scheduler = new Scheduler({
        runsRoot: path.join(root, "runs"),
        maxConcurrent: 1,
        onEvent: (event) => { if (event.type === "run.started")
            started.push(event.run_id); },
    });
    await scheduler.initialize();
    t.after(() => scheduler.shutdown());
    const base = request({ cwd: root, prompt: "fifo" });
    const runIds = [];
    for (let index = 0; index < 3; index += 1)
        runIds.push(await scheduler.submit(base));
    await Promise.all(runIds.map((runId) => waitForResult(scheduler, runId)));
    assert.deepEqual(started, runIds);
});
async function waitForResult(scheduler, runId) {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const status = await scheduler.status(runId);
        if (status?.result)
            return status;
        await delay(10);
    }
    throw new Error(`timed out waiting for ${runId}`);
}
//# sourceMappingURL=scheduler.test.js.map