import { openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DaemonServer, daemonClient } from "./daemon.js";
import { defaultRoot, DEFAULT_MAX_CONCURRENT, DEFAULT_PORT, parseDuration, positiveInteger, SCHEMA_VERSION, statePaths } from "./config.js";
import { discoverAgents, inspectAgent } from "./registry.js";
import { executeRun, newRunId } from "./engine.js";
import { inspectEval, listEvals, runEval } from "./evals.js";
import { DEFAULT_HARBOR_VERSION, doctorHarbor, setupHarbor } from "./eval-tools.js";
import { HitchError, invalidInput } from "./errors.js";
import { delay } from "./process.js";
import { ensureDir, readJSON } from "./fs.js";
import { listPreparedArtifacts, prepareHarness, resolveHarness } from "./artifacts.js";
import { inspectWorkspace, removeWorkspace, WORKSPACE_MODES } from "./workspaces.js";
import { MessageFeedbackService, resolveFeedbackSession, trajectoryTargetValidator } from "./feedback/service.js";
import { readTrajectory, loadTrajectoryRef } from "./trajectories/store.js";
import { packageVersion as readPackageVersion } from "./package-root.js";
const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
export async function main(argv) {
    const args = [...argv];
    const root = path.resolve(takeOption(args, "--root") || defaultRoot());
    const command = args.shift();
    switch (command) {
        case "list": return listCommand(args);
        case "inspect": return inspectCommand(args, root);
        case "resolve": return resolveCommand(args, root);
        case "prepare": return prepareCommand(args, root);
        case "run": return runCommand(args, root);
        case "eval": return evalCommand(args, root);
        case "workspace": return workspaceCommand(args, root);
        case "trajectory": return trajectoryCommand(args, root);
        case "feedback": return feedbackCommand(args, root);
        case "daemon": return daemonCommand(args, root);
        case "help":
        case "--help":
        case "-h":
        case undefined:
            process.stdout.write(helpText());
            return;
        case "--version":
        case "-V":
            process.stdout.write(`hitch ${readPackageVersion()}\n`);
            return;
        default:
            throw invalidInput(`unknown command: ${command}`);
    }
}
async function listCommand(args) {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const agents = await discoverAgents();
    if (json) {
        process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, harnesses: agents }, null, 2)}\n`);
        return;
    }
    for (const agent of agents) {
        const detail = agent.status === "available" ? `${agent.version || "version unknown"}  ${agent.executable}` : "not installed";
        process.stdout.write(`${agent.id.padEnd(10)} ${agent.status.padEnd(11)} ${detail}\n`);
    }
}
async function inspectCommand(args, root) {
    const json = takeFlag(args, "--json");
    const id = args.shift();
    if (!id)
        throw invalidInput("inspect requires a harness name");
    assertNoArgs(args);
    const harness = {
        ...await inspectAgent(id),
        prepared_artifacts: await listPreparedArtifacts(id, { root }),
    };
    if (json)
        process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, harness }, null, 2)}\n`);
    else
        process.stdout.write(`${harness.display_name}: ${harness.status}${harness.executable ? `\n  executable: ${harness.executable}\n  version: ${harness.version || "unknown"}` : ""}\n  prepared artifacts: ${harness.prepared_artifacts.length}\n`);
}
async function resolveCommand(args, root) {
    const json = takeFlag(args, "--json");
    const reference = args.shift();
    if (!reference)
        throw invalidInput("resolve requires a harness reference");
    assertNoArgs(args);
    const resolved = await resolveHarness(reference, { root });
    if (json)
        process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    else
        process.stdout.write(`${resolved.canonical_ref} -> ${revisionLabel(resolved)} (${resolved.identity})\n`);
}
async function prepareCommand(args, root) {
    const json = takeFlag(args, "--json");
    const reference = args.shift();
    if (!reference)
        throw invalidInput("prepare requires a harness reference");
    assertNoArgs(args);
    const resolved = await resolveHarness(reference, { root });
    const artifact = await prepareHarness(resolved, { root });
    if (json)
        process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, resolved_revision: resolved, artifact }, null, 2)}\n`);
    else
        process.stdout.write(`${artifact.cache_hit ? "Cached" : "Prepared"} ${resolved.canonical_ref} as ${artifact.artifact_id}\n`);
}
async function runCommand(args, root) {
    const useDaemon = takeFlag(args, "--daemon");
    const output = takeOption(args, "--output") || "jsonl";
    const request = await parseRunRequest(args);
    assertNoArgs(args);
    if (!new Set(["json", "jsonl"]).has(output))
        throw invalidInput("--output must be json or jsonl");
    if (useDaemon) {
        const client = await daemonClient(root);
        const accepted = await client.request("/v1/runs", { method: "POST", body: JSON.stringify(request) });
        const result = await waitForDaemonRun(client, accepted.run_id, output);
        process.exitCode = result.exit_code;
        return;
    }
    const runId = newRunId();
    const result = await executeRun({
        runId,
        request,
        runsRoot: statePaths(root).runs,
        root,
        ...(output === "jsonl" ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
    });
    if (output === "json")
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.exit_code;
}
async function evalCommand(args, root) {
    const action = args.shift();
    switch (action) {
        case "run": return evalRunCommand(args, root);
        case "list": return evalListCommand(args, root);
        case "inspect": return evalInspectCommand(args, root);
        case "setup": return evalSetupCommand(args, root);
        case "doctor": return evalDoctorCommand(args, root);
        default: throw invalidInput("eval requires run, list, inspect, setup, or doctor");
    }
}
async function evalSetupCommand(args, root) {
    const backend = args.shift();
    if (backend !== "harbor")
        throw invalidInput("eval setup currently supports only harbor");
    const version = takeOption(args, "--version") || DEFAULT_HARBOR_VERSION;
    const python = takeOption(args, "--python");
    const force = takeFlag(args, "--force");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const result = await setupHarbor({
        root,
        version,
        ...(python !== undefined ? { python } : {}),
        force,
        ...(json ? {} : { onProgress: (message) => process.stderr.write(`${message}\n`) }),
    });
    if (json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
        process.stdout.write(`${result.cache_hit ? "Using" : "Installed"} Harbor ${result.version} at ${result.executable}\n`);
}
async function evalDoctorCommand(args, root) {
    const json = takeFlag(args, "--json");
    const python = takeOption(args, "--python");
    const harbor = takeOption(args, "--harbor");
    const docker = takeOption(args, "--docker");
    assertNoArgs(args);
    const result = await doctorHarbor({
        root,
        ...(python !== undefined ? { python } : {}),
        ...(harbor !== undefined ? { harbor } : {}),
        ...(docker !== undefined ? { docker } : {}),
    });
    if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    else {
        process.stdout.write(`Harbor eval: ${result.status}\n`);
        for (const [name, check] of Object.entries(result.checks)) {
            const detail = check.version || check.message || (check.present?.length ? check.present.join(", ") : "");
            process.stdout.write(`  ${name.padEnd(12)} ${check.status}${detail ? `  ${detail}` : ""}\n`);
        }
    }
    if (!result.ready)
        process.exitCode = 3;
}
async function evalRunCommand(args, root) {
    const output = takeOption(args, "--output") || "json";
    const harborExecutable = takeOption(args, "--harbor");
    const request = parseEvalRequest(args);
    assertNoArgs(args);
    if (!new Set(["json", "jsonl"]).has(output))
        throw invalidInput("--output must be json or jsonl");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
        const result = await runEval({
            request,
            root,
            ...(harborExecutable !== undefined ? { harborExecutable } : {}),
            signal: controller.signal,
            ...(output === "jsonl" ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
        });
        if (output === "json")
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = result.exit_code;
    }
    finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}
async function evalListCommand(args, root) {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const evals = await listEvals({ root });
    if (json) {
        process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, evals }, null, 2)}\n`);
        return;
    }
    if (evals.length === 0) {
        process.stdout.write("No evals found\n");
        return;
    }
    for (const evaluation of evals) {
        const reward = evaluation.primary_reward === null ? "-" : String(evaluation.primary_reward);
        process.stdout.write(`${evaluation.eval_id}  ${String(evaluation.status).padEnd(9)}  reward=${reward}  ${evaluation.harness_ref || "-"}  ${evaluation.dataset || "-"}\n`);
    }
}
async function evalInspectCommand(args, root) {
    const json = takeFlag(args, "--json");
    const evalId = args.shift();
    if (!evalId)
        throw invalidInput("eval inspect requires an eval ID");
    assertNoArgs(args);
    const evaluation = await inspectEval(evalId, { root });
    if (json) {
        process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
        return;
    }
    const result = evaluation.result;
    process.stdout.write(`${evaluation.eval_id}: ${result?.status || "running"}\n`);
    process.stdout.write(`  dataset: ${evaluation.request?.dataset}\n`);
    process.stdout.write(`  harness: ${evaluation.plan?.candidate?.harness_ref || evaluation.request?.harness_ref}\n`);
    process.stdout.write(`  primary reward: ${result?.summary?.primary_reward ?? "-"}\n`);
    process.stdout.write(`  runtime storage: ${evaluation.runtime_storage}\n`);
    process.stdout.write(`  directory: ${evaluation.directory}\n`);
}
async function daemonCommand(args, root) {
    const action = args.shift();
    switch (action) {
        case "serve": return daemonServe(args, root);
        case "start": return daemonStart(args, root);
        case "stop": return daemonStop(args, root);
        case "status": return daemonStatus(args, root);
        case "submit": return daemonSubmit(args, root);
        case "cancel": return daemonCancel(args, root);
        case "logs": return daemonLogs(args, root);
        default: throw invalidInput("daemon requires start, serve, stop, status, submit, cancel, or logs");
    }
}
async function workspaceCommand(args, root) {
    const action = args.shift();
    const runId = args.shift();
    if (!runId)
        throw invalidInput("workspace requires a run ID");
    if (action === "inspect") {
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const workspace = await inspectWorkspace({ root, runId: runId });
        if (!workspace)
            throw new HitchError(`workspace record not found: ${runId}`, { code: "workspace_not_found", exitCode: 3 });
        if (json)
            process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
        else
            process.stdout.write(`${runId}: ${workspace.mode} ${workspace.status}\n  source: ${workspace.source_workspace}\n  execution: ${workspace.execution_workspace}\n  retained: ${workspace.retained ? "yes" : "no"}${workspace.changed === undefined || workspace.changed === null ? "" : `\n  changed: ${workspace.changed ? "yes" : "no"}`}\n`);
        return;
    }
    if (action === "path") {
        assertNoArgs(args);
        const workspace = await inspectWorkspace({ root, runId: runId });
        if (!workspace)
            throw new HitchError(`workspace record not found: ${runId}`, { code: "workspace_not_found", exitCode: 3 });
        if (!workspace.retained)
            throw new HitchError(`run ${runId} has no retained workspace`, { code: "workspace_not_retained", exitCode: 3 });
        process.stdout.write(`${workspace.execution_workspace}\n`);
        return;
    }
    if (action === "remove") {
        const force = takeFlag(args, "--force");
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const workspace = await removeWorkspace({ root, runId: runId, force });
        if (json)
            process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
        else
            process.stdout.write(`Removed workspace for ${runId}\n`);
        return;
    }
    throw invalidInput("workspace requires inspect, path, or remove");
}
async function trajectoryCommand(args, root) {
    const action = args.shift();
    if (action !== "inspect")
        throw invalidInput("trajectory requires inspect");
    const json = takeFlag(args, "--json");
    const runId = args.shift();
    if (!runId)
        throw invalidInput("trajectory inspect requires a run ID");
    assertNoArgs(args);
    const runDirectory = path.join(statePaths(root).runs, runId);
    const ref = await loadTrajectoryRef(runDirectory);
    if (!ref) {
        throw new HitchError(`run ${runId} has no canonical trajectory`, { code: "trajectory_not_found", exitCode: 3 });
    }
    const { header, events } = await readTrajectory(ref.path);
    if (json) {
        process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, run_id: runId, ref, header, events }, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${runId}: ${ref.fidelity} trajectory (${events.length} events)\n`);
    process.stdout.write(`  session: ${ref.session_id}\n`);
    process.stdout.write(`  path: ${ref.path}\n`);
    const assistantMessages = events.filter((event) => event.type === "assistant/message");
    const toolResults = events.filter((event) => event.type === "tool/result");
    process.stdout.write(`  assistant messages: ${assistantMessages.length}, tool results: ${toolResults.length}\n`);
}
async function feedbackCommand(args, root) {
    const action = args.shift();
    const runId = args.shift();
    if (!runId)
        throw invalidInput("feedback requires a run ID");
    const runDirectory = path.join(statePaths(root).runs, runId);
    const session = await resolveFeedbackSession(runDirectory);
    if (!session) {
        throw new HitchError(`run ${runId} has no canonical trajectory for feedback`, {
            code: "session-not-found",
            exitCode: 3,
        });
    }
    const service = new MessageFeedbackService({
        root: runDirectory,
        validateTarget: await trajectoryTargetValidator(runDirectory),
    });
    if (action === "list") {
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const items = await service.list({ sessionId: session.sessionId }, session);
        if (json) {
            process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, run_id: runId, session_id: session.sessionId, items }, null, 2)}\n`);
            return;
        }
        if (items.length === 0) {
            process.stdout.write("No feedback\n");
            return;
        }
        for (const item of items) {
            process.stdout.write(`${item.messageId}  ${item.rating}  v${item.version}${item.note ? `  ${item.note}` : ""}\n`);
        }
        return;
    }
    if (action === "put") {
        const json = takeFlag(args, "--json");
        const messageId = takeOption(args, "--message");
        const ratingValue = takeOption(args, "--rating");
        const note = takeOption(args, "--note");
        const ifVersion = takeOption(args, "--if-version");
        assertNoArgs(args);
        if (!messageId)
            throw invalidInput("feedback put requires --message <id>");
        if (ratingValue !== "positive" && ratingValue !== "negative") {
            throw invalidInput("feedback put requires --rating positive|negative");
        }
        const item = await service.put({
            sessionId: session.sessionId,
            messageId,
            rating: ratingValue,
            ...(note !== undefined ? { note } : {}),
            ifVersion: ifVersion === undefined ? null : ifVersion,
        }, session, { messageId });
        if (json)
            process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, item }, null, 2)}\n`);
        else
            process.stdout.write(`${item.messageId}: ${item.rating} (v${item.version})\n`);
        return;
    }
    if (action === "delete") {
        const json = takeFlag(args, "--json");
        const messageId = takeOption(args, "--message");
        const ifVersion = takeOption(args, "--if-version");
        assertNoArgs(args);
        if (!messageId)
            throw invalidInput("feedback delete requires --message <id>");
        await service.delete({
            sessionId: session.sessionId,
            messageId,
            ifVersion: ifVersion === undefined ? null : ifVersion,
        }, session);
        if (json)
            process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, absent: true }, null, 2)}\n`);
        else
            process.stdout.write(`Deleted feedback for ${messageId}\n`);
        return;
    }
    throw invalidInput("feedback requires list, put, or delete");
}
async function daemonServe(args, root) {
    const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
    const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
    assertNoArgs(args);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw invalidInput("--port must be between 0 and 65535");
    const server = new DaemonServer({ root, port, maxConcurrent });
    await server.start();
    const shutdown = () => server.close().catch((error) => process.stderr.write(`shutdown error: ${error.message}\n`));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await server.closed;
}
async function daemonStart(args, root) {
    const foreground = takeFlag(args, "--foreground");
    const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
    const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
    assertNoArgs(args);
    const health = await probeHealth(root);
    if (health?.status === "running")
        throw new HitchError(`daemon is already running (pid ${health.pid})`, { code: "already_running", exitCode: 2 });
    if (foreground)
        return daemonServe(["--port", String(port), "--max-concurrent", String(maxConcurrent)], root);
    const paths = statePaths(root);
    await ensureDir(root);
    const stdout = openSync(paths.log, "a", 0o600);
    const stderr = openSync(paths.errorLog, "a", 0o600);
    const child = spawn(process.execPath, [executable, "--root", root, "daemon", "serve", "--port", String(port), "--max-concurrent", String(maxConcurrent)], {
        detached: true,
        stdio: ["ignore", stdout, stderr],
        windowsHide: true,
    });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(100);
        const current = await probeHealth(root);
        if (current?.status === "running" && current.pid === child.pid) {
            process.stdout.write(`Hitch daemon started (pid ${current.pid}, port ${current.port})\n`);
            return;
        }
    }
    throw new HitchError(`daemon did not become ready; see ${paths.errorLog}`, { code: "daemon_start_failed", exitCode: 12 });
}
async function daemonStop(args, root) {
    assertNoArgs(args);
    const client = await daemonClient(root);
    const response = await client.request("/shutdown", { method: "POST" });
    process.stdout.write(`${response.status}\n`);
}
async function daemonStatus(args, root) {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const health = await probeHealth(root);
    if (!health) {
        if (json)
            process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, status: "stopped" })}\n`);
        else
            process.stdout.write("Hitch daemon is stopped\n");
        process.exitCode = 3;
        return;
    }
    if (json)
        process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    else
        process.stdout.write(`Hitch daemon is ${health.status} (pid ${health.pid}, port ${health.port}, ${health.scheduler?.running} running, ${health.scheduler?.queued} queued)\n`);
}
async function daemonSubmit(args, root) {
    const wait = takeFlag(args, "--wait");
    const output = takeOption(args, "--output") || "json";
    const request = await parseRunRequest(args);
    assertNoArgs(args);
    const client = await daemonClient(root);
    const accepted = await client.request("/v1/runs", { method: "POST", body: JSON.stringify(request) });
    if (!wait) {
        process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
        return;
    }
    const result = await waitForDaemonRun(client, accepted.run_id, output);
    process.exitCode = result.exit_code;
}
async function daemonCancel(args, root) {
    const runId = args.shift();
    if (!runId)
        throw invalidInput("daemon cancel requires a run ID");
    assertNoArgs(args);
    const client = await daemonClient(root);
    const response = await client.request(`/v1/runs/${runId}/cancel`, { method: "POST" });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}
async function daemonLogs(args, root) {
    const lines = positiveInteger(takeOption(args, "-n") || 50, "-n");
    assertNoArgs(args);
    let content = "";
    try {
        content = await readFile(statePaths(root).log, "utf8");
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    process.stdout.write(`${content.trimEnd().split(/\r?\n/).slice(-lines).join("\n")}\n`);
}
async function parseRunRequest(args) {
    const harness = takeOption(args, "--harness");
    const agent = takeOption(args, "--agent");
    const model = takeOption(args, "--model") || "";
    const cwd = takeOption(args, "--cwd") || process.cwd();
    const workspaceMode = takeOption(args, "--workspace-mode") || "shared";
    const promptValue = takeOption(args, "--prompt");
    const promptFile = takeOption(args, "--prompt-file");
    const timeout = parseDuration(takeOption(args, "--timeout") || "0");
    const agentArgs = takeRepeatedOption(args, "--agent-arg");
    if (harness && agent)
        throw invalidInput("use only one of --harness and the legacy --agent option");
    if (!harness && !agent)
        throw invalidInput("--harness is required");
    if (!WORKSPACE_MODES.has(workspaceMode))
        throw invalidInput(`--workspace-mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
    if (agent?.includes("@"))
        throw invalidInput("--agent accepts only a harness name; use --harness for revision selection");
    if (promptValue !== undefined && promptFile)
        throw invalidInput("use only one of --prompt and --prompt-file");
    let prompt = promptValue;
    if (promptFile)
        prompt = await readFile(path.resolve(promptFile), "utf8");
    if (prompt === undefined && !process.stdin.isTTY)
        prompt = readFileSync(0, "utf8");
    if (!prompt)
        throw invalidInput("provide --prompt, --prompt-file, or stdin");
    return { harness_ref: harness || `${agent}@installed`, model, cwd, workspace_mode: workspaceMode, prompt, timeout_ms: timeout, agent_args: agentArgs };
}
function parseEvalRequest(args) {
    const backend = takeOption(args, "--backend") || "harbor";
    const dataset = takeOption(args, "--dataset");
    const harness = takeOption(args, "--harness");
    const model = takeOption(args, "--model") || "";
    const attempts = positiveInteger(takeOption(args, "--attempts") || 1, "--attempts");
    const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
    const timeoutValue = takeOption(args, "--timeout");
    const setupTimeoutValue = takeOption(args, "--setup-timeout");
    const agentArgs = takeRepeatedOption(args, "--agent-arg");
    const passEnv = takeRepeatedOption(args, "--pass-env");
    if (!dataset)
        throw invalidInput("--dataset is required");
    if (!harness)
        throw invalidInput("--harness is required");
    return {
        backend,
        dataset,
        harness_ref: harness,
        model,
        attempts,
        max_concurrent: maxConcurrent,
        timeout_ms: timeoutValue === undefined ? undefined : parseDuration(timeoutValue),
        setup_timeout_ms: setupTimeoutValue === undefined ? undefined : parseDuration(setupTimeoutValue),
        agent_args: agentArgs,
        pass_env: passEnv,
    };
}
function revisionLabel(resolved) {
    if (resolved.revision.type === "commit")
        return resolved.revision.commit || "";
    if (resolved.revision.type === "version")
        return resolved.revision.version || "";
    return resolved.revision.version || resolved.source.integrity || "";
}
async function waitForDaemonRun(client, runId, output) {
    let eventOffset = 0;
    for (;;) {
        const status = await client.request(`/v1/runs/${runId}`);
        if (output === "jsonl") {
            try {
                const response = await client.requestWithMetadata(`/v1/runs/${runId}/events?offset=${eventOffset}`);
                const raw = response.payload;
                for (const line of String(raw).trim().split(/\r?\n/).filter(Boolean)) {
                    JSON.parse(line);
                    process.stdout.write(`${line}\n`);
                }
                eventOffset = Number(response.headers.get("x-hitch-next-offset") || eventOffset);
            }
            catch (error) {
                if (error.status !== 404)
                    throw error;
            }
        }
        if (status.result) {
            if (output === "json")
                process.stdout.write(`${JSON.stringify(status.result, null, 2)}\n`);
            return status.result;
        }
        await delay(200);
    }
}
async function probeHealth(root) {
    const state = await readJSON(statePaths(root).daemon, null);
    if (!state?.port)
        return null;
    try {
        const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok)
            return null;
        const health = await response.json();
        return health.instance_id === state.instance_id ? health : null;
    }
    catch {
        return null;
    }
}
function takeOption(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return undefined;
    if (index === args.length - 1)
        throw invalidInput(`${name} requires a value`);
    const [value] = args.splice(index + 1, 1);
    args.splice(index, 1);
    return value;
}
function takeRepeatedOption(args, name) {
    const values = [];
    for (;;) {
        const value = takeOption(args, name);
        if (value === undefined)
            return values;
        values.push(value);
    }
}
function takeFlag(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return false;
    args.splice(index, 1);
    return true;
}
function assertNoArgs(args) {
    if (args.length > 0)
        throw invalidInput(`unexpected argument: ${args[0]}`);
}
function helpText() {
    return `Hitch — content-addressed version control and evidence storage for agent harnesses

Usage:
  hitch list [--json]
  hitch inspect <harness> [--json]
  hitch resolve <harness-ref> [--json]
  hitch prepare <harness-ref> [--json]
  hitch run --harness <ref> [--model <id>] [--workspace-mode <mode>] --prompt <text> [--daemon]
  hitch eval setup harbor [--version <version>] [--python <path>] [--force] [--json]
  hitch eval doctor [--harbor <path>] [--python <path>] [--docker <path>] [--json]
  hitch eval run [--backend harbor] --dataset <ref> --harness <immutable-ref> [--model <id>] [--attempts <n>]
  hitch eval list [--json]
  hitch eval inspect <eval-id> [--json]
  hitch workspace inspect <run-id> [--json]
  hitch workspace path <run-id>
  hitch workspace remove <run-id> [--force] [--json]
  hitch trajectory inspect <run-id> [--json]
  hitch feedback list <run-id> [--json]
  hitch feedback put <run-id> --message <id> --rating positive|negative [--note <text>] [--if-version <v>] [--json]
  hitch feedback delete <run-id> --message <id> [--if-version <v>] [--json]
  hitch daemon start [--foreground] [--port <port>] [--max-concurrent <n>]
  hitch daemon stop | status [--json] | logs [-n <lines>]
  hitch daemon submit --harness <ref> --prompt <text> [--workspace-mode <mode>] [--wait]
  hitch daemon cancel <run-id>

Eval:
  Harbor runs each task in Docker; Hitch executes the selected harness inside that task container.
  Use 'hitch eval setup harbor' for an isolated managed install and 'hitch eval doctor' to verify it.
  Eval accepts exact version: or registered commit: refs. Use --pass-env NAME for extra credentials.
  Every eval references a shared read-only controller runtime bundle by SHA-256 id
  (see 'hitch eval inspect' for the runtime storage kind).

Trajectory and feedback:
  Every run records a DSH-compatible canonical trajectory under runs/<run>/trajectory/
  with a trajectory.ref.json pointer. Message feedback is a lifecycle-bound sidecar.

Workspace modes:
  shared    Use the source directory directly (compatibility default)
  worktree  Create a detached worktree from a clean Git HEAD
  copy      Copy the current filesystem state into an independent workspace

Harness refs:
  codex                         Installed executable (compatibility default)
  codex@installed               Installed executable
  codex@version:0.42.1          Exact published version
  codex@commit:abc1234          Commit from the registered Git source
  codex@git+file:///src#abc1234 Commit from a clean local Git repository

Global:
  --root <path>    Relocate all Hitch state (default: ~/.hitch)
`;
}
//# sourceMappingURL=cli.js.map