import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1 } from "../src/domain/index.js";
import { atomicWriteJSON, readJSON } from "../src/foundation/index.js";
import { buildEvalExecutionPlan, createEvalProgress, mergeEvalProgressTrial } from "../src/evals/index.js";
import { verifierOnlyEvalRerun } from "../src/evals/verifier-only-rerun.js";
import { writeTrialEnvironmentImageEvidence } from "../src/evals/trial-environment-evidence.js";
import { regradeTreeDigest } from "../src/evals/regrade-evidence.js";
import { writeResultBundleIndex } from "../src/runs/index.js";
import { remoteVerifierFixture } from "../test-support/remote-verifier.js";

const sha = (value: string) => `sha256:${value.repeat(64)}` as const;
for (const mode of ["valid", "missing", "wrong", "config-mismatch"] as const) test(`local verifier-only image role entry: ${mode}`, { skip: process.platform === "win32" && "POSIX subprocess fixtures" }, async t => {
  const f = await remoteVerifierFixture(t); await f.owner.release();
  const manifests: EnvironmentImageManifestV1[] = ["candidate", "verifier"].map((role, index) => ({
    schema_version: "1", image_id: sha(index ? "b" : "a"), source: { kind: "build-context", benchmark_id: "demo", benchmark_revision: "1", task_id: "one" },
    platform: "linux/amd64", build: { builder: "buildkit", secret_names: [], cache_key: sha("c") },
    output: { reference: `hitch-environment:${role}`, manifest_digest: sha(index ? "e" : "d"), config_digest: sha(index ? "f" : "0") },
    base_images: [], created_at: "2026-01-01T00:00:00.000Z",
  }));
  const uses: EnvironmentImageUseV1[] = manifests.map((manifest, index) => ({ task_ids: ["one"], role: index ? "verifier" : "candidate", image_id: manifest.image_id,
    requested_reference: manifest.output.reference, reference: `${manifest.output.reference}@${manifest.output.manifest_digest}`,
    manifest_digest: manifest.output.manifest_digest, platform: manifest.platform, resolution: "prebuilt", cache_hit: false }));
  const plan = buildEvalExecutionPlan({ evalId: f.evalId, request: f.request, tasks: ["one"], workItemMode: "task-slots", maxParallelism: 1,
    candidate: { revisionIdentity: sha("a"), artifactId: sha("b") }, provider: "local-docker", trialResources: f.work.reservation, environmentImages: uses });
  await atomicWriteJSON(path.join(f.evalDirectory, "execution-plan.json"), plan);
  const sourceDirectory = path.join(f.evalDirectory, "harbor/work-items", plan.work_items[0]!.work_id, "epoch-000001/job", f.descriptor.source_ref.trial_id);
  await cp(path.join(f.root, "native-source"), sourceDirectory, { recursive: true });
  const sourceConfig = await readJSON<any>(path.join(sourceDirectory, "config.json"));
  sourceConfig.environment.kwargs = { hitch_prebuilt_task_image: manifests[0]!.output.config_digest,
    hitch_prebuilt_verifier_image: mode === "config-mismatch" ? sha("9") : manifests[1]!.output.config_digest, hitch_verifier_resolved_images: {} };
  await atomicWriteJSON(path.join(sourceDirectory, "config.json"), sourceConfig);
  const source = await readJSON<any>(path.join(sourceDirectory, "result.json"));
  await atomicWriteJSON(path.join(sourceDirectory, "result.json"), { ...source, config: sourceConfig });
  await writeTrialEnvironmentImageEvidence(f.runDirectory, "one", { uses, manifests });
  await writeResultBundleIndex(f.runDirectory);
  const before = await regradeTreeDigest(f.runDirectory);
  const bin = path.join(f.root, "bin"); await mkdir(bin);
  const stateFile = path.join(f.root, "active-config.json"), removed = path.join(f.root, "removed");
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--version')) { console.log('harbor 0.21.0'); process.exit(0); }
if (process.argv[2] !== 'trials' || process.argv[3] !== 'start') throw Error('Target rerun forbidden');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
if (config.source_trial.action !== 'regrade' || config.environment.kwargs.hitch_prebuilt_verifier_image !== '${sha("f")}') throw Error('wrong verifier binding');
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(config));
fs.rmSync(${JSON.stringify(removed)}, {force:true});
const source = JSON.parse(fs.readFileSync(path.join(config.source_trial.path,'result.json')));
const output=path.join(config.trials_dir,config.trial_name); fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'result.json'), JSON.stringify({...source,config,trial_name:config.trial_name,agent_execution:null,agent_setup:null,
 verifier:{started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z'},exception_info:null,verifier_result:{rewards:{reward:1,total_score:1}}}));
`, { mode: 0o755 });
  const docker = path.join(bin, "docker");
  await writeFile(docker, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), state=${JSON.stringify(stateFile)}, removed=${JSON.stringify(removed)}, id='${"7".repeat(64)}';
const config=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):null;
if (args[0]==='container' && args[1]==='ls') { if(config && '${mode}'!=='missing' && !fs.existsSync(removed)) console.log(id); }
else if(args[0]==='container' && args[1]==='inspect') console.log(JSON.stringify([{Id:id,Config:{Labels:{...config.environment.kwargs.hitch_ownership_labels,
 'io.hitch.environment-role':'verifier','com.docker.compose.service':'main'},Image:'${sha("f")}'},Image:'${mode === "wrong" ? sha("9") : sha("f")}',State:{Running:false,ExitCode:0}}]));
else if(args[0]==='container' && args[1]==='rm') fs.writeFileSync(removed,'removed');
else if(args[0]==='container' && args[1]==='stats') console.log(JSON.stringify({MemUsage:'1MiB / 1GiB'}));
`, { mode: 0o755 });
  const progress = mergeEvalProgressTrial(createEvalProgress({ evalId: f.evalId, benchmarkId: f.request.benchmark_id,
    benchmarkRevision: f.request.benchmark_revision, plannedTasks: 1, plannedTrials: 1, startedAt: new Date().toISOString() }), f.descriptor.source_ref);
  const rerunId = `rerun_${"8".repeat(32)}`, rerunDirectory = path.join(f.evalDirectory, "reruns", rerunId);
  const input = { root: f.root, evalId: f.evalId, evalDirectory: f.evalDirectory, rerunId, rerunDirectory, selector: { mode: "invalid" as const },
    startedAt: new Date().toISOString(), request: f.request, progress, previousResult: null,
    plan: { tasks: ["one"], attempts: 1, controllerRuntime: { runtime_id: f.runtime.runtime_id, manifest_digest: f.runtime.manifest_digest } },
    selectedTrials: [{ task_id: "one", attempt: 1 }], env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HITCH_DOCKER_PATH: docker }, harborExecutable: harbor };
  if (mode === "valid") {
    const result = await verifierOnlyEvalRerun(input);
    assert.equal(result.eval_status, "succeeded");
    const assessment = (await readJSON<any>(path.join(f.evalDirectory, "progress.json"))).trials[0].assessment;
    const directory = path.join(f.evalDirectory, "assessments", assessment.id, "evidence");
    const evidence = await readJSON<any>(path.join(directory, "environment/image.manifest.json"));
    assert.deepEqual(evidence.uses.map((use: EnvironmentImageUseV1) => use.role), ["verifier"]);
    const execution = await readJSON<any>(path.join(directory, "execution.json"));
    assert.deepEqual(execution.observed.containers.map((container: any) => container.role), ["verifier"]);
  } else {
    await assert.rejects(verifierOnlyEvalRerun(input), { code: mode === "missing" ? "environment_image_evidence_unavailable" : "environment_image_mismatch" });
  }
  assert.equal(await regradeTreeDigest(f.runDirectory), before, "sealed candidate bytes remain unchanged");
});
