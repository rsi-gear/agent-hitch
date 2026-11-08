import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { produceAnalysisTask } from '../analysis.mjs';
import { ResourceStore, identity, parseResourceDataset, sealResourceTask } from '../../../dist/src/resources/index.js';
import { FixtureImageProvider, fixtureReference } from '../../../dist/test-support/resource-fixture.js';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const hash = sha('fixture');

for (const version of [2, 3]) for (const metric of ['accuracy', 'auc-roc', 'mean-column-wise-rmsle']) test(`MLE-bench v${version} ${metric}: real resource contracts and external CSV scoring`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-mle-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'hitch'), candidate = join(dir, 'candidate'), output = join(dir, 'output'), privateDir = join(dir, 'private');
  for (const d of [candidate, output, privateDir]) await mkdir(d);
  const columns = metric === 'mean-column-wise-rmsle' ? ['a', 'b'] : ['target'];
  const { task: legacy } = JSON.parse(await readFile(new URL('../analysis-contracts/golden.json', import.meta.url)));
  const task = { ...legacy, protocol: `analysis-task@${version}`, predictIds: ['1', '2'],
    prediction: { kind: 'tabular', metric, idColumn: 'id', targetColumns: columns, labels: columns.length === 1 ? ['0','1'] : [] },
    publicFiles: [], benchmark: { format: 'mle-bench', competitionId: 'fixture', definitionDigest: hash, publicTreeDigest: hash, sourceRevision: 'fixture', verification: 'fixture' } };
  const solution = { protocol: 'analysis-solution@1', digest: hash, files: [{ path: 's.py', digest: hash, bytes: 1 }], entrypoint: 's.py',
    parameters: {}, trainingSeed: 42, runtimeDigest: task.runtimeDigest, authoredByRunId: 'fixture' };
  const request = { protocol: 'analysis-delivery-request@1', sequenceId: 'fixture', planDigest: hash, task,
    harness: { commit: 'a'.repeat(40), manifestDigest: hash }, runtimeDigest: task.runtimeDigest, solution, selectionsDigest: hash,
    allowance: { cpuSeconds: 60, wallSeconds: 60, tools: 0, tokens: 0, requests: 0 }, digest: hash };
  const csv = metric === 'mean-column-wise-rmsle' ? 'id,a,b\n1,0,1\n2,2,3\n' : 'id,target\n1,0\n2,1\n';
  await writeFile(join(candidate, 'request.json'), JSON.stringify(request));
  await writeFile(join(privateDir, 'request.json'), JSON.stringify(request));
  await writeFile(join(privateDir, 'expected.csv'), csv); await writeFile(join(output, 'predictions.csv'), csv);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ protocol: 'analysis-execution-receipt@1', requestDigest: hash,
    solutionDigest: hash, modelRequests: 0, status: 'completed', predictionsDigest: sha(csv) }));
  const store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  const rpc = async (_, operation, input) => {
    if (operation === 'import') return store.import(input.source, input.kind, input.owner);
    if (operation === 'lease-end') { await store.finishLease(input.leaseId, input.confirmation); return {}; }
    assert.equal(operation, 'seal-dataset');
    const tasks = [];
    for (const id of input.taskIds) tasks.push(await sealResourceTask(store, join(input.directory, id), id, input.owner));
    const body = { schema_version: '2', kind: 'gear-harbor-benchmark', resource_protocol: 'hitch-resource-lock@1', ...input.manifest, tasks };
    const manifest = parseResourceDataset({ ...body, dataset_digest: identity('hitch-resource-dataset@2', body) });
    const raw = manifest.raw_metrics.metrics.find(m => m.id === 'task_score');
    assert.equal(raw.unit, metric); assert.equal(raw.direction, columns.length === 2 ? 'minimize' : 'maximize');
    if (columns.length === 2) assert.equal(raw.range, undefined);
    return manifest;
  };
  const produced = await produceAnalysisTask({ root, candidate, out: join(dir,'dataset'), expected: join(privateDir,'expected.csv'),
    baseImage: fixtureReference, platform: 'linux/amd64', request, timeoutSeconds: 60 }, rpc);
  const verifier = join(produced.path, produced.taskId, 'tests/verify.py');
  const code = 'import sys,importlib.util,json; from pathlib import Path; p=Path(sys.argv[1]); sys.path.insert(0,str(p.parent)); s=importlib.util.spec_from_file_location("verify",p); m=importlib.util.module_from_spec(s);s.loader.exec_module(m); print(json.dumps(m.score(Path(sys.argv[2]),Path(sys.argv[3]))))';
  const score = () => { const r = spawnSync(process.env.KAGGLE_TEST_PYTHON ?? 'python3', ['-c', code, verifier, privateDir, output], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const result = score(); assert.equal(result.total_score, 1); assert.equal(result.task_score, columns.length === 2 ? 0 : 1);
  if (metric !== 'accuracy') assert.equal(result.accuracy, undefined);
  const bad = columns.length === 2 ? 'id,a,b\n1,-1,1\n2,2,3\n' : 'id,target\n1,NaN\n2,1\n';
  await writeFile(join(output,'predictions.csv'), bad);
  const receipt = JSON.parse(await readFile(join(output,'receipt.json'))); receipt.predictionsDigest=sha(bad);
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt));
  assert.equal(score().valid_output, 0);
});

test('budgeted rollout requests remain research tasks and do not require external answers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-budget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'hitch'), candidate = join(dir, 'candidate'), output = join(dir, 'output');
  for (const path of [candidate, output]) await mkdir(path);
  const golden = JSON.parse(await readFile(new URL('../analysis-contracts/golden.json', import.meta.url)));
  const request = { protocol: 'analysis-rollout-request@2', sequenceId: 'sequence', slotIndex: 7, maxExperiments: 7,
    planDigest: hash, task: golden.task, harness: { commit: 'a'.repeat(40), manifestDigest: hash }, model: 'fixture',
    runtimeDigest: golden.task.runtimeDigest, checkpointDigest: golden.checkpoint.digest, checkpointRef: hash,
    previousRolloutReceiptDigest: hash, eligibleSolutionDigests: [], allowance: { wallSeconds: 60, cpuSeconds: 60, tools: 10, tokens: null, requests: null },
    experimentWallSeconds: 30, experimentCpuSeconds: 30, digest: hash };
  await writeFile(join(candidate, 'checkpoint.json'), JSON.stringify(golden.checkpoint));
  await writeFile(join(candidate, 'request.json'), JSON.stringify(request));
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ protocol: 'analysis-rollout-output@1', requestDigest: hash }));
  const store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  const rpc = async (_, operation, input) => {
    if (operation === 'import') return store.import(input.source, input.kind, input.owner);
    if (operation === 'lease-end') { await store.finishLease(input.leaseId, input.confirmation); return {}; }
    assert.equal(operation, 'seal-dataset');
    assert.ok(input.manifest.raw_metrics.metrics.every(m => m.id !== 'task_score' && m.id !== 'accuracy'));
    const tasks = [];
    for (const id of input.taskIds) {
      assert.match(await readFile(join(input.directory, id, 'instruction.md'), 'utf8'), /one experiment/);
      tasks.push(await sealResourceTask(store, join(input.directory, id), id, input.owner));
    }
    const body = { schema_version: '2', kind: 'gear-harbor-benchmark', resource_protocol: 'hitch-resource-lock@1', ...input.manifest, tasks };
    return parseResourceDataset({ ...body, dataset_digest: identity('hitch-resource-dataset@2', body) });
  };
  const produced = await produceAnalysisTask({ root, candidate, out: join(dir, 'dataset'), expected: null,
    baseImage: fixtureReference, platform: 'linux/amd64', request, timeoutSeconds: 60 }, rpc);
  const verifier = join(produced.path, produced.taskId, 'tests/verify.py');
  const code = 'import sys,importlib.util,json; from pathlib import Path; p=Path(sys.argv[1]);sys.path.insert(0,str(p.parent));s=importlib.util.spec_from_file_location("v",p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.score(Path(sys.argv[2]),Path(sys.argv[3]))))';
  const result = spawnSync(process.env.KAGGLE_TEST_PYTHON ?? 'python3', ['-B', '-c', code, verifier, candidate, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).valid_output, 1);
  await assert.rejects(produceAnalysisTask({ request: { ...request, slotIndex: 8 } }), /slot budget/);
});
