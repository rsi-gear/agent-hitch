import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildEvalExecutionPlan, captureRemoteVerifierSource, createExecutionLease, portableRemoteTrial, reapOwnedDockerResources, runRemoteVerifierWork, validateEvalId } from "../src/evals/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { atomicWriteJSON, readJSON, runCommand, sha256JSON } from "../src/foundation/index.js";
import { writeResultBundleIndex } from "../src/runs/index.js";

// Real Harbor/Docker CPU canary. Requires a locally available image with bash; never pulls or provisions GPUs.
const python = process.env.HITCH_HARBOR_TEST_PYTHON, image = process.env.HITCH_VERIFIER_IMAGE;
if (!python || !image) throw Error("Set HITCH_HARBOR_TEST_PYTHON and HITCH_VERIFIER_IMAGE to the Harbor 0.21.0 Python and a local bash-capable Docker image");
const inspected = await runCommand("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { timeoutMs: 10_000 });
const imageId = inspected.stdout.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw Error("A local immutable Docker image ID is required");
const root = await mkdtemp(path.join(tmpdir(), "hitch-real-verifier-"));
const evalId = validateEvalId(`eval_${"b".repeat(32)}`), runId = `run_${"a".repeat(32)}`;
const evalDirectory = path.join(root, "evals", evalId), taskDirectory = path.join(root, "one"), trialDirectory = path.join(root, "original");
const reservation = { cpu_millis: 1000, memory_bytes: 512 * 1024 ** 2, container_slots: 1, build_slots: 0 };
const lease = await createExecutionLease({ evalId, evalDirectory, workId: `work_${"c".repeat(32)}`,
  worker: { workerId: "verifier-canary", provider: "remote-docker", collisionDomainId: "verifier-canary-docker" }, reservation, ttlMs: 45_000 });
const controller = new AbortController();
const heartbeat = setInterval(() => { void lease.heartbeat().catch(error => controller.abort(error)); }, 10_000);
heartbeat.unref();
let cleanupProven = false, passed = false;
let summary: Record<string, unknown> = {};
try {
  const runtime = await ensureControllerRuntime({ root });
  await mkdir(path.join(taskDirectory, "tests"), { recursive: true }); await mkdir(path.join(taskDirectory, "environment"));
  await writeFile(path.join(taskDirectory, "instruction.md"), "The candidate has already produced candidate.txt. Regrade its recorded output.\n");
  await writeFile(path.join(taskDirectory, "environment/Dockerfile"), `FROM ${imageId}\n`);
  await writeFile(path.join(taskDirectory, "task.toml"), `schema_version="1.4"
[agent]
timeout_sec=10
[environment]
docker_image="${imageId}"
cpus=1
memory_mb=512
[verifier]
timeout_sec=30
environment_mode="separate"
[verifier.environment]
docker_image="${imageId}"
cpus=1
memory_mb=512
`);
  await writeFile(path.join(taskDirectory, "tests/test.sh"), '#!/bin/bash\nset -eu\ntest "$(cat /logs/artifacts/candidate.txt)" = "recorded candidate"\nmkdir -p /logs/verifier\nprintf "1" > /logs/verifier/reward.txt\n');
  await mkdir(path.join(trialDirectory, "artifacts/logs/artifacts"), { recursive: true });
  await writeFile(path.join(trialDirectory, "artifacts/logs/artifacts/candidate.txt"), "recorded candidate");
  await atomicWriteJSON(path.join(trialDirectory, "artifacts/manifest.json"), [{ source: "/logs/artifacts", destination: "artifacts/logs/artifacts", type: "directory", status: "ok", service: null }]);
  await atomicWriteJSON(path.join(trialDirectory, "benchmark-lifecycle.json"), { schema_version: "1", failure: null, phases: {} });
  await atomicWriteJSON(path.join(trialDirectory, "config.json"), { task: { path: taskDirectory }, trial_name: "one__original", trials_dir: root,
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", kwargs: { private_canary_marker: "never-transfer-agent-config" } },
    environment: { type: "docker", import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment", delete: false,
      cpu_enforcement_policy: "limit", memory_enforcement_policy: "limit", override_cpus: 1, override_memory_mb: 512 },
    verifier: { import_path: "hitch_harbor_verifier:HitchRetryingVerifier", override_timeout_sec: 30,
      kwargs: { infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0 } } });
  await runCommand(python, ["-c", `import json,sys
from pathlib import Path
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult
from harbor.models.task.task import Task
p=Path(sys.argv[1]); c=TrialConfig.model_validate_json((p/'config.json').read_text()); t=Task(task_dir=c.task.path)
(p/'config.json').write_text(c.model_dump_json())
r=TrialResult(task_name=t.name,trial_name=c.trial_name,trial_uri=p.as_uri(),task_id={'path':c.task.path},task_checksum=t.checksum,config=c,
 agent_info={'name':'HitchHarborAgent','version':'canary'},agent_result={'metadata':{'hitch_run_id':sys.argv[2],'controller_runtime_id':sys.argv[3]}})
(p/'result.json').write_text(r.model_dump_json())
`, trialDirectory, runId, runtime.runtime_id], { timeoutMs: 10_000 });
  const trial = await readJSON<Record<string, unknown>>(path.join(trialDirectory, "result.json"));
  const candidateResult = { run_id: runId, status: "succeeded", output: "recorded candidate" }, bundleDirectory = path.join(root, "bundle");
  await atomicWriteJSON(path.join(bundleDirectory, "manifest.json"), { schema_version: "1", run_id: runId, sealed: true });
  await atomicWriteJSON(path.join(bundleDirectory, "result.json"), candidateResult); await writeResultBundleIndex(bundleDirectory);
  const capture = await captureRemoteVerifierSource({ taskId: "one", runId, runtimeId: runtime.runtime_id, taskDirectory, trialDirectory, trial,
    bundleDirectory, destination: path.join(root, "snapshot") });
  assert.equal(capture.manifest.status, "available");
  await lease.markRunning();
  const directory = path.join(root, "regrade");
  const plan = buildEvalExecutionPlan({ evalId, tasks: ["one"], maxParallelism: 1, provider: lease.current().provider, trialResources: reservation,
    candidate: { revisionIdentity: sha256JSON("recorded-canary-revision"), artifactId: sha256JSON("recorded-canary-artifact") },
    request: { schema_version: "1", backend: "harbor", dataset: taskDirectory, harness_ref: "canary@version:1", model: "canary/unused",
      attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 10_000, setup_timeout_ms: 10_000,
      agent_args: [], pass_env: [], benchmark_id: "verifier-canary", benchmark_revision: sha256JSON("canary") } });
  const outcome = await runRemoteVerifierWork({ root, directory, sourceSnapshotDirectory: capture.directory!, taskDirectory,
    sourceManifest: capture.manifest, sourceTrial: portableRemoteTrial(trial), candidateResult, candidateResultDigest: sha256JSON(candidateResult),
    runtimeDirectory: runtime.directory, verifierRuntimeDirectory: runtime.directory, verifierRuntimeId: runtime.runtime_id,
    trialName: "one__regrade", lease: lease.current(), plan,
    env: process.env, harborExecutable: path.join(path.dirname(python), "harbor"), signal: controller.signal });
  assert.equal(outcome.backend.process_exit_code, 0);
  assert.equal(outcome.trial.agent_setup, null);
  assert.equal(outcome.trial.agent_execution, null);
  assert.deepEqual(outcome.trial.agent_result, trial.agent_result);
  assert.equal((outcome.trial.verifier_result as { rewards?: { reward?: number } })?.rewards?.reward, 1);
  assert.equal((await readFile(path.join(directory, "regrade.json"), "utf8")).includes("never-transfer-agent-config"), false);
  passed = true;
  summary = { status: "passed", harbor: outcome.backend.version, image_id: imageId, candidate_executes: false,
    reward: 1, agent_result_preserved: true, private_config_transferred: false };
} finally {
  clearInterval(heartbeat);
  await lease.release();
  const report = await reapOwnedDockerResources({ root, leaseIds: [lease.leaseId], env: process.env });
  cleanupProven = report.issues.length === 0 && report.retained.length === 0;
  if (cleanupProven && passed) { await writable(root); await rm(root, { recursive: true, force: true }); }
  else console.error(`Verifier canary retained evidence: ${root}; cleanup_proven=${cleanupProven}`);
}
assert.equal(cleanupProven, true);
console.log(JSON.stringify({ ...summary, cleanup_proven: true }));

async function writable(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) return;
  await chmod(directory, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const entry of await readdir(directory)) await writable(path.join(directory, entry));
}
