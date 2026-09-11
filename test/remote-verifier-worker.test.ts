import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeRemoteHarborVerifier } from "../src/workers/remote-harbor-verifier.js";
import { encodeRemoteTreeEnvelope } from "../src/control-plane/remote-work-inputs.js";
import { parseRemoteVerifierResultEnvelope } from "../src/control-plane/remote-verifier-result.js";
import { importRemoteVerifierResultEnvelope } from "../src/control-plane/remote-verifier-import.js";
import type { RemoteHarborWorkSpecV2 } from "../src/workers/remote-harbor-work-spec.js";
import type { RemoteWorkOfferV1 } from "../src/domain/index.js";
import { remoteVerifierFixture } from "../test-support/remote-verifier.js";

for (const disconnected of [false, true]) test(`remote verifier worker ${disconnected ? "stops at the last confirmed expiry" : "renews across the original expiry and returns scoring evidence"}`, async t => {
  const f = await remoteVerifierFixture(t, 3_000), workerRoot = path.join(f.root, "worker"), workspace = path.join(workerRoot, "workspace"), bin = path.join(workerRoot, "bin");
  await mkdir(workspace, { recursive: true }); await mkdir(bin);
  const docker = path.join(bin, "docker"); await writeFile(docker, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--version')) { console.log('harbor 0.21.0'); process.exit(0); }
if (process.argv[2] !== 'trials' || process.argv[3] !== 'start') throw Error('candidate execution forbidden');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
if (config.source_trial.action !== 'regrade' || config.agent.kwargs || JSON.stringify(config).includes('private-agent-token')) throw Error('private candidate execution');
const source = JSON.parse(fs.readFileSync(path.join(config.source_trial.path, 'result.json')));
if (fs.readFileSync(path.join(config.source_trial.path, 'artifacts/patch.diff'), 'utf8') !== 'original patch\\n') throw Error('candidate artifacts changed');
await new Promise(resolve => setTimeout(resolve, 4500));
const output = path.join(config.trials_dir, config.trial_name); fs.mkdirSync(path.join(output, 'verifier'), {recursive:true});
fs.writeFileSync(path.join(output, 'verifier/test-stdout.txt'), 'tests passed');
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...source, config, trial_name:config.trial_name,
 agent_setup:null, agent_execution:null, verifier_result:{rewards:{reward:1,total_score:1}}}));
`, { mode: 0o755 });
  const inputs = new Map([ ["verifier-source" as const, await encodeRemoteTreeEnvelope(f.sourceSnapshotDirectory)],
    ["verifier-runtime" as const, await encodeRemoteTreeEnvelope(f.runtime.directory)] ]);
  let reads = 0, releases = 0;
  const result = await executeRemoteHarborVerifier({ root: workerRoot, workspace, runtimeDirectory: f.runtime.directory, taskDirectory: f.taskDirectory,
    spec: { schema_version: "2", plan: f.plan, verifier_only: f.descriptor } as RemoteHarborWorkSpecV2,
    offer: { lease: f.owner.current(), work: f.work } as RemoteWorkOfferV1, inputs, credentials: new Map(),
    signal: new AbortController().signal, emit: async () => {}, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, harborExecutable: harbor,
    readExecutionLease: async () => { reads++; if (disconnected && reads > 1) throw new Error("controller unavailable"); await f.owner.heartbeat(); return f.owner.current(); },
    release: async () => { releases++; await f.owner.release(); } });
  assert.ok(reads >= 2);
  if (disconnected) {
    assert.equal(result.status, "cancelled"); assert.ok(result.artifacts?.every(a => a.kind === "diagnostic"));
  } else {
    assert.equal(result.status, "succeeded", result.artifacts?.map(a => a.body.toString()).join("\n"));
    const body = result.artifacts![0]!.body, envelope = parseRemoteVerifierResultEnvelope(JSON.parse(body.toString()));
    assert.equal(envelope.outcome.trial.agent_setup, null); assert.equal(envelope.outcome.trial.agent_execution, null);
    const artifactPath = path.join(f.root, "worker-result.json"); await writeFile(artifactPath, body);
    const imported = await importRemoteVerifierResultEnvelope({ root: f.root, evalDirectory: f.evalDirectory, verifier: f.descriptor,
      plan: f.plan, work: f.work, physical: f.physical, lease: f.owner.current(), artifactPath });
    assert.equal(imported.ref.run_id, f.runId); assert.equal(imported.ref.reward, 1);
  }
  assert.equal(releases, 0); await result.release!(); assert.equal(releases, 1);
});
