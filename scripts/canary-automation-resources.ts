import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { runCommand } from "../src/foundation/index.js";
import { configuredResourceStore, preflightResourceInput, materializeResourceTask, finishResourceWorkspace, sealResourceEvidence, resourceStorageStats } from "../src/resources/index.js";
import type { ExecutionEvidenceV1 } from "../src/domain/index.js";

// Explicit local canary: no model requests and no registry publication.
const [root, dataset, legacy, taskId] = process.argv.slice(2);
if (!root || !dataset || !legacy || !taskId) throw new Error("Usage: canary-automation-resources ROOT V2_DATASET V4_DATASET TASK_ID");
const output = await mkdtemp(path.join(os.tmpdir(), "hitch-automation-execution-"));
const tags: string[] = [], containers: string[] = [], observed: Array<{ image_config_digest: string }> = [];
const docker = (args: string[]) => runCommand(process.env.HITCH_DOCKER_PATH || "docker", args, { timeoutMs: 240_000 });
const { store, config } = await configuredResourceStore(root);
const preflight = (await preflightResourceInput(store, dataset, { owner: "automation-canary", generation: 1, platform: config.platform }))!;
const plan = preflight.plans.find(p => p.task.task_id === taskId)!;
const workspace = await materializeResourceTask(store, plan, { owner: `automation-canary:${taskId}`, generation: 1, policy: { mode: "copy" } });
async function build(directory: string, file = "Dockerfile") {
  const tag = `hitch-automation-resource-canary:${randomUUID()}`; tags.push(tag);
  await docker(["build", "--platform", config.platform, "--pull=false", "--quiet", "-t", tag, "-f", path.join(directory, file), directory]); return tag;
}
async function observe(name: string) {
  const image = (await docker(["inspect", "--format", "{{.Image}}", name])).stdout.trim(); observed.push({ image_config_digest: image });
}
try {
  const candidate = await build(path.join(workspace.taskDirectory, "environment/candidate"));
  const candidateName = `hitch-resource-candidate-${randomUUID()}`; containers.push(candidateName);
  await docker(["run", "--name", candidateName, "--network", "none", "--platform", config.platform, "--entrypoint", "python", candidate, "-c", 'from pathlib import Path; assert not Path("/data/task.json").exists(); assert not Path("/runtime/official.py").exists()']); await observe(candidateName);
  const scores = [], snapshots = [];
  for (const kind of ["resource", "legacy"] as const) {
    const verifier = await build(path.join(kind === "resource" ? workspace.taskDirectory : path.join(legacy, taskId), "tests"));
    const service = kind === "resource" ? await build(path.join(workspace.taskDirectory, "environment/services/simulator")) : verifier;
    const name = `hitch-resource-simulator-${randomUUID()}`, evidence = path.join(output, kind); containers.push(name); await mkdir(evidence);
    await docker(["run", "-d", "--name", name, "--network", "none", "--platform", config.platform, "-v", `${evidence}:/evidence`, "--entrypoint", "python", service, "/runtime/server.py"]);
    const call = 'import json,time,urllib.request\nfor i in range(90):\n try:\n  urllib.request.urlopen("http://127.0.0.1:8765/health"); break\n except Exception: time.sleep(1)\nelse: raise RuntimeError("simulator not ready")\ndata=json.dumps({"name":"api_search","arguments":{"query":"campaign performance spreadsheet","top_k":3}}).encode()\nr=json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8765/call",data=data,headers={"Content-Type":"application/json"})))\nassert "tool_error" not in r, r\nprint(json.dumps(r))';
    await docker(["exec", name, "python", "-c", call]); if (kind === "resource") await observe(name);
    const verifierName = `hitch-resource-verifier-${randomUUID()}`; containers.push(verifierName);
    await docker(["run", "--name", verifierName, "--network", "none", "--platform", config.platform, "-v", `${evidence}:/evidence:ro`, "--entrypoint", "python", verifier, "/runtime/official.py", "/data/task.json", "/evidence/snapshot.json", "/logs/verifier"]);
    await docker(["cp", `${verifierName}:/logs/verifier`, path.join(evidence, "result")]); if (kind === "resource") await observe(verifierName);
    scores.push({ kind, reward: JSON.parse(await readFile(path.join(evidence, "result/reward.json"), "utf8")), assertions: JSON.parse(await readFile(path.join(evidence, "result/assertions.json"), "utf8")), process: JSON.parse(await readFile(path.join(evidence, "result/process.json"), "utf8")) });
    snapshots.push(JSON.parse(await readFile(path.join(evidence, "snapshot.json"), "utf8")));
  }
  for (const key of ["reward", "assertions", "process"] as const) if (JSON.stringify(scores[0]![key]) !== JSON.stringify(scores[1]![key])) throw new Error(`v4/v5 ${key} mismatch`);
  // Upstream assigns random row IDs and current timestamps during setup.
  // Compare stable contract/tool observations, then cross-grade exactly the
  // same source snapshot through the other runtime, without normalizing it.
  if (snapshots[0].task_contract_sha256 !== snapshots[1].task_contract_sha256 || JSON.stringify(snapshots[0].audit) !== JSON.stringify(snapshots[1].audit)) throw new Error("v4/v5 simulator contract/tool results differ");
  const legacyVerifier = tags[tags.length - 1]!;
  const crossName = `hitch-resource-crossgrade-${randomUUID()}`; containers.push(crossName);
  await docker(["run", "--name", crossName, "--network", "none", "--platform", config.platform, "-v", `${path.join(output, "resource")}:/evidence:ro`, "--entrypoint", "python", legacyVerifier, "/runtime/official.py", "/data/task.json", "/evidence/snapshot.json", "/logs/verifier"]);
  await docker(["cp", `${crossName}:/logs/verifier`, path.join(output, "crossgrade")]);
  for (const [key, fileName] of [["reward", "reward"], ["assertions", "assertions"], ["process", "process"]] as const) if (JSON.stringify(scores[0]![key]) !== JSON.stringify(JSON.parse(await readFile(path.join(output, `crossgrade/${fileName}.json`), "utf8")))) throw new Error(`cross-grade ${key} mismatch`);
  const file = path.join(output, "workspace.json"); await writeFile(file, JSON.stringify({ ...workspace, executionEnded: true, preflightPlanDigest: preflight.planDigest }));
  await sealResourceEvidence({ store, file, runDirectory: output, owner: `canary-run:${path.basename(output)}`, taskId, requireObserved: true, execution: { observed: { containers: observed } } as ExecutionEvidenceV1 });
  await finishResourceWorkspace(store, workspace.id, { executionEnded: true, resultSealed: true });
  const result = { protocol: "automationbench-resource-canary@1", output, taskId, paidModelCalls: 0, planDigest: plan.digest, materializedDigest: workspace.materialized_task_digest, identicalToolResults: true, identicalCrossGrade: true, observedRoles: 3, scores, storage: await resourceStorageStats(store) };
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ output, identicalToolResults: true, identicalCrossGrade: true, scores: scores.map(({ kind, reward }) => ({ kind, reward })) }));
} finally {
  for (const name of containers) await docker(["rm", "-f", name]).catch(() => undefined);
  for (const tag of tags) await docker(["image", "rm", tag]).catch(() => undefined);
  console.error(`Canary artifacts: ${output}`);
}
