import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "../src/foundation/index.js";
import { configuredResourceStore, exportResourceBundle, finishResourceWorkspace, importResourceBundle, materializeResourceTask, preflightResourceInput, readResourceInput, resourceRequest, resourceStorageStats, selectResources } from "../src/resources/index.js";
import { exportResourceLegacy } from "../src/evals/index.js";

// Real Docker canary, deliberately separate from unit tests and model evaluation.
const base = process.env.HITCH_RESOURCE_CANARY_IMAGE ?? "mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907";
const platform = process.env.HITCH_RESOURCE_CANARY_PLATFORM ?? "linux/amd64";
const directory = await mkdtemp(path.join(os.tmpdir(), "hitch-real-resources-")), root = path.join(directory, "host"), tags: string[] = [];
const registryName = `hitch-resource-registry-${randomUUID()}`, offlineRefs: string[] = [];
const registryPort = Number(process.env.HITCH_RESOURCE_CANARY_REGISTRY_PORT ?? 52989);
if (!Number.isSafeInteger(registryPort) || registryPort < 1024 || registryPort > 65535) throw new Error("invalid canary registry port");
const run = (args: string[]) => runCommand(process.env.HITCH_DOCKER_PATH || "docker", args, { timeoutMs: 240_000 });
const body = { protocol: "hitch-resource-host@1", transport: { [base.split("@")[1]!]: base }, imagePolicy: "cache-first", platform, workspace: { mode: "copy" }, offline: { exportFormat: "registry-bundle" }, limits: { minFreeBytes: 64 * 1024 ** 2, maxObjectBytes: 2 * 1024 ** 3 } };
const results: Record<string, unknown> = { protocol: "hitch-resource-canary@1", directory, base, platform, paidModelCalls: 0 };
try {
  await resourceRequest(root, "configure", body);
  const source = path.join(directory, "source"), dataset = path.join(directory, "dataset"); await mkdir(source); await writeFile(path.join(source, "values.json"), "[1,2,3,4,5]\n");
  await runCommand(process.execPath, ["benchmark-packages/shared-tree/import.mjs", "--source", source, "--root", root, "--out", dataset, "--base-image", base, "--tasks", "3", "--platform", platform], { timeoutMs: 120_000 });
  const { store } = await configuredResourceStore(root), checked = (await preflightResourceInput(store, dataset, { owner: "canary", generation: 1, platform }))!;
  const workspace = await materializeResourceTask(store, checked.plans[1]!, { owner: "canary:sum-0002", generation: 1, policy: { mode: "copy" } });
  const projected = await materializeResourceTask(store, checked.plans[1]!, { owner: "canary:sum-0002", generation: 1, policy: { mode: "auto" } });
  if (workspace.materialized_task_digest !== projected.materialized_task_digest) throw new Error("copy/auto semantic digest mismatch");
  const legacy = path.join(directory, "legacy"); await exportResourceLegacy(root, dataset, legacy);
  const answers = [];
  for (const [kind, task] of [["resource", workspace.taskDirectory], ["legacy", path.join(legacy, "sum-0002")]] as const) {
    const candidate = `hitch-resource-canary:${randomUUID()}`, verifier = `hitch-resource-canary:${randomUUID()}`; tags.push(candidate, verifier);
    await run(["build", "--platform", platform, "--pull=false", "--quiet", "-t", candidate, path.join(task, "environment/candidate")]);
    await run(["build", "--platform", platform, "--pull=false", "--quiet", "-t", verifier, path.join(task, "tests")]);
    const result = JSON.parse((await run(["run", "--rm", "--platform", platform, "--network", "none", "--entrypoint", "python", candidate, "-c", 'import json,pathlib; assert not pathlib.Path("/tests/expected.json").exists(); print(json.dumps(sum(json.loads(pathlib.Path("/data/values.json").read_text())[:2])))'])).stdout);
    const evidence = path.join(directory, `${kind}-evidence`); await mkdir(evidence); await writeFile(path.join(evidence, "answer.json"), JSON.stringify(result));
    const score = JSON.parse((await run(["run", "--rm", "--platform", platform, "--network", "none", "--tmpfs", "/logs/verifier", "-v", `${evidence}:/evidence:ro`, "--entrypoint", "sh", verifier, "-c", "python /tests/verify.py /evidence/answer.json && cat /logs/verifier/reward.json"])).stdout);
    if (result !== 3 || score.reward !== 1) throw new Error("terminal producer scoring mismatch"); answers.push({ kind, answer: result, score });
  }
  const manifest = await readResourceInput(dataset); if (!manifest || !("schema_version" in manifest)) throw new Error("missing dataset");
  const bundle = path.join(directory, "offline-bundle"); await exportResourceBundle(store, selectResources(manifest, ["sum-0002"]), bundle, "bundle");
  await run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]);
  const port = (await run(["port", registryName, "5000/tcp"])).stdout.trim().split("\n")[0]!.split(":").at(-1)!;
  const offlineRef = `localhost:${port}/canary@${base.split('@')[1]}`; offlineRefs.push(offlineRef);
  const offlineRoot = path.join(directory, "offline"); await resourceRequest(offlineRoot, "configure", { ...body, imagePolicy: "cache-only", transport: { [base.split('@')[1]!]: offlineRef }, offline: { registry: `http://localhost:${port}` } });
  const offlineStore = (await configuredResourceStore(offlineRoot)).store, imported = await importResourceBundle(offlineStore, bundle, "offline");
  const repeatTransferredBytes = (await importResourceBundle(offlineStore, bundle, "offline")).transferredBytes;
  await run(["stop", registryName]);
  const offlinePlan = (await import("../src/resources/tasks.js")).preflightResourceTask;
  const verifiedOffline = await offlinePlan(offlineStore, imported.selection.tasks[0]!, { owner: "offline:execute", generation: 1, platform });
  const offlineWorkspace = await materializeResourceTask(offlineStore, verifiedOffline.plan, { owner: "offline:execute", generation: 1, policy: { mode: "copy" } });
  const offlineCandidate = `hitch-resource-canary:${randomUUID()}`; tags.push(offlineCandidate);
  await run(["build", "--platform", platform, "--pull=false", "--quiet", "-t", offlineCandidate, path.join(offlineWorkspace.taskDirectory, "environment/candidate")]);
  const offlineAnswer = JSON.parse((await run(["run", "--rm", "--platform", platform, "--network", "none", "--entrypoint", "python", offlineCandidate, "-c", 'import json,pathlib; print(json.dumps(sum(json.loads(pathlib.Path("/data/values.json").read_text())[:2])))'])).stdout);
  if (offlineAnswer !== 3) throw new Error("offline execution mismatch");
  await finishResourceWorkspace(offlineStore, offlineWorkspace.id, { executionEnded: true, resultSealed: true });
  results.terminal = answers; results.offline = { emptyFileStore: true, emptyTargetRegistry: true, sharedDockerLayers: true, registryStoppedDuringExecution: true, answer: offlineAnswer, tasks: imported.selection.tasks.length, transferredBytes: imported.transferredBytes, repeatTransferredBytes };
  results.materialization = { digest: workspace.materialized_task_digest, copyBytes: workspace.copiedBytes, autoCloneBytes: projected.clonedBytes, autoCopyBytes: projected.copiedBytes, fallbackReasons: projected.fallbackReasons };
  await finishResourceWorkspace(store, workspace.id, { executionEnded: true, resultSealed: true }); await finishResourceWorkspace(store, projected.id, { executionEnded: true, resultSealed: true });
  results.storage = await resourceStorageStats(store);
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(results, null, 2)}\n`); process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  // Only names created by this canary are removed; no existing image/cache prune.
  for (const tag of tags) await run(["image", "rm", tag]).catch(() => undefined);
  for (const reference of offlineRefs) await run(["image", "rm", reference]).catch(() => undefined);
  await run(["rm", "-f", "-v", registryName]).catch(() => undefined);
  process.stderr.write(`Canary artifacts: ${directory}\n`);
}
