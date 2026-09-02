import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { locateHarbor } from "../src/backends/index.js";
import { EvalScheduler, ResourceLedger } from "../src/control-plane/index.js";
import type { ResourceVectorV1 } from "../src/domain/index.js";
import { parseEvalExecutionPlan, reapOwnedDockerResources } from "../src/evals/index.js";
import { defaultRoot, delay, hitchRootId, readJSON, runCommand, statePaths } from "../src/foundation/index.js";
import { verifyResultBundleIndex } from "../src/runs/index.js";

const exec = promisify(execFile);
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const docker = process.env.HITCH_DOCKER_PATH || "docker";
const base = process.env.HITCH_HARBOR_LOAD_CANARY_BASE || "mirror.gcr.io/library/node:22.23.0-bookworm-slim";
const supportBase = process.env.HITCH_HARBOR_LOAD_CANARY_SUPPORT_BASE || "alexgshaw/git-multibranch:20251031";
const expectedCpus = integerEnv("HITCH_LOAD_CANARY_EXPECT_CPUS", 10);
const expectedMemoryMib = integerEnv("HITCH_LOAD_CANARY_EXPECT_MEMORY_MIB", 8 * 1024);
const trials = integerEnv("HITCH_LOAD_CANARY_TRIALS", 20);
const timeoutMs = integerEnv("HITCH_HARBOR_LOAD_CANARY_TIMEOUT_MS", 15 * 60_000);
const keepState = process.env.HITCH_HARBOR_LOAD_CANARY_KEEP_STATE === "1";
const capacity: ResourceVectorV1 = { cpu_millis: 10_000, memory_bytes: 8 * GIB, container_slots: 8, build_slots: 1 };
const reservation: ResourceVectorV1 = { cpu_millis: 2_000, memory_bytes: 4 * GIB, container_slots: 1, build_slots: 0 };
const root = await mkdtemp(path.join(tmpdir(), "hitch-harbor-load-canary-"));
const dataset = path.join(root, "dataset");
const harnessSource = path.join(root, "pi-source");
const ledger = new ResourceLedger(capacity);
const activeWork = new Set<string>();
const builtReferences = new Set<string>();
let maximumAdmittedTrials = 0;
let maximumRunningContainers = 0;
let dockerPollIssue: string | undefined;
let scheduler: EvalScheduler | undefined;
let stopDockerMonitor = false;
const startedAt = Date.now();

try {
  if (trials < 3) throw new Error("Harbor load canary requires at least three trials for success, zero-reward, and invalid cases");
  const info = (await dockerCommand(["info", "--format", "{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}"])).stdout.trim().split(/\s+/);
  const hostCpus = Number(info[0]);
  const hostMemory = Number(info[1]);
  const serverVersion = info[2] || "unknown";
  if (hostCpus !== expectedCpus) throw new Error(`Harbor load canary requires ${expectedCpus} Docker CPUs, observed ${hostCpus}`);
  const expectedBytes = expectedMemoryMib * MIB;
  if (!Number.isSafeInteger(hostMemory) || hostMemory < expectedBytes - 512 * MIB || hostMemory > expectedBytes + 128 * MIB) {
    throw new Error(`Harbor load canary requires a nominal ${expectedMemoryMib} MiB Docker VM, observed ${Math.round(hostMemory / MIB)} MiB`);
  }
  const pinnedBase = await pinnedLocalImage(base);
  const pinnedSupportBase = await pinnedLocalImage(supportBase);
  const configuredHarbor = process.env.HITCH_HARBOR_LOAD_CANARY_PATH || process.env.HITCH_HARBOR_PATH;
  const harbor = await locateHarbor({ root: defaultRoot(), ...(configuredHarbor ? { explicit: configuredHarbor } : {}), env: process.env });
  if (!harbor.executable) throw new Error(`Harbor executable is unavailable: ${harbor.requested}`);

  const harnessRef = await writeLocalHarness(harnessSource);
  await writeDataset(dataset, pinnedBase, pinnedSupportBase, trials);
  scheduler = new EvalScheduler({
    root,
    resources: ledger,
    trialResources: reservation,
    executor: (options) => import("../src/evals/index.js").then(({ runEval }) => runEval({
      ...options,
      harborExecutable: harbor.executable as string,
      env: { ...process.env, HITCH_DOCKER_PATH: docker, npm_config_offline: "true" },
      trialBundleGraceMs: 5_000,
    })),
    onEvent: (event) => {
      const workId = typeof event.work_id === "string" ? event.work_id : undefined;
      if (event.type === "eval.work-item.admitted" && workId) {
        activeWork.add(workId);
        maximumAdmittedTrials = Math.max(maximumAdmittedTrials, activeWork.size);
      }
      if ((event.type === "eval.work-item.completed" || event.type === "eval.work-item.lease-released") && workId) activeWork.delete(workId);
    },
  });
  await scheduler.initialize();
  const evalId = await scheduler.submit({
    schema_version: "1",
    request: {
      dataset,
      harness_ref: harnessRef,
      attempts: 1,
      max_concurrent: 8,
      infrastructure_retries: 0,
      timeout_ms: 120_000,
      setup_timeout_ms: 120_000,
    },
    execution: {
      provider: "local-docker",
      max_parallelism: 8,
      resources: { default_trial: reservation },
      build: { mode: "prebuild-required" },
      model_capture: { mode: "native", required: false },
    },
  });
  const dockerMonitor = monitorDockerConcurrency(evalId);
  const status = await waitForTerminal(scheduler, evalId, timeoutMs);
  stopDockerMonitor = true;
  await dockerMonitor;
  if (dockerPollIssue) throw new Error(`Docker concurrency monitor failed: ${dockerPollIssue}`);
  if (!status.result) throw new Error("terminal Harbor eval has no result");

  const result = status.result as {
    status?: unknown;
    error?: unknown;
    trials?: Array<{ run_id: string; task_id: string; observation_status: string; reward?: number; invalid_reason?: string }>;
    summary?: { n_trials?: number; n_completed?: number; n_invalid?: number; primary_reward?: number | null; rewards?: { reward?: { count?: number } } };
  };
  const trialResults = Array.isArray(result.trials) ? result.trials : [];
  const valid = trialResults.filter((trial) => trial.observation_status === "valid");
  const invalid = trialResults.filter((trial) => trial.observation_status !== "valid");
  const zeroRewards = valid.filter((trial) => trial.reward === 0);
  const expectedValid = trials - 1;
  const expectedRewardSum = trials - 2;
  const rewardSum = valid.reduce((sum, trial) => sum + Number(trial.reward), 0);
  if (result.status !== "failed" || trialResults.length !== trials || valid.length !== expectedValid || invalid.length !== 1) {
    throw new Error(`unexpected Harbor result shape: ${JSON.stringify({ status: result.status, error: result.error, trials: trialResults.length, valid: valid.length, invalid: invalid.length })}`);
  }
  if (invalid[0]?.reward !== undefined || zeroRewards.length !== 1 || rewardSum !== expectedRewardSum) {
    throw new Error(`invalid/zero reward semantics changed: ${JSON.stringify({ invalid: invalid[0], zero_rewards: zeroRewards.length, reward_sum: rewardSum })}`);
  }
  const expectedMean = expectedRewardSum / expectedValid;
  if (result.summary?.n_trials !== trials || result.summary.n_completed !== expectedValid || result.summary.n_invalid !== 1
    || result.summary.rewards?.reward?.count !== expectedValid
    || typeof result.summary.primary_reward !== "number" || Math.abs(result.summary.primary_reward - expectedMean) > Number.EPSILON) {
    throw new Error(`invalid trial was aggregated as a zero reward: ${JSON.stringify(result.summary)}`);
  }
  if (maximumAdmittedTrials !== 2) throw new Error(`scheduler admitted ${maximumAdmittedTrials} trials concurrently instead of exactly 2`);
  if (maximumRunningContainers !== 2) throw new Error(`Docker ran ${maximumRunningContainers} trial containers concurrently instead of exactly 2`);
  if (Object.values(ledger.snapshot().allocated).some((value) => value !== 0)) throw new Error("Harbor load canary leaked a resource reservation");

  const evalDirectory = path.join(statePaths(root).evals, evalId);
  const plan = parseEvalExecutionPlan(await readJSON(path.join(evalDirectory, "execution-plan.json")));
  const imageUses = plan.work_items.flatMap((item) => item.image_refs ?? []);
  const imageIds = new Set(imageUses.map((use) => use.image_id));
  const misses = imageUses.filter((use) => use.cache_hit === false).length;
  const hits = imageUses.filter((use) => use.cache_hit === true).length;
  if (imageUses.length !== trials || imageIds.size !== 1 || misses !== 1 || hits !== trials - 1) {
    throw new Error(`environment build was not shared across all tasks: ${JSON.stringify({ uses: imageUses.length, image_ids: imageIds.size, misses, hits })}`);
  }
  const buildRecordDirectories = await directories(statePaths(root).buildRecords);
  if (buildRecordDirectories.length !== 1) throw new Error(`expected one environment build record, found ${buildRecordDirectories.length}`);
  const buildRecord = await readJSON<Record<string, unknown>>(path.join(statePaths(root).buildRecords, buildRecordDirectories[0] as string, "record.json"));
  if (buildRecord.state !== "succeeded") throw new Error(`environment build did not succeed: ${JSON.stringify(buildRecord)}`);
  for (const imageId of imageIds) {
    const manifest = await readJSON<{ output?: { reference?: string } }>(path.join(statePaths(root).environmentImages, imageId.slice("sha256:".length), "manifest.json"));
    if (manifest.output?.reference) builtReferences.add(manifest.output.reference);
  }

  let oomKilled = 0;
  for (const trial of trialResults) {
    if (trial.observation_status === "valid") await verifyResultBundleIndex(path.join(statePaths(root).runs, trial.run_id));
    const execution = await readJSON<{ observed?: { containers?: Array<{ oom_killed?: boolean }> }; enforced?: { main_limits?: ResourceVectorV1 } }>(
      path.join(statePaths(root).runs, trial.run_id, "execution.json"),
    );
    oomKilled += execution.observed?.containers?.filter((container) => container.oom_killed === true).length ?? 0;
    if (JSON.stringify(execution.enforced?.main_limits) !== JSON.stringify(reservation)) {
      throw new Error(`trial ${trial.run_id} did not retain the requested Docker hard limits`);
    }
  }
  if (oomKilled !== 0) throw new Error(`${oomKilled} Harbor trial containers were OOM-killed`);

  await assertNoOwnedResources(evalId);
  const cleanupLatencyMs = Date.now() - Date.parse(status.control.updated_at);
  if (!Number.isFinite(cleanupLatencyMs) || cleanupLatencyMs > 60_000) throw new Error("Harbor owned-resource cleanup exceeded 60 seconds from terminal state");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    harbor: harbor.version,
    docker: serverVersion,
    docker_cpus: hostCpus,
    docker_memory_bytes: hostMemory,
    requested_max_concurrent: 8,
    trial_reservation: reservation,
    trials,
    valid_trials: valid.length,
    invalid_trials: invalid.length,
    valid_zero_rewards: zeroRewards.length,
    aggregated_reward_count: result.summary?.rewards?.reward?.count,
    primary_reward: result.summary?.primary_reward,
    maximum_admitted_trials: maximumAdmittedTrials,
    maximum_running_containers: maximumRunningContainers,
    environment_builds: buildRecordDirectories.length,
    environment_cache_misses: misses,
    environment_cache_hits: hits,
    verified_valid_bundles: valid.length,
    oom_killed: oomKilled,
    cleanup_latency_ms: cleanupLatencyMs,
    cleanup_within_60_seconds: true,
    duration_ms: Date.now() - startedAt,
  }, null, 2)}\n`);
} finally {
  stopDockerMonitor = true;
  await scheduler?.shutdown().catch(() => {});
  await reapOwnedDockerResources({ root, env: { ...process.env, HITCH_DOCKER_PATH: docker } }).catch(() => {});
  if (keepState) process.stderr.write(`Harbor load canary state retained at ${root}\n`);
  else {
    for (const reference of builtReferences) await dockerCommand(["image", "rm", "--force", reference]).catch(() => {});
    await removeOwnedImages().catch(() => {});
    await forceRemove(root);
  }
}

async function writeDataset(directory: string, pinnedBase: string, pinnedSupportBase: string, count: number): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  for (let index = 0; index < count; index += 1) {
    const task = path.join(directory, `task-${String(index).padStart(2, "0")}`);
    await mkdir(path.join(task, "environment"), { recursive: true });
    await mkdir(path.join(task, "tests"), { recursive: true });
    await writeFile(path.join(task, "task.toml"), [
      'schema_version = "1.4"', "", "[metadata]", "", "[verifier]", "timeout_sec = 30.0", "", "[agent]", "timeout_sec = 120.0", "", "[environment]", "build_timeout_sec = 120.0", "",
    ].join("\n"));
    await writeFile(path.join(task, "instruction.md"), `Return a short acknowledgement for Harbor load canary ${nonce}.\n`);
    await writeFile(path.join(task, "environment", "Dockerfile"), [
      `FROM ${pinnedBase} AS node-runtime`,
      `FROM ${pinnedSupportBase}`,
      "COPY --from=node-runtime /usr/local/ /usr/local/",
      "WORKDIR /app",
      "RUN node --version > /hitch-node-version.txt && git --version > /hitch-git-version.txt",
      "",
    ].join("\n"));
    const verifier = index === count - 1
      ? "#!/bin/sh\nset -eu\nsleep 0.5\necho 'intentional missing reward' > /logs/verifier/canary.txt\n"
      : `#!/bin/sh\nset -eu\nsleep 0.5\necho ${index === count - 2 ? 0 : 1} > /logs/verifier/reward.txt\n`;
    await writeFile(path.join(task, "tests", "test.sh"), verifier, { mode: 0o755 });
    await chmod(path.join(task, "tests", "test.sh"), 0o755);
  }
}

async function writeLocalHarness(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "hitch-harbor-load-fake-pi", version: "1.0.0", private: true, scripts: { build: "node build.js" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "hitch-harbor-load-fake-pi", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "hitch-harbor-load-fake-pi", version: "1.0.0" } },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "build.js"), `
const fs = require("node:fs");
const path = require("node:path");
const output = path.join(process.cwd(), "packages", "coding-agent", "dist", "cli.js");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, ${JSON.stringify(fakePiSource())}, { mode: 0o755 });
`);
  await exec("git", ["init", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "hitch-canary@example.test"]);
  await exec("git", ["-C", directory, "config", "user.name", "Hitch Canary"]);
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-m", "fake pi harness"]);
  const { stdout } = await exec("git", ["-C", directory, "rev-parse", "HEAD"]);
  return `pi@git+${pathToFileURL(directory).href}#${stdout.trim()}`;
}

function fakePiSource(): string {
  return `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("pi 1.0.0\\n"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const usage = {input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  process.stdout.write(JSON.stringify({type:"session",version:3,id:"pi_canary_session",cwd:process.cwd()}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"ack"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ack:" + prompt}],usage,stopReason:"stop"}}) + "\\n");
});
`;
}

async function waitForTerminal(current: EvalScheduler, evalId: string, maximumMs: number): Promise<NonNullable<Awaited<ReturnType<EvalScheduler["status"]>>>> {
  const deadline = Date.now() + maximumMs;
  for (;;) {
    const status = await current.status(evalId);
    if (status && new Set(["succeeded", "failed", "cancelled"]).has(status.control.state)) return status;
    if (Date.now() >= deadline) throw new Error(`Harbor load canary timed out after ${maximumMs} ms`);
    await delay(250);
  }
}

async function monitorDockerConcurrency(evalId: string): Promise<void> {
  while (!stopDockerMonitor) {
    try {
      const running = (await dockerCommand(["container", "ls", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"], 5_000))
        .stdout.split(/\r?\n/).filter(Boolean).length;
      maximumRunningContainers = Math.max(maximumRunningContainers, running);
    } catch (error) {
      dockerPollIssue ??= (error as Error)?.message || String(error);
    }
    await delay(100);
  }
}

async function pinnedLocalImage(reference: string): Promise<string> {
  const value = JSON.parse((await dockerCommand(["image", "inspect", "--format", "{{json .}}", reference])).stdout) as {
    RepoDigests?: unknown;
    Os?: unknown;
    Architecture?: unknown;
  };
  if (value.Os !== "linux" || value.Architecture !== "amd64" || !Array.isArray(value.RepoDigests)) {
    throw new Error(`Harbor load canary base must be a local linux/amd64 image with a repo digest: ${reference}`);
  }
  const repository = imageRepository(reference);
  const digest = value.RepoDigests.find((entry): entry is string => typeof entry === "string" && entry.startsWith(`${repository}@sha256:`));
  if (!digest) throw new Error(`Harbor load canary base has no local digest for ${repository}`);
  return digest;
}

function imageRepository(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

async function assertNoOwnedResources(evalId: string): Promise<void> {
  const [containers, networks] = await Promise.all([
    dockerCommand(["container", "ls", "--all", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"]),
    dockerCommand(["network", "ls", "--filter", `label=io.hitch.eval-id=${evalId}`, "--format", "{{.ID}}"]),
  ]);
  if (containers.stdout.trim() || networks.stdout.trim()) throw new Error("Harbor load canary left owned containers or networks behind");
}

async function directories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function removeOwnedImages(): Promise<void> {
  const rootId = hitchRootId(root);
  const listed = await dockerCommand(["image", "ls", "--filter", `label=io.hitch.environment-image-root-id=${rootId}`, "--format", "{{.Repository}}:{{.Tag}}"]);
  for (const reference of listed.stdout.split(/\r?\n/).filter((entry) => entry && !entry.endsWith(":<none>"))) {
    await dockerCommand(["image", "rm", "--force", reference]).catch(() => {});
  }
}

async function dockerCommand(args: string[], commandTimeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return runCommand(docker, args, { env: process.env, timeoutMs: commandTimeoutMs, failureCode: "harbor_load_canary_failed" });
}

async function forceRemove(directory: string): Promise<void> {
  await chmodWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

async function chmodWritable(directory: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await chmodWritable(target);
    await chmod(target, entry.isDirectory() ? 0o700 : 0o600).catch(() => {});
  }
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}
