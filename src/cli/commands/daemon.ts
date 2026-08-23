import { fileURLToPath } from "node:url";
import { DaemonServer, daemonClient, probeDaemonHealth, readDaemonLogs, startDetachedDaemon } from "../../daemon/index.js";
import { discoverAgents } from "../../adapters/index.js";
import { DEFAULT_MAX_CONCURRENT, DEFAULT_PORT, HitchError, SCHEMA_VERSION, delay, invalidInput, positiveInteger } from "../../foundation/index.js";
import { assertNoArgs, parseRunRequest, takeFlag, takeOption } from "../arguments.js";
import { waitForDaemonRun } from "../output.js";

const executable = fileURLToPath(new URL("../../../bin/hitch.js", import.meta.url));

export async function daemonCommand(args: string[], root: string): Promise<void> {
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

async function daemonServe(args: string[], root: string): Promise<void> {
  const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  assertNoArgs(args);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalidInput("--port must be between 0 and 65535");
  const server = new DaemonServer({ root, port, maxConcurrent, discoverHarnesses: discoverAgents });
  await server.start();
  const shutdown = () => server.close().catch((error) => process.stderr.write(`shutdown error: ${(error as Error).message}\n`));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.closed;
}

async function daemonStart(args: string[], root: string): Promise<void> {
  const foreground = takeFlag(args, "--foreground");
  const port = Number(takeOption(args, "--port") || DEFAULT_PORT);
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  assertNoArgs(args);
  const health = await probeDaemonHealth(root);
  if (health?.status === "running") throw new HitchError(`daemon is already running (pid ${health.pid})`, { code: "already_running", exitCode: 2 });
  if (foreground) return daemonServe(["--port", String(port), "--max-concurrent", String(maxConcurrent)], root);

  const child = await startDetachedDaemon({ root, executable, port, maxConcurrent });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    const current = await probeDaemonHealth(root);
    if (current?.status === "running" && current.pid === child.pid) {
      process.stdout.write(`Hitch daemon started (pid ${current.pid}, port ${current.port})\n`);
      return;
    }
  }
  throw new HitchError(`daemon did not become ready; see ${child.errorLog}`, { code: "daemon_start_failed", exitCode: 12 });
}

async function daemonStop(args: string[], root: string): Promise<void> {
  assertNoArgs(args);
  const client = await daemonClient(root);
  const response = await client.request("/shutdown", { method: "POST" });
  process.stdout.write(`${response.status as string}\n`);
}

async function daemonStatus(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const health = await probeDaemonHealth(root);
  if (!health) {
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, status: "stopped" })}\n`);
    else process.stdout.write("Hitch daemon is stopped\n");
    process.exitCode = 3;
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  else process.stdout.write(`Hitch daemon is ${health.status} (pid ${health.pid}, port ${health.port}, ${(health.scheduler as Record<string, unknown>)?.running} running, ${(health.scheduler as Record<string, unknown>)?.queued} queued)\n`);
}

async function daemonSubmit(args: string[], root: string): Promise<void> {
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
  const result = await waitForDaemonRun(client, accepted.run_id as string, output);
  process.exitCode = (result as { exit_code?: unknown }).exit_code as number;
}

async function daemonCancel(args: string[], root: string): Promise<void> {
  const runId = args.shift();
  if (!runId) throw invalidInput("daemon cancel requires a run ID");
  assertNoArgs(args);
  const client = await daemonClient(root);
  const response = await client.request(`/v1/runs/${runId}/cancel`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function daemonLogs(args: string[], root: string): Promise<void> {
  const lines = positiveInteger(takeOption(args, "-n") || 50, "-n");
  assertNoArgs(args);
  process.stdout.write(`${await readDaemonLogs(root, lines)}\n`);
}
