import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonServer, daemonClient } from "../src/daemon.js";
import { delay } from "../src/process.js";
import { writeFakeCodex } from "../test-support/helpers.js";
import { atomicWriteJSON, readJSON } from "../src/fs.js";
import { statePaths } from "../src/config.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeWorkspace } from "../src/workspaces.js";
const hitchExecutable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
function runCLI(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hitchExecutable, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
}
test("daemon authenticates mutations, executes a queued run, and reports health", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-"));
    const executable = await writeFakeCodex(root);
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    const server = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => { } });
    await server.start();
    t.after(async () => {
        await server.close();
        if (previous === undefined)
            delete process.env.HITCH_CODEX_PATH;
        else
            process.env.HITCH_CODEX_PATH = previous;
    });
    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/health`);
    const health = await healthResponse.json();
    assert.equal(health.status, "running");
    assert.match(health.instance_id, /^[a-f0-9]{32}$/);
    assert.match(health.root_id, /^[a-f0-9]{24}$/);
    assert.ok(health.agents.includes("codex"));
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/runs`, {
        method: "POST",
        body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    const client = await daemonClient(root);
    await assert.rejects(client.request("/v1/runs", { method: "POST", body: JSON.stringify({ agent: "codex" }) }), (error) => {
        const typed = error;
        return typed.status === 400 && typed.code === "invalid_input" && typed.exitCode === 2;
    });
    await assert.rejects(client.request("/v1/runs", { method: "POST", body: JSON.stringify({ agent: "codex", prompt: "x", cwd: {} }) }), (error) => {
        const typed = error;
        return typed.status === 400 && typed.code === "invalid_input" && typed.exitCode === 2;
    });
    const cliFailure = await runCLI([
        "--root", root,
        "run", "--daemon",
        "--agent", "codex",
        "--cwd", path.join(root, "missing-workspace"),
        "--prompt", "x",
    ]);
    assert.equal(cliFailure.code, 2);
    assert.match(cliFailure.stderr, /workspace does not exist/);
    const accepted = await client.request("/v1/runs", {
        method: "POST",
        body: JSON.stringify({ agent: "codex", cwd: root, prompt: "daemon", timeout_ms: 5_000 }),
    });
    assert.match(accepted.run_id, /^run_[a-f0-9]{32}$/);
    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        status = await client.request(`/v1/runs/${accepted.run_id}`);
        if (status.result)
            break;
        await delay(20);
    }
    if (!status)
        throw new Error("daemon run never produced a status");
    const result = status.result;
    const manifest = status.manifest;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "reply:daemon");
    assert.equal(manifest.canonical_harness_ref, "codex@installed");
    assert.equal(manifest.resolved_revision.source.type, "installed");
    assert.match(manifest.artifact_id, /^sha256:/);
    const firstEventRead = await client.requestWithMetadata(`/v1/runs/${accepted.run_id}/events?offset=0`);
    const rawEvents = firstEventRead.payload;
    assert.equal(typeof rawEvents, "string");
    const events = String(rawEvents).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "run.completed"));
    const nextOffset = Number(firstEventRead.headers.get("x-hitch-next-offset"));
    assert.ok(nextOffset > 0);
    const secondEventRead = await client.requestWithMetadata(`/v1/runs/${accepted.run_id}/events?offset=${nextOffset}`);
    assert.equal(secondEventRead.payload, "");
    assert.equal(Number(secondEventRead.headers.get("x-hitch-next-offset")), nextOffset);
    const appendedEvent = JSON.stringify({
        schema_version: "1",
        sequence: 999,
        timestamp: new Date().toISOString(),
        run_id: accepted.run_id,
        type: "provider.event",
    });
    const splitAt = Math.floor(appendedEvent.length / 2);
    const eventsPath = path.join(statePaths(root).runs, accepted.run_id, "events.jsonl");
    await appendFile(eventsPath, appendedEvent.slice(0, splitAt));
    const partialEventRead = await client.requestWithMetadata(`/v1/runs/${accepted.run_id}/events?offset=${nextOffset}`);
    assert.equal(partialEventRead.payload, "");
    assert.equal(Number(partialEventRead.headers.get("x-hitch-next-offset")), nextOffset);
    await appendFile(eventsPath, `${appendedEvent.slice(splitAt)}\n`);
    const completedEventRead = await client.requestWithMetadata(`/v1/runs/${accepted.run_id}/events?offset=${nextOffset}`);
    assert.equal(completedEventRead.payload, `${appendedEvent}\n`);
    assert.ok(Number(completedEventRead.headers.get("x-hitch-next-offset")) > nextOffset);
    const isolatedSource = await mkdtemp(path.join(tmpdir(), "hitch-daemon-copy-source-"));
    t.after(() => rm(isolatedSource, { recursive: true, force: true }));
    const isolatedAccepted = await client.request("/v1/runs", {
        method: "POST",
        body: JSON.stringify({
            agent: "codex",
            cwd: isolatedSource,
            workspace_mode: "copy",
            prompt: "isolated",
            timeout_ms: 5_000,
        }),
    });
    let isolatedStatus;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        isolatedStatus = await client.request(`/v1/runs/${isolatedAccepted.run_id}`);
        if (isolatedStatus.result)
            break;
        await delay(20);
    }
    if (!isolatedStatus)
        throw new Error("isolated daemon run never produced a status");
    const isolatedResult = isolatedStatus.result;
    const isolatedManifest = isolatedStatus.manifest;
    assert.equal(isolatedResult.status, "succeeded");
    assert.equal(isolatedResult.workspace.mode, "copy");
    assert.equal(isolatedManifest.workspace, isolatedSource);
    assert.notEqual(isolatedManifest.execution_workspace, isolatedSource);
    await removeWorkspace({ root, runId: isolatedAccepted.run_id });
});
test("daemon root lock rejects a second instance and cleanup is owner-scoped", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-daemon-lock-"));
    const executable = await writeFakeCodex(root);
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    t.after(() => {
        if (previous === undefined)
            delete process.env.HITCH_CODEX_PATH;
        else
            process.env.HITCH_CODEX_PATH = previous;
    });
    const first = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => { } });
    await first.start();
    t.after(() => first.close());
    const stateBefore = await readJSON(statePaths(root).daemon);
    const second = new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => { } });
    await assert.rejects(second.start(), (error) => {
        const typed = error;
        return typed.code === "already_running" && typed.exitCode === 2;
    });
    const stateAfter = await readJSON(statePaths(root).daemon);
    assert.equal(stateAfter.instance_id, stateBefore.instance_id);
    assert.notEqual(second.instanceId, first.instanceId);
    await Promise.all([first.close(), first.close()]);
    assert.equal(await readJSON(statePaths(root).daemon, null), null);
    assert.equal(await readJSON(statePaths(root).lock, null), null);
});
test("daemon reclaims a stale lock and releases it after startup failure", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-stale-lock-"));
    const executable = await writeFakeCodex(root);
    const previous = process.env.HITCH_CODEX_PATH;
    process.env.HITCH_CODEX_PATH = executable;
    t.after(() => {
        if (previous === undefined)
            delete process.env.HITCH_CODEX_PATH;
        else
            process.env.HITCH_CODEX_PATH = previous;
    });
    await atomicWriteJSON(statePaths(root).lock, {
        schema_version: "1",
        instance_id: "stale",
        pid: 2_147_483_647,
    });
    const server = new DaemonServer({ root, port: -1, maxConcurrent: 1, logger: () => { } });
    await assert.rejects(server.start());
    assert.equal(await readJSON(statePaths(root).lock, null), null);
});
test("concurrent stale-lock recovery elects exactly one daemon", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-stale-lock-race-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await atomicWriteJSON(statePaths(root).lock, {
        schema_version: "1",
        instance_id: "stale",
        pid: 2_147_483_647,
    });
    const candidates = [
        new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => { } }),
        new DaemonServer({ root, port: 0, maxConcurrent: 1, logger: () => { } }),
    ];
    const settled = await Promise.allSettled(candidates.map((server) => server.start()));
    const winners = settled.filter((result) => result.status === "fulfilled");
    const losers = settled.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, "already_running");
    await winners[0].value.close();
});
//# sourceMappingURL=daemon.test.js.map