import { openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DaemonServer, daemonClient } from "./daemon.js";
import { defaultRoot, DEFAULT_MAX_CONCURRENT, DEFAULT_PORT, parseDuration, positiveInteger, SCHEMA_VERSION, statePaths } from "./config.js";
import { discoverAgents, inspectAgent } from "./registry.js";
import { executeRun, newRunId } from "./engine.js";
import { HitchError, invalidInput } from "./errors.js";
import { delay } from "./process.js";
import { ensureDir, readJSON } from "./fs.js";

const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));

export async function main(argv) {
  const args = [...argv];
  const root = path.resolve(takeOption(args, "--root") || defaultRoot());
  const command = args.shift();

  switch (command) {
    case "list": return listCommand(args);
    case "inspect": return inspectCommand(args);
    case "run": return runCommand(args, root);
    case "daemon": return daemonCommand(args, root);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(helpText());
      return;
    case "--version":
    case "-V":
      process.stdout.write("hitch 0.1.0\n");
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
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, agents }, null, 2)}\n`);
    return;
  }
  for (const agent of agents) {
    const detail = agent.status === "available" ? `${agent.version || "version unknown"}  ${agent.executable}` : "not installed";
    process.stdout.write(`${agent.id.padEnd(10)} ${agent.status.padEnd(11)} ${detail}\n`);
  }
}

async function inspectCommand(args) {
  const json = takeFlag(args, "--json");
  const id = args.shift();
  if (!id) throw invalidInput("inspect requires an agent name");
  assertNoArgs(args);
  const agent = await inspectAgent(id);
  if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, agent }, null, 2)}\n`);
  else process.stdout.write(`${agent.display_name}: ${agent.status}${agent.executable ? `\n  executable: ${agent.executable}\n  version: ${agent.version || "unknown"}` : ""}\n`);
}

async function runCommand(args, root) {
  const useDaemon = takeFlag(args, "--daemon");
  const output = takeOption(args, "--output") || "jsonl";
  const request = await parseRunRequest(args);
  assertNoArgs(args);
  if (!new Set(["json", "jsonl"]).has(output)) throw invalidInput("--output must be json or jsonl");

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
    onEvent: output === "jsonl" ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`) : undefined,
  });
  if (output === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exit_code;
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

async function daemonServe(args, root) {
  const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  assertNoArgs(args);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalidInput("--port must be between 0 and 65535");
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
  if (health?.status === "running") throw new HitchError(`daemon is already running (pid ${health.pid})`, { code: "already_running", exitCode: 2 });
  if (foreground) return daemonServe(["--port", String(port), "--max-concurrent", String(maxConcurrent)], root);

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
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, status: "stopped" })}\n`);
    else process.stdout.write("Hitch daemon is stopped\n");
    process.exitCode = 3;
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  else process.stdout.write(`Hitch daemon is ${health.status} (pid ${health.pid}, port ${health.port}, ${health.scheduler.running} running, ${health.scheduler.queued} queued)\n`);
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
  if (!runId) throw invalidInput("daemon cancel requires a run ID");
  assertNoArgs(args);
  const client = await daemonClient(root);
  const response = await client.request(`/v1/runs/${runId}/cancel`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function daemonLogs(args, root) {
  const lines = positiveInteger(takeOption(args, "-n") || 50, "-n");
  assertNoArgs(args);
  let content = "";
  try { content = await readFile(statePaths(root).log, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  process.stdout.write(`${content.trimEnd().split(/\r?\n/).slice(-lines).join("\n")}\n`);
}

async function parseRunRequest(args) {
  const agent = takeOption(args, "--agent");
  const model = takeOption(args, "--model") || "";
  const cwd = takeOption(args, "--cwd") || process.cwd();
  const promptValue = takeOption(args, "--prompt");
  const promptFile = takeOption(args, "--prompt-file");
  const timeout = parseDuration(takeOption(args, "--timeout") || "0");
  const agentArgs = takeRepeatedOption(args, "--agent-arg");
  if (!agent) throw invalidInput("--agent is required");
  if (promptValue !== undefined && promptFile) throw invalidInput("use only one of --prompt and --prompt-file");
  let prompt = promptValue;
  if (promptFile) prompt = await readFile(path.resolve(promptFile), "utf8");
  if (prompt === undefined && !process.stdin.isTTY) prompt = readFileSync(0, "utf8");
  if (!prompt) throw invalidInput("provide --prompt, --prompt-file, or stdin");
  return { agent, model, cwd, prompt, timeout_ms: timeout, agent_args: agentArgs };
}

async function waitForDaemonRun(client, runId, output) {
  let eventOffset = 0;
  for (;;) {
    const status = await client.request(`/v1/runs/${runId}`);
    if (output === "jsonl") {
      try {
        const response = await client.requestWithMetadata(`/v1/runs/${runId}/events?offset=${eventOffset}`);
        const raw = response.payload;
        for (const line of raw.trim().split(/\r?\n/).filter(Boolean)) {
          JSON.parse(line);
          process.stdout.write(`${line}\n`);
        }
        eventOffset = Number(response.headers.get("x-hitch-next-offset") || eventOffset);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (status.result) {
      if (output === "json") process.stdout.write(`${JSON.stringify(status.result, null, 2)}\n`);
      return status.result;
    }
    await delay(200);
  }
}

async function probeHealth(root) {
  const state = await readJSON(statePaths(root).daemon, null);
  if (!state?.port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const health = await response.json();
    return health.instance_id === state.instance_id ? health : null;
  } catch {
    return null;
  }
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index === args.length - 1) throw invalidInput(`${name} requires a value`);
  const [value] = args.splice(index + 1, 1);
  args.splice(index, 1);
  return value;
}

function takeRepeatedOption(args, name) {
  const values = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function assertNoArgs(args) {
  if (args.length > 0) throw invalidInput(`unexpected argument: ${args[0]}`);
}

function helpText() {
  return `Hitch — one local runtime for coding agents\n\nUsage:\n  hitch list [--json]\n  hitch inspect <agent> [--json]\n  hitch run --agent <name> [--model <id>] --prompt <text> [--daemon]\n  hitch daemon start [--foreground] [--port <port>] [--max-concurrent <n>]\n  hitch daemon stop | status [--json] | logs [-n <lines>]\n  hitch daemon submit --agent <name> --prompt <text> [--wait]\n  hitch daemon cancel <run-id>\n\nGlobal:\n  --root <path>    Relocate all Hitch state (default: ~/.hitch)\n`;
}
