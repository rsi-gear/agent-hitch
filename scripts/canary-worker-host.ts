import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { observeControllerRuntime } from "../src/controller-runtime/index.js";
import { atomicWriteJSON, hitchRootId, runCommand } from "../src/foundation/index.js";
import { parseCanaryWorkerConfig, type CanaryWorkerConfig } from "./canary-worker-peer.js";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export class RemoteCanaryWorker {
  readonly id = `hitch-canary-${randomBytes(16).toString("hex")}`;
  private prepared = false;
  constructor(readonly config: CanaryWorkerConfig, readonly localRoot: string, readonly localWorkerRoot: string) {}

  get workerRoot(): string { return path.posix.join(this.config.runs_directory, this.id, "worker"); }
  private sshOptions(): string[] {
    return ["-F", this.config.ssh_config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];
  }
  private launch(operation: string, details: Record<string, unknown> = {}, controllerPort?: number): ChildProcess {
    const forward = controllerPort === undefined ? [] : ["-R", `127.0.0.1:${this.config.remote_port}:127.0.0.1:${controllerPort}`];
    const command = [this.config.node, path.posix.join(this.config.hitch, "dist/scripts/canary-worker-peer.js")].map(shellQuote).join(" ");
    const child = spawn("ssh", [...this.sshOptions(), ...forward, this.config.ssh_host, command], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify({ operation, config: this.config, id: this.id, ...details }));
    return child;
  }
  private async request(operation: string, details: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const child = this.launch(operation, details);
    let stdout = "", stderr = "", oversized = false, timedOut = false;
    child.stdout!.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) { oversized = true; child.kill("SIGTERM"); }
    });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-32_768); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 60_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(timedOut, false, "SSH worker observation timed out; remote state remains unconfirmed");
      assert.equal(oversized, false, "SSH worker response exceeded the diagnostic bound");
      assert.equal(code, 0, `SSH canary ${operation} failed: ${stderr}`);
      return JSON.parse(stdout);
    } finally { clearTimeout(timer); }
  }

  async observe(imageId: string, localEngine: string): Promise<{ engine: string; harbor: string }> {
    await atomicWriteJSON(path.join(this.localRoot, "remote-worker-location.json"), {
      diagnosticId: this.id, sshHost: this.config.ssh_host, workerRoot: this.workerRoot,
    });
    const observed = await this.request("observe", { imageId });
    assert.equal(observed.imageId, imageId);
    assert.equal(observed.harbor, "0.21.0");
    assert.ok(typeof observed.engine === "string" && observed.engine.length > 0);
    assert.notEqual(observed.engine, localEngine, "cross-host canary requires a different Docker engine");
    assert.equal(typeof observed.bootId, "string");
    assert.match(String(observed.bootId), /^[a-f0-9-]{36}$/);
    assert.deepEqual(observed.runtime, await observeControllerRuntime(), "remote worker runtime differs from controller");
    await atomicWriteJSON(path.join(this.localRoot, "remote-worker-observation.json"), observed);
    return { engine: observed.engine, harbor: "0.21.0" };
  }

  async start(controllerPort: number, registrationFile: string, credentialFile: string): Promise<ChildProcess> {
    assert.ok(Number.isSafeInteger(controllerPort) && controllerPort > 0 && controllerPort <= 65535);
    this.prepared = true; // An uncertain prepare must still be followed by a remote stop.
    const prepared = await this.request("prepare", {
      registration: JSON.parse(await readFile(registrationFile, "utf8")),
      credential: JSON.parse(await readFile(credentialFile, "utf8")),
    });
    assert.equal(prepared.prepared, true, "remote worker did not confirm preparation");
    return this.launch("run", {}, controllerPort);
  }

  async stop(): Promise<void> {
    if (!this.prepared) return;
    const result = await this.request("stop");
    assert.equal(result.workerProcessTerminal, true);
    await atomicWriteJSON(path.join(this.localRoot, "remote-worker-process-stop.json"), result);
  }

  async collect(): Promise<void> {
    if (!this.prepared) return;
    await mkdir(this.localWorkerRoot, { recursive: true, mode: 0o700 });
    const sshCommand = ["ssh", ...this.sshOptions()].map(shellQuote).join(" ");
    // Copy only this canary's worker state. Registration credentials are in a
    // sibling private directory and never included. Do not follow symlinks.
    await runCommand("rsync", ["-r", "--safe-links", "--checksum", "--partial", "--timeout=60", "-e", sshCommand,
      `${this.config.ssh_host}:${shellQuote(`${this.workerRoot}/`)}`, `${this.localWorkerRoot}/`], { timeoutMs: 90_000 });
  }

  async cleanup(leaseIds: string[]): Promise<{ issues: unknown[]; retained: unknown[] }> {
    if (!this.prepared) return { issues: [], retained: [] };
    const result = await this.request("cleanup", { leaseIds });
    assert.equal(result.root_id, hitchRootId(this.workerRoot));
    assert.ok(Array.isArray(result.issues) && Array.isArray(result.retained));
    await atomicWriteJSON(path.join(this.localRoot, "remote-worker-docker-cleanup.json"), result);
    return { issues: result.issues, retained: result.retained };
  }
}

export async function remoteCanaryWorker(localRoot: string, localWorkerRoot: string): Promise<RemoteCanaryWorker | undefined> {
  const file = process.env.HITCH_CANARY_WORKER_SSH_CONFIG;
  return file ? new RemoteCanaryWorker(parseCanaryWorkerConfig(JSON.parse(await readFile(file, "utf8"))), localRoot, localWorkerRoot) : undefined;
}
