import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureRemoteVerifierSource, createExecutionLease, portableRemoteTrial, runRemoteVerifierWork } from "../src/evals/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import type { EvalExecutionPlanV1 } from "../src/domain/index.js";
import { atomicWriteJSON, sha256JSON } from "../src/foundation/index.js";
import { writeResultBundleIndex } from "../src/runs/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("remote verifier executes restored artifacts with the original agent result and no private agent config", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-remote-verifier-")); t.after(() => forceRemove(root));
  const runtime = await ensureControllerRuntime({ root }), taskDirectory = path.join(root, "one"), trialDirectory = path.join(root, "trial");
  await mkdir(taskDirectory); await mkdir(path.join(trialDirectory, "artifacts"), { recursive: true });
  await writeFile(path.join(taskDirectory, "task.toml"), '[verifier]\nenvironment_mode="separate"\n');
  await writeFile(path.join(trialDirectory, "artifacts", "candidate.txt"), "original candidate");
  const runId = `run_${"a".repeat(32)}`, evalId = `eval_${"b".repeat(32)}`;
  const config = { task: { path: taskDirectory }, agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", kwargs: { token: "never-send-agent-token" } },
    environment: { type: "docker", import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment", override_cpus: 1, override_memory_mb: 1024,
      cpu_enforcement_policy: "limit", memory_enforcement_policy: "limit" },
    verifier: { import_path: "hitch_harbor_verifier:HitchRetryingVerifier", override_timeout_sec: 20 } };
  const trial = { id: "00000000-0000-0000-0000-000000000001", trial_name: "one__original", task_name: "one", config,
    agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: runtime.runtime_id } } };
  await atomicWriteJSON(path.join(trialDirectory, "config.json"), config); await atomicWriteJSON(path.join(trialDirectory, "result.json"), trial);
  await atomicWriteJSON(path.join(trialDirectory, "benchmark-lifecycle.json"), { schema_version: "1", failure: null, phases: {} });
  const bundleDirectory = path.join(root, "bundle"), result = { run_id: runId, status: "succeeded", output: "candidate" };
  await atomicWriteJSON(path.join(bundleDirectory, "manifest.json"), { schema_version: "1", run_id: runId, sealed: true });
  await atomicWriteJSON(path.join(bundleDirectory, "result.json"), result); await writeResultBundleIndex(bundleDirectory);
  const capture = await captureRemoteVerifierSource({ taskId: "one", runId, runtimeId: runtime.runtime_id, trial, taskDirectory, trialDirectory, bundleDirectory, destination: path.join(root, "snapshot") });
  assert.equal(capture.manifest.status, "available");
  assert.notEqual(capture.manifest.source_result_digest, capture.manifest.original_result_digest);
  const bin = path.join(root, "bin"); await mkdir(bin);
  await writeFile(path.join(bin, "docker"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--version')) { console.log('harbor 0.21.0'); process.exit(0); }
if (process.argv[2] !== 'trials' || process.argv[3] !== 'start') throw Error('candidate execution forbidden');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
if (config.source_trial.action !== 'regrade' || config.agent.kwargs || config.verifier.override_timeout_sec !== 20) throw Error('invalid regrade config');
if (JSON.stringify(config).includes('never-send-agent-token')) throw Error('private agent token copied');
const source = JSON.parse(fs.readFileSync(path.join(config.source_trial.path, 'result.json')));
if (fs.readFileSync(path.join(config.source_trial.path, 'artifacts/candidate.txt'), 'utf8') !== 'original candidate') throw Error('candidate artifacts changed');
const output = path.join(config.trials_dir, config.trial_name); fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...source, config, trial_name:config.trial_name, verifier_result:{rewards:{reward:1}}}));
`, { mode: 0o755 });
  const reservation = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const owner = await createExecutionLease({ evalId, evalDirectory: path.join(root, "evals", evalId), workId: `work_${"d".repeat(32)}`,
    worker: { workerId: "worker_remote", provider: "remote-docker", collisionDomainId: "remote-docker" }, reservation, ttlMs: 45_000 });
  await owner.markRunning();
  const lease = owner.current();
  const input = { root, directory: path.join(root, "regrade"), sourceSnapshotDirectory: capture.directory!, taskDirectory, sourceManifest: capture.manifest,
    sourceTrial: portableRemoteTrial(trial), candidateResult: result, candidateResultDigest: sha256JSON(result), runtimeDirectory: runtime.directory,
    verifierRuntimeDirectory: runtime.directory, verifierRuntimeId: runtime.runtime_id, trialName: "one__regrade", lease,
    plan: { eval_id: evalId, provider: lease.provider, slots: [{ task_id: "one" }] } as EvalExecutionPlanV1,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, harborExecutable: harbor };
  const outcome = await runRemoteVerifierWork(input);
  assert.deepEqual(outcome.trial.agent_result, trial.agent_result); assert.equal(outcome.trial.config, undefined);
  assert.deepEqual(outcome.trial.verifier_result, { rewards: { reward: 1 } });
  assert.equal(JSON.stringify(await readFile(path.join(input.directory, "source-trial/config.json"), "utf8")).includes("never-send-agent-token"), false);
  await rm(input.directory, { recursive: true });
  await assert.rejects(runRemoteVerifierWork({ ...input, candidateResultDigest: sha256JSON("replacement") }), /identity differs/);
  await writeFile(path.join(taskDirectory, "task.toml"), '[verifier]\nenvironment_mode="shared"\n');
  await assert.rejects(runRemoteVerifierWork(input), /snapshot digest mismatch/);
  await owner.release();
  await assert.rejects(runRemoteVerifierWork(input), /no current execution lease/);
});
