// Private diagnostic peer on a prepared Linux worker. No production capability
// is enabled by running this script. Requests arrive on stdin, never in argv.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeControllerRuntime } from "../src/controller-runtime/index.js";
import { reapOwnedDockerResources } from "../src/evals/index.js";
import { atomicWriteJSON, packageRoot, runCommand, sha256JSON, withFileLock } from "../src/foundation/index.js";

export interface CanaryWorkerConfig {
  ssh_host: string;
  ssh_config: string;
  runs_directory: string;
  node: string;
  hitch: string;
  python: string;
  docker: string;
  remote_port: number;
}

export function parseCanaryWorkerConfig(value: unknown): CanaryWorkerConfig {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const config = value as CanaryWorkerConfig;
  assert.deepEqual(Object.keys(config).sort(), ["ssh_host", "ssh_config", "runs_directory", "node", "hitch", "python", "docker", "remote_port"].sort());
  assert.match(config.ssh_host, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  for (const field of ["ssh_config", "runs_directory", "node", "hitch", "python", "docker"] as const) {
    assert.equal(typeof config[field], "string");
    assert.ok(path.posix.isAbsolute(config[field]) && !/[\0\r\n]/.test(config[field]));
    assert.equal(path.posix.normalize(config[field]), config[field]);
    assert.notEqual(config[field], "/");
  }
  assert.ok(Number.isSafeInteger(config.remote_port) && config.remote_port >= 1024 && config.remote_port <= 65535);
  return config;
}

interface Request {
  operation: "observe" | "prepare" | "run" | "stop" | "cleanup";
  config: CanaryWorkerConfig;
  id: string;
  imageId?: string;
  registration?: unknown;
  credential?: unknown;
  leaseIds?: string[];
}
interface Identity { pid: number; start: string; boot: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function identity(pid: number): Promise<Identity | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (["Z", "X"].includes(fields[0]!)) return null;
    assert.match(fields[19] ?? "", /^\d+$/);
    return { pid, start: fields[19]!, boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readOptional(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function peer(request: Request): Promise<unknown> {
  assert.equal(process.platform, "linux");
  const config = parseCanaryWorkerConfig(request.config);
  assert.equal(path.resolve(config.hitch), path.resolve(packageRoot()));
  assert.match(request.id, /^hitch-canary-[a-f0-9]{32}$/);
  const root = path.join(config.runs_directory, request.id);
  const workerRoot = path.join(root, "worker");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${path.dirname(config.node)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HITCH_HARBOR_PYTHON_PATH: config.python, HITCH_DOCKER_PATH: config.docker };
  delete env.HITCH_TEST_HOST_ARTIFACT_BUILDER;
  if (request.operation === "observe") {
    assert.match(request.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
    const info = JSON.parse((await runCommand(config.docker, ["image", "inspect", request.imageId!], { env, timeoutMs: 10_000 })).stdout)[0];
    assert.equal(info.Id, request.imageId); assert.equal(info.Os, "linux"); assert.equal(info.Architecture, "amd64");
    return { imageId: info.Id, engine: (await runCommand(config.docker, ["info", "--format", "{{.ID}}"], { env, timeoutMs: 10_000 })).stdout.trim(),
      harbor: (await runCommand(config.python, ["-c", 'import importlib.metadata; print(importlib.metadata.version("harbor"))'], { env, timeoutMs: 10_000 })).stdout.trim(),
      compose: (await runCommand(config.docker, ["compose", "version", "--short"], { env, timeoutMs: 10_000 })).stdout.trim(),
      buildx: (await runCommand(config.docker, ["buildx", "version"], { env, timeoutMs: 10_000 })).stdout.trim(),
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), runtime: await observeControllerRuntime() };
  }
  await mkdir(config.runs_directory, { recursive: true, mode: 0o700 });
  const locked = <T>(action: () => Promise<T>) => withFileLock(path.join(config.runs_directory, ".locks"), request.id, action);
  const ensureOwner = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const owner = await readOptional(path.join(root, "owner.json"));
    const expected = { id: request.id, configDigest: sha256JSON(config) };
    if (owner) assert.deepEqual(owner, expected, "canary worker owner changed");
    else await atomicWriteJSON(path.join(root, "owner.json"), expected);
  };
  const stop = () => locked(async () => {
    await ensureOwner();
    await atomicWriteJSON(path.join(root, "stop.json"), { stop: true });
    const previous = await readOptional(path.join(root, "process.json")) as Identity | undefined;
    if (!previous) return { workerProcessTerminal: true, neverStarted: true };
    assert.ok(Number.isSafeInteger(previous.pid) && previous.pid > 1);
    const current = await identity(previous.pid);
    if (!current) return { workerProcessTerminal: true, neverStarted: false };
    assert.deepEqual(current, previous, "canary process identity changed; refusing to signal");
    process.kill(-previous.pid, "SIGTERM");
    for (let i = 0; i < 50 && await identity(previous.pid); i++) await sleep(100);
    const after = await identity(previous.pid);
    if (after) {
      assert.deepEqual(after, previous, "canary process changed during stop");
      process.kill(-previous.pid, "SIGKILL");
      for (let i = 0; i < 20 && await identity(previous.pid); i++) await sleep(100);
    }
    assert.equal(await identity(previous.pid), null, "canary worker is still running");
    // Docker and execution-lease release are checked separately. This is only
    // a process observation and must not be used as proof of task cleanup.
    return { workerProcessTerminal: true, neverStarted: false };
  });
  if (request.operation === "stop") return stop();
  if (request.operation === "prepare") return locked(async () => {
    await ensureOwner();
    assert.equal(await readOptional(path.join(root, "stop.json")), undefined, "canary stop preceded prepare");
    assert.equal(await readOptional(path.join(root, "prepared.json")), undefined, "canary was already prepared");
    assert.ok(request.registration && request.credential);
    await mkdir(path.join(root, "private"), { mode: 0o700 });
    await writeFile(path.join(root, "private/registration.json"), JSON.stringify(request.registration), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(root, "private/credential.json"), JSON.stringify(request.credential), { flag: "wx", mode: 0o600 });
    await atomicWriteJSON(path.join(root, "prepared.json"), { prepared: true });
    return { prepared: true };
  });
  if (request.operation === "cleanup") {
    await locked(ensureOwner);
    assert.ok(Array.isArray(request.leaseIds));
    return reapOwnedDockerResources({ root: workerRoot, dockerExecutable: config.docker, env, leaseIds: request.leaseIds });
  }
  assert.equal(request.operation, "run");
  const child = await locked(async () => {
    await ensureOwner();
    assert.equal(await readOptional(path.join(root, "stop.json")), undefined, "canary stop preceded run");
    assert.equal(await readOptional(path.join(root, "process.json")), undefined, "canary cannot launch twice");
    await access(path.join(root, "prepared.json"));
    const child = spawn(config.node, [path.join(config.hitch, "dist/bin/hitch.js"), "--root", workerRoot, "worker", "run",
      "--server", `http://127.0.0.1:${config.remote_port}`, "--registration", path.join(root, "private/registration.json"),
      "--credential-file", path.join(root, "private/credential.json"), "--harbor", path.join(path.dirname(config.python), "harbor"),
      "--docker", config.docker, "--once", "--poll-interval", "100ms", "--heartbeat-interval", "1s"], { env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    try {
      const observed = await identity(child.pid!);
      assert.ok(observed, "canary worker exited before identity capture");
      await atomicWriteJSON(path.join(root, "process.json"), observed);
    } catch (error) {
      // This exact ChildProcess was just created by us. Do not leave it running
      // if identity persistence fails before the regular watchdog is armed.
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
        }
      }
      throw error;
    }
    return child;
  });
  const deadline = setTimeout(() => void stop().catch(() => { process.exitCode = 1; }), 8 * 60_000);
  const interrupted = () => { void stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted);
  const code = await new Promise<number | null>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", resolve);
  });
  clearTimeout(deadline); process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
  await atomicWriteJSON(path.join(root, "exit.json"), { code, signal: child.signalCode });
  assert.equal(code, 0, "canary worker failed");
  return { code };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
  console.log(JSON.stringify(await peer(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request)));
}
