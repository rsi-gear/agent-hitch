import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/foundation/index.js";
import { configuredResourceStore, finishResourceWorkspace, importResourceBundle, materializeResourceTask, preflightResourceTask, resourceRequest, resourceStorageStats, sealResourceEvidence } from "../src/resources/index.js";

import { ResourceSpaceSampler } from "./resource-space-sampler.js";

// Isolated Docker-in-Docker test. Requires preloaded docker:27-dind and registry:2
// infrastructure images; no host Docker socket or user directories are mounted.
const [bundle] = process.argv.slice(2);
if (!bundle) throw new Error("Usage: canary-resource-empty-daemon SHARED_TREE_CANARY_BUNDLE");
const index = JSON.parse(await readFile(path.join(bundle, "index.json"), "utf8"));
if (index.delivery?.selection?.manifest?.benchmark?.id !== "shared-tree-sums" || index.delivery.selection.tasks.length !== 1
  || index.delivery.selection.tasks[0].task_id !== "sum-0002") throw new Error("expected the shared-tree sum-0002 canary bundle");
const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-empty-daemon-")), root = path.join(directory, "host");
const outer = `hitch-empty-daemon-${randomUUID()}`, hostDocker = process.env.HITCH_HOST_DOCKER_PATH || "docker";
const port = Number(process.env.HITCH_RESOURCE_CANARY_REGISTRY_PORT ?? 52990);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid canary port");
const dind = process.env.HITCH_RESOURCE_DIND_IMAGE || "mirror.gcr.io/library/docker:27-dind";
const host = (args: string[], timeoutMs = 240_000) => runCommand(hostDocker, args, { timeoutMs });
const inner = (args: string[], timeoutMs = 240_000) => host(["exec", outer, "docker", ...args], timeoutMs);
const dataset = path.join(path.dirname(bundle), "dataset");
const selections = path.join(directory, "selections"), evidenceDirectory = path.join(directory, "retained-evidence");
let accountingRetries = 0;
async function dockerAllocated() {
  for (let attempt = 0; ; attempt++) {
    try { return Number((await host(["exec",outer,"du","-sk","/var/lib/docker"])).stdout.split(/\s+/)[0]) * 1024; }
    catch (error) {
      // BuildKit removes owned temporary layers concurrently with the read-only
      // walk. Retry that snapshot, never interpret a failed walk as zero bytes.
      if (attempt >= 4 || !String(error).includes("No such file or directory") || !String(error).includes("du: /var/lib/docker/")) throw error;
      accountingRetries++;
    }
  }
}
const sampler = new ResourceSpaceSampler([
  { directory: dataset, classify: () => "source-dataset-descriptors" },
  { directory: selections, classify: () => "gear-selection-projections" },
  { directory: bundle, classify: () => "offline-bundle-input" },
  { directory: evidenceDirectory, classify: () => "retained-run-evidence" },
  { directory: root, classify: relative => {
    const prefix = "store/benchmark-resources/";
    if (!relative.startsWith(prefix)) return "host-configuration-and-records";
    const scope = relative.slice(prefix.length).split(path.sep)[0]!;
    return ({ objects: "file-CAS", "descriptor-views": "directory-views-and-unpack-cache", workspaces: "active-private-workspaces", staging: "temporary-import-staging" } as Record<string,string>)[scope] ?? "resource-references-and-quarantine";
  } },
], dockerAllocated);
const previousDocker = process.env.HITCH_DOCKER_PATH;
const result: Record<string, unknown> = { protocol: "hitch-empty-daemon-canary@1", directory, paidModelCalls: 0, samples: [] };
async function sample(phase: string) {
  const accounting = (await inner(["system", "df", "--format", "{{json .}}"])).stdout.trim();
  const daemonAllocatedKiB = Number((await host(["exec", outer, "du", "-sk", "/var/lib/docker"])).stdout.split(/\s+/)[0]);
  (result.samples as unknown[]).push({ phase, daemonAllocatedKiB, dockerAccounting: accounting });
}
async function pipeCommands(source: [string, string[]], destination: [string, string[]]) {
  const pack = spawn(...source, { stdio: ["ignore", "pipe", "pipe"] });
  const builder = spawn(...destination, { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = ""; for (const stream of [pack.stderr, builder.stderr, builder.stdout]) stream.on("data", c => { diagnostics = (diagnostics + c).slice(-8192); });
  pack.stdout.pipe(builder.stdin); builder.stdin.on("error", () => pack.kill());
  const timer = setTimeout(() => { pack.kill("SIGKILL"); builder.kill("SIGKILL"); }, 240_000);
  const wait = (child: ChildProcess) => new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`canary build failed: ${diagnostics}`))); });
  const pending = [wait(pack), wait(builder)];
  try { await Promise.all(pending); }
  catch (error) { pack.kill("SIGKILL"); builder.kill("SIGKILL"); await Promise.allSettled(pending); throw error; }
  finally { clearTimeout(timer); }
}
async function build(context: string, tag: string, platform: string) {
  await pipeCommands(["tar", ["-C", context, "-cf", "-", "."]], [hostDocker, ["exec", "-i", outer, "docker", "build", "--network=none", "--platform", platform, "--pull=false", "--quiet", "-t", tag, "-"]]);
}
try {
  result.infrastructureImage = (await host(["image", "inspect", dind, "--format", "{{.Id}}"])).stdout.trim();
  await host(["run", "-d", "--privileged", "--name", outer, "-e", "DOCKER_TLS_CERTDIR=", "-p", `127.0.0.1:${port}:${port}`, dind,
    "dockerd", "--host=unix:///var/run/docker.sock", "--storage-driver=vfs"]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await inner(["info", "--format", "{{.ID}}"], 3000); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error("isolated Docker daemon did not become ready");
  const initial = (await inner(["image", "ls", "-aq"])).stdout.trim(); if (initial) throw new Error("new daemon unexpectedly contains images");
  result.emptyInitialDockerStore = true; await sample("empty-daemon");
  await pipeCommands([hostDocker, ["image", "save", "registry:2"]], [hostDocker, ["exec", "-i", outer, "docker", "image", "load"]]);
  await inner(["run", "-d", "--name", "offline-registry", "--network", "host", "-e", `REGISTRY_HTTP_ADDR=0.0.0.0:${port}`, "registry:2"]);
  let registryReady = false;
  for (let i = 0; i < 30; i++) {
    try { const response = await fetch(`http://localhost:${port}/v2/`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.ok) { registryReady = true; break; } }
    catch { /* Startup is bounded and the actual bundle import remains strict. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!registryReady) throw new Error("isolated registry did not become ready");
  await sample("registry-infrastructure-only");
  await sampler.mark("baseline-with-infrastructure-and-bundle"); sampler.start();
  await mkdir(selections); await writeFile(path.join(selections,"sum-0002.json"), JSON.stringify(index.delivery.selection));
  await sampler.mark("selection-published");
  const wrapper = path.join(directory, "isolated-docker.cjs");
  await writeFile(wrapper, `#!${process.execPath}\nconst child=require('node:child_process').spawn(${JSON.stringify(hostDocker)},['exec',${JSON.stringify(outer)},'docker',...process.argv.slice(2)],{stdio:'inherit'}); child.on('error',e=>{console.error(e);process.exit(1)}); child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 });
  process.env.HITCH_DOCKER_PATH = wrapper;
  const transport = Object.fromEntries(index.delivery.images.map((image: { resource: { manifestDigest: string } }, i: number) => [image.resource.manifestDigest, `localhost:${port}/canary/image-${i}@${image.resource.manifestDigest}`]));
  const platform = index.delivery.selection.manifest.execution.platform;
  await resourceRequest(root, "configure", { protocol: "hitch-resource-host@1", transport, imagePolicy: "cache-only", platform, workspace: { mode: "copy" }, offline: { registry: `http://localhost:${port}` } });
  const { store } = await configuredResourceStore(root);
  await sampler.mark("importing");
  const imported = await importResourceBundle(store, bundle, "empty-daemon");
  await sampler.mark("imported");
  const repeated = await importResourceBundle(store, bundle, "empty-daemon");
  if (repeated.transferredBytes !== 0) throw new Error("repeat import transferred existing objects");
  await sample("imported"); await sampler.mark("repeat-imported");
  await inner(["stop", "offline-registry"]); await host(["network", "disconnect", "bridge", outer]);
  const { plan } = await preflightResourceTask(store, imported.selection.tasks[0]!, { owner: "offline-execution", generation: 1, platform });
  const workspace = await materializeResourceTask(store, plan, { owner: "offline-execution", generation: 1, policy: { mode: "copy" } });
  await sampler.mark("active-workspace-and-builds");
  await build(path.join(workspace.taskDirectory, "environment/candidate"), "canary-candidate:fixed", platform);
  await build(path.join(workspace.taskDirectory, "tests"), "canary-verifier:fixed", platform);
  const answer = JSON.parse((await inner(["run", "--rm", "--network", "none", "--platform", platform, "--entrypoint", "python", "canary-candidate:fixed", "-c", 'import json,pathlib; assert not pathlib.Path("/tests/expected.json").exists(); print(json.dumps(sum(json.loads(pathlib.Path("/data/values.json").read_text())[:2])))'])).stdout);
  if (answer !== 3) throw new Error("isolated candidate answer differs");
  const score = JSON.parse((await inner(["run", "--rm", "--network", "none", "--platform", platform, "--entrypoint", "sh", "canary-verifier:fixed", "-c", 'mkdir -p /evidence; printf 3 > /evidence/answer.json; python /tests/verify.py /evidence/answer.json && cat /logs/verifier/reward.json'])).stdout);
  if (score.reward !== 1) throw new Error("isolated verifier score differs");
  await sample("offline-executed");
  await mkdir(evidenceDirectory);
  const workspaceEvidence = path.join(evidenceDirectory,"workspace.json");
  await writeFile(workspaceEvidence,JSON.stringify({ ...workspace, executionEnded: true, preflightPlanDigest: plan.digest }));
  await sealResourceEvidence({ store, file: workspaceEvidence, runDirectory: evidenceDirectory, owner: "joint-space-canary-sealed-run", taskId: plan.task.task_id, requireObserved: false });
  await writeFile(path.join(evidenceDirectory,"score.json"),JSON.stringify({answer,score}));
  await sampler.mark("executed-and-evidence-sealed");
  Object.assign(result, { emptyInitialFileCAS: true, emptyTargetRegistry: true, sharedHostDockerLayers: false, externalNetworkDisconnected: true,
    registryStoppedDuringExecution: true, answer, score, transferredBytes: imported.transferredBytes, repeatTransferredBytes: repeated.transferredBytes,
    materializedTaskDigest: workspace.materialized_task_digest, storage: await resourceStorageStats(store) });
  await finishResourceWorkspace(store, workspace.id, { executionEnded: true, resultSealed: true });
  await sampler.mark("workspace-reclaimed-evidence-retained"); await sampler.stop();
  result.jointSpace = { ...sampler.report(), accountingRetries };
  result.materialization = { copiedBytes: workspace.copiedBytes, clonedBytes: workspace.clonedBytes, fallbackReasons: workspace.fallbackReasons };
  result.finalStorage = await resourceStorageStats(store);
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, emptyInitialDockerStore: true, externalNetworkDisconnected: true, answer, score }));
} catch (error) {
  await writeFile(path.join(directory, "failure.json"), JSON.stringify({ ...result, error: String(error) }, null, 2)); throw error;
} finally {
  await sampler.stop().catch(error => console.error(`Space sampling failed: ${String(error)}`));
  if (previousDocker === undefined) delete process.env.HITCH_DOCKER_PATH; else process.env.HITCH_DOCKER_PATH = previousDocker;
  await host(["rm", "-f", "-v", outer]).catch(() => undefined);
  console.error(`Canary artifacts: ${directory}`);
}
