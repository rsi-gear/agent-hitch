import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { importCompetition, parseArgs, rawMetrics } from '../import.mjs';
import { ResourceStore, identity, parseResourceDataset, sealResourceTask, preflightResourceTask, materializeResourceTask, finishResourceWorkspace } from '../../../dist/src/resources/index.js';
import { FixtureImageProvider, fixtureReference } from '../../../dist/test-support/resource-fixture.js';
import { captureVerifierScoreEvidence } from '../../../dist/src/evals/verifier-score-artifacts.js';
import { verifierObservation } from '../../../dist/src/evals/verifier-diagnostics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.KAGGLE_TEST_PYTHON ?? 'python3';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kaggle-producer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const generated = spawnSync(python, ['-c', 'import sys; sys.path.insert(0,sys.argv[1]); from test_kaggle import synthetic; from pathlib import Path; synthetic(Path(sys.argv[2]))', here, source], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const root = path.join(directory, 'hitch');
  const store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  let ended = 0;
  // Keep the real CAS/task sealing/preflight functions; replace only external OCI transport.
  const request = async (_, operation, input) => {
    if (operation === 'import') return store.import(input.source, input.kind, input.owner);
    if (operation === 'lease-end') { ended++; await store.finishLease(input.leaseId, input.confirmation); return { acknowledged: true }; }
    assert.equal(operation, 'seal-dataset');
    return store.admission(async () => {
      const tasks = [];
      for (const id of [...input.taskIds].sort()) tasks.push(await sealResourceTask(store, path.join(input.directory, id), id, `${input.owner}:${id}`));
      const body = { schema_version: '2', kind: 'gear-harbor-benchmark', resource_protocol: 'hitch-resource-lock@1', ...input.manifest, tasks };
      const manifest = parseResourceDataset({ ...body, dataset_digest: identity('hitch-resource-dataset@2', body) });
      for (const task of tasks) await preflightResourceTask(store, task, { owner: `${input.owner}:admission:${task.task_id}`, generation: 1, platform: 'linux/amd64' });
      await writeFile(path.join(input.directory, 'benchmark.adapter.json'), JSON.stringify(manifest), { flag: 'wx' });
      return manifest;
    });
  };
  const options = { source, out: path.join(directory, 'compiled'), root, baseImage: fixtureReference, synthetic: true, python };
  return { directory, store, options, request, ended: () => ended };
}

test('producer seals actual resource v2 tasks and materializes strict role partitions', async t => {
  const f = await fixture(t);
  const result = await importCompetition(f.options, f.request);
  assert.equal(f.ended(), 14);
  const seed = parseResourceDataset(JSON.parse(await readFile(path.join(result.seed, 'benchmark.adapter.json'), 'utf8')));
  const holdout = parseResourceDataset(JSON.parse(await readFile(path.join(result.heldOut, 'benchmark.adapter.json'), 'utf8')));
  const finalization = parseResourceDataset(JSON.parse(await readFile(path.join(result.finalization, 'benchmark.adapter.json'), 'utf8')));
  assert.equal(seed.tasks.length, 5); assert.equal(holdout.tasks.length, 1); assert.equal(finalization.tasks.length, 1);
  assert.deepEqual(seed.raw_metrics, holdout.raw_metrics);
  assert.equal(seed.scoring.process_score, undefined);
  assert.equal(finalization.raw_metrics.metrics.some(metric => metric.id === 'accuracy'), false);
  const competition = JSON.parse(await readFile(result.competition, 'utf8'));
  assert.equal(competition.synthetic, true); assert.equal(competition.submission.expected_ids.length, 12);
  assert.equal(JSON.stringify(competition).includes(f.directory), false, 'host paths must not enter semantic identity');
  const generatedRewards = spawnSync(python, [path.join(here, 'reward_fixture.py'), '--out', path.join(f.directory, 'rewards')], { encoding: 'utf8' });
  assert.equal(generatedRewards.status, 0, generatedRewards.stderr);
  const contract = JSON.parse(await readFile(path.join(here, '../../../test-contracts/kaggle-rewards-v1.json'), 'utf8'));
  assert.deepEqual(contract.raw_metrics, rawMetrics('kaggle-contract-v1'));
  assert.deepEqual(contract.finalization_raw_metrics, rawMetrics('kaggle-contract-v1', true));
  assert.deepEqual(contract.cases.map(item => item.id), JSON.parse(generatedRewards.stdout).cases.map(item => item.name));
  for (const item of JSON.parse(generatedRewards.stdout).cases) {
    const declared = contract.cases.find(value => value.id === item.name);
    assert.deepEqual(item.rewards, declared.rewards, 'shared Gear/Hitch fixture must match actual scorer output');
    const verifierResult = { rewards: item.rewards };
    const dataset = item.name === 'finalization' ? result.finalization : result.seed;
    const manifest = item.name === 'finalization' ? finalization : seed;
    const captured = await captureVerifierScoreEvidence({ trialDirectory: item.trialDirectory, runDirectory: path.join(item.trialDirectory, 'run'),
      verifierResult, dataset, benchmarkRevision: manifest.dataset_digest });
    assert.equal(captured.issue, undefined, `${item.name}: ${captured.issue}`);
    assert.deepEqual(captured.scores, { total_score: item.rewards.total_score, normalization: declared.expected_normalization });
    assert.equal(captured.process, undefined);
    assert.deepEqual(verifierObservation({ trial: { verifier_result: verifierResult }, runStatus: 'succeeded', trajectoryStatus: 'valid', recordStatus: 'valid',
      verifierRef: 'verifier/result.json', infrastructure: null }), { status: declared.expected_observation_status, reward: item.rewards.total_score, verifier_result_ref: 'verifier/result.json' });
    if (item.name === 'invalid_prediction' || item.name === 'candidate_failed') {
      assert.equal(item.rewards.total_score, 0); assert.equal(item.rewards.valid_output, 0); assert.equal(item.rewards.completed, 0);
      assert.equal(item.rewards.accuracy, undefined); assert.equal(captured.feedback.items[0].code, 'invalid_prediction');
    } else {
      assert.equal(item.rewards.valid_output, 1); assert.equal(item.rewards.completed, 1);
      if (item.name === 'finalization') assert.equal(item.rewards.accuracy, undefined);
      else assert.equal(item.rewards.total_score, item.rewards.accuracy);
      if (item.name === 'valid_zero') assert.equal(item.rewards.total_score, 0);
      if (item.name === 'half_correct') assert.equal(item.rewards.total_score, 0.5);
    }
  }
  for (const task of [seed.tasks[0], holdout.tasks[0], finalization.tasks[0]]) {
    const { plan } = await preflightResourceTask(f.store, task, { owner: `test:${task.task_id}`, generation: 1, platform: 'linux/amd64' });
    const workspace = await materializeResourceTask(f.store, plan, { owner: `test:${task.task_id}`, generation: 1, policy: { mode: 'copy' } });
    try {
      const candidate = path.join(workspace.taskDirectory, 'environment/candidate/data');
      const privateDir = path.join(workspace.taskDirectory, 'tests/private');
      assert.deepEqual((await readdir(candidate)).sort(), ['predict.csv', 'task.json', 'train.csv']);
      assert.equal((await readFile(path.join(candidate, 'predict.csv'), 'utf8')).split('\n')[0].includes('Survived'), false);
      await assert.rejects(readFile(path.join(candidate, 'expected.csv')), { code: 'ENOENT' });
      const expected = await readFile(path.join(privateDir, 'expected.csv'), 'utf8');
      assert.equal(expected.split('\n')[0], task.task_id === 'titanic-finalize' ? 'PassengerId' : 'PassengerId,Survived');
      const sourceTree = await f.store.objects.readTree(task.sourceTree.manifestDigest);
      assert.equal(sourceTree.entries.some(entry => entry.path.endsWith('expected.csv') || entry.path.endsWith('train.csv')), false, 'data belongs to role resources, not the shared descriptor');
    } finally { await finishResourceWorkspace(f.store, workspace.id, { executionEnded: true, resultSealed: true }); }
  }
  const repeated = await importCompetition({ ...f.options, out: path.join(f.directory, 'same-input') }, f.request);
  assert.equal(result.competitionDigest, repeated.competitionDigest);
  assert.deepEqual(result.datasets, repeated.datasets);
  await assert.rejects(importCompetition(f.options, f.request), /output already exists/);
});

test('generated descriptors validate against the installed native Harbor TaskConfig', { skip: !process.env.KAGGLE_HARBOR_PYTHON }, async t => {
  const f = await fixture(t);
  const result = await importCompetition(f.options, f.request);
  const checked = spawnSync(process.env.KAGGLE_HARBOR_PYTHON, ['-c', [
    'import json, sys, tomllib',
    'from pathlib import Path',
    'from harbor.models.task.config import TaskConfig',
    'files = sorted(Path(sys.argv[1]).glob("*/*/task.toml"))',
    'assert len(files) == 7, files',
    'for file in files:',
    '    task = TaskConfig.model_validate(tomllib.loads(file.read_text()))',
    '    assert task.environment.network_mode == "public"',
    '    assert task.environment.workdir == "/app"',
    '    assert task.verifier.environment_mode == "separate"',
    '    assert task.verifier.environment.network_mode == "no-network"',
    '    assert [item.source for item in task.artifacts] == ["/output/predictions.csv", "/output/receipt.json"]',
    'print(json.dumps({"validated_tasks": len(files), "schema": "native Harbor TaskConfig"}))',
  ].join('\n'), path.dirname(result.competition)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).validated_tasks, 7);
});

test('failed sealing never publishes an incomplete dataset and releases imported leases', async t => {
  const f = await fixture(t);
  await assert.rejects(importCompetition(f.options, async (...args) => {
    if (args[1] === 'seal-dataset') throw new Error('fixture unavailable image');
    return f.request(...args);
  }), /unavailable image/);
  await assert.rejects(readFile(path.join(f.options.out, 'competition.json')), { code: 'ENOENT' });
  assert.equal(f.ended(), 10);
  assert.equal((await readdir(f.directory)).some(name => name.includes('.partial-')), false);
});

test('CLI admission rejects mutable runtime identities and invalid budgets, including symlink invocation', async t => {
  assert.throws(() => parseArgs(['--source', 'data', '--out', 'out', '--root', 'root', '--base-image', 'python:latest']), /Usage/);
  assert.throws(() => parseArgs(['--source', 'data', '--out', 'out', '--root', 'root', '--base-image', fixtureReference, '--folds', '1']), /Usage/);
  assert.equal(rawMetrics('fixed').metrics.find(metric => metric.id === 'pass_rate').source.extractor, 'equals-v1');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kaggle-cli-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'import.mjs');
  await symlink(path.join(here, '../import.mjs'), alias);
  const executed = spawnSync(process.execPath, [alias, '--invalid'], { encoding: 'utf8' });
  assert.equal(executed.status, 1, 'symlink execution must invoke main instead of silently doing nothing');
  assert.match(executed.stderr, /Usage:/);
});
