import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HitchError, atomicWriteJSON, hitchRootId, readJSON, runCommand, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import type { SGLangAttachInput, SGLangLaunchInput } from "./sglang.js";
import { verifyLocalModel } from "./model-store.js";
import { modelNodeSnapshot } from "./model-location.js";
import { parseLocalModelManifest } from "./manifest.js";

export interface InferenceModelNodeIdentity { nodeId: string; generation: string }
export interface InferenceNodeConnection {
  transport: { type: "local" } | { type: "ssh"; host: string };
  python: string[];
  configPath: string;
  gateway: { localPort: number; nodePort: number };
}
export interface InferenceNodeOwner { serviceId: string; ownerId: string; inferenceId?: string }
export interface InferenceNodeClient {
  readonly node: InferenceModelNodeIdentity;
  prepare(input: SGLangLaunchInput): Promise<void>;
  start(input: SGLangLaunchInput): Promise<unknown>;
  inspect(owner: InferenceNodeOwner): Promise<unknown>;
  attach?(input: SGLangAttachInput): Promise<unknown>;
  stop(owner: InferenceNodeOwner): Promise<unknown>;
  route(root: string, nodePort: number): Promise<string>;
}
interface Envelope { schemaVersion: 2; requestId: string; node: InferenceModelNodeIdentity; operation: string; inputDigest: string; payload: unknown }
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Gear node protocol v2. Model bytes use separate bounded-header binary CAS. */
export class PythonInferenceNodeClient implements InferenceNodeClient {
  constructor(readonly connection: InferenceNodeConnection, readonly node: InferenceModelNodeIdentity, readonly env: NodeJS.ProcessEnv = process.env) {
    if (!connection.python.length || connection.python.some(arg => typeof arg !== "string" || !arg || arg.includes("\0"))
      || !path.posix.isAbsolute(connection.configPath) || !node.nodeId || !node.generation
      || [connection.gateway.localPort, connection.gateway.nodePort].some(port => !Number.isInteger(port) || port < 1 || port > 65535)
      || (connection.transport.type === "ssh" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(connection.transport.host))) {
      throw new TypeError("invalid explicit model-node connection");
    }
  }

  command(action: "rpc" | "cas-import"): string[] {
    const command = [...this.connection.python, "-m", "gear_training.node", action, "--config", this.connection.configPath];
    return this.connection.transport.type === "local" ? command
      : ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", this.connection.transport.host, command.map(quote).join(" ")];
  }

  private envelope(operation: string, payload: unknown): Envelope {
    return { schemaVersion: 2, requestId: randomUUID(), node: this.node, operation, inputDigest: sha256JSON(payload), payload };
  }

  private response(value: unknown, envelope: Envelope): unknown {
    const data = value as Partial<Envelope> & { result?: unknown } | null;
    if (!data || data.schemaVersion !== 2 || data.requestId !== envelope.requestId || data.inputDigest !== envelope.inputDigest
      || sha256JSON(data.node ?? null) !== sha256JSON(this.node) || !("result" in data)) {
      throw new HitchError("model-node reply identity or generation changed", { code: "inference_runtime_mismatch", exitCode: 12 });
    }
    return data.result;
  }

  private async exchange(action: "rpc" | "cas-import", envelope: Envelope, file?: string): Promise<unknown> {
    const command = this.command(action);
    const child = spawn(command[0]!, command.slice(1), { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume(); child.stdin.on("error", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), file ? 3_600_000 : 120_000);
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    void completed.catch(() => {});
    let output = ""; let length = 0;
    const read = async () => {
      for await (const chunk of child.stdout) {
        length += (chunk as Buffer).byteLength;
        if (length > 4 * 1024 * 1024) throw new TypeError("model-node response exceeds control protocol limit");
        output += chunk.toString();
      }
    };
    async function* input() { yield Buffer.from(JSON.stringify(envelope) + "\n"); if (file) yield* createReadStream(file); }
    try {
      const [, , code] = await Promise.all([pipeline(Readable.from(input()), child.stdin), read(), completed]);
      if (code !== 0) {
        let reason = "transport-failed";
        try { const parsed = JSON.parse(output); if (/^[a-z][a-z0-9_-]{0,100}$/.test(parsed.error?.code)) reason = parsed.error.code; } catch {}
        throw new HitchError(`model-node ${envelope.operation} failed (${reason}); resource ownership remains unresolved`, { code: "inference_route_unavailable", exitCode: 12 });
      }
      return this.response(JSON.parse(output), envelope);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
  }

  async call(operation: string, payload: unknown): Promise<unknown> { return this.exchange("rpc", this.envelope(operation, payload)); }
  private payload(input: SGLangLaunchInput) {
    return { serviceId: input.serviceId, ownerId: hitchRootId(input.root), model: input.model, runtime: input.runtime, lock: input.lock };
  }
  async prepare(input: SGLangLaunchInput): Promise<void> {
    const snapshotRef = input.lock.model_node ? await modelNodeSnapshot(input.root, input.model, input.lock.model_node) : null;
    if (snapshotRef) {
      const observed = parseLocalModelManifest(await this.call("cas.hfManifest", { snapshotRef }));
      if (observed.model_id !== input.model.model_id) throw new TypeError("model-node content differs from its registered model");
      await this.call("inference.prepare", this.payload(input));
      return;
    }
    await verifyLocalModel(input.root, input.model);
    for (const file of input.model.files) {
      const state = await this.call("cas.stat", { digest: file.sha256 }) as { present: boolean; size?: number };
      if (state.present && state.size === file.size) continue;
      if (state.present) throw new TypeError("model-node object size differs from the model manifest");
      const result = await this.exchange("cas-import", this.envelope("cas.import", { digest: file.sha256, size: file.size }),
        path.join(statePaths(input.root).modelFiles, file.sha256.slice(7))) as { present: boolean; size: number };
      if (!result.present || result.size !== file.size) throw new TypeError("node did not acknowledge durable model import");
    }
    await this.call("inference.prepare", this.payload(input));
  }
  start(input: SGLangLaunchInput): Promise<unknown> { return this.call("inference.start", this.payload(input)); }
  inspect(owner: InferenceNodeOwner): Promise<unknown> { return this.call("inference.inspect", owner); }
  attach(input: SGLangAttachInput): Promise<unknown> {
    const original = { serviceId: input.record.service_id, ownerId: hitchRootId(input.root), model: input.model, runtime: input.runtime, lock: input.lock };
    return this.call("inference.attach", { serviceId: original.serviceId, ownerId: original.ownerId,
      inferenceId: input.lock.inference_id, inputDigest: sha256JSON(original), expectedHandle: input.record.service_handle });
  }
  stop(owner: InferenceNodeOwner): Promise<unknown> { return this.call("inference.stop", owner); }

  async route(root: string, nodePort: number): Promise<string> {
    const { gateway, transport } = this.connection;
    if (nodePort !== gateway.nodePort || (transport.type === "local" && gateway.localPort !== gateway.nodePort)) {
      throw new TypeError("model-node service port differs from its configured route");
    }
    if (transport.type === "ssh") {
      const directory = statePaths(root).inferenceOperationLocks;
      const identity = sha256JSON({ node: this.node, connection: this.connection });
      // Short absolute socket paths fit the Unix-domain limit on macOS/Linux.
      const socketDirectory = path.join("/tmp", `hitch-node-${process.getuid?.() ?? "user"}-${hitchRootId(root).slice(-12)}`);
      await mkdir(socketDirectory, { mode: 0o700, recursive: true });
      const permissions = await lstat(socketDirectory);
      if (!permissions.isDirectory() || permissions.isSymbolicLink() || (permissions.mode & 0o077) !== 0
        || (process.getuid && permissions.uid !== process.getuid())) throw new TypeError("model-node SSH socket directory is not private");
      const socket = path.join(socketDirectory, `${identity.slice(-20)}.sock`);
      const recordPath = path.join(directory, identity.slice(7) + ".tunnel.json");
      await withFileLock(directory, identity.slice(7), async () => {
        let prior: { identity?: unknown } | undefined;
        try { prior = await readJSON(recordPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (prior && prior.identity !== identity) throw new TypeError("model-node tunnel ownership changed");
        const invoke = (args: string[]) => runCommand("ssh", args, { env: this.env, timeoutMs: 30_000, failureCode: "inference_route_unavailable", failureExitCode: 12 });
        const common = ["-S", socket, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
        if (prior) { try { await invoke([...common, "-O", "check", "--", transport.host]); return; } catch {} }
        await atomicWriteJSON(recordPath, { identity, node: this.node, connection: this.connection });
        await invoke([...common, "-M", "-fNT", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
          "-L", `127.0.0.1:${gateway.localPort}:127.0.0.1:${gateway.nodePort}`, "--", transport.host]);
      });
    }
    return `http://127.0.0.1:${gateway.localPort}`;
  }
}
