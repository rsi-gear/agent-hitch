import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { produceTask, importMlebench, defaultParameters } from '../index.mjs';
import { admitTaskParameters, admitParameters } from 'agent-hitch/parameters';
import { inspectMlebench } from '../mlebench/import.mjs';
import { parseArgs } from '../import.mjs';
import { ResourceStore, identity, parseResourceDataset, sealResourceTask } from '../../../dist/src/resources/index.js';
import { FixtureImageProvider, fixtureReference } from '../../../dist/test-support/resource-fixture.js';
const python = process.env.KAGGLE_TEST_PYTHON ?? 'python3';
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

async function fixture(t, mode = 'scored', metric = 'accuracy') {
  const dir = await mkdtemp(join(tmpdir(), 'mlebench-task-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const publicDirectory = join(dir, 'public'), output = join(dir, 'output'), privateDir = join(dir, 'private');
  for (const path of [publicDirectory, output, privateDir]) await mkdir(path);
  await writeFile(join(publicDirectory, 'train.csv'), 'id,feature,target\na,0,0\nb,1,1\n');
  await writeFile(join(publicDirectory, 'test.csv'), 'id,feature\n1,0\n2,1\n');
  const targetColumns = metric === 'mean-column-wise-rmsle' ? ['a', 'b'] : ['target'];
  const expected = metric === 'mean-column-wise-rmsle' ? 'id,a,b\n1,0,1\n2,2,3\n' : 'id,target\n1,0\n2,1\n';
  const expectedPath = join(dir, 'expected.csv'); await writeFile(expectedPath, expected);
  const root = join(dir, 'hitch'), store = new ResourceStore(root, { images: new FixtureImageProvider(), limits: { minFreeBytes: 0 } });
  const captured = {};
  const rpc = async (_, operation, input) => {
    if (operation === 'import') {
      if (input.owner.endsWith(':verifier')) { await cp(input.source, privateDir, { recursive: true }); captured.private = await readFile(join(input.source, 'task.json'), 'utf8'); }
      if (input.owner.endsWith(':candidate')) { await cp(input.source, join(dir, 'candidate'), { recursive: true }); captured.candidate = input.source; }
      return store.import(input.source, input.kind, input.owner);
    }
    if (operation === 'lease-end') { await store.finishLease(input.leaseId, input.confirmation); return {}; }
    assert.equal(operation, 'seal-dataset'); captured.manifest = input.manifest;
    const tasks = [];
    for (const id of input.taskIds) tasks.push(await sealResourceTask(store, join(input.directory, id), id, input.owner));
    const body = { schema_version: '3', kind: 'gear-harbor-benchmark', resource_protocol: 'hitch-resource-lock@1', ...input.manifest, tasks };
    return parseResourceDataset({ ...body, dataset_digest: identity('hitch-resource-dataset@3', body) });
  };
  const options = { root, out: join(dir, 'dataset'), publicDirectory, instruction: 'Train a model and deliver predictions.',
    delivery: { format: 'csv', idColumn: 'id', targetColumns, predictIds: ['1', '2'], valueType: metric === 'accuracy' ? 'label' : metric === 'auc-roc' ? 'probability' : 'nonnegative', ...(metric === 'accuracy' ? { labels: ['0', '1'] } : {}) },
    evaluation: mode === 'scored' ? { mode, version: 'custom-dev-v1', metric, grader: { kind: 'builtin' } } : { mode, version: 'prediction-v1' },
    ...(mode === 'scored' ? { expected: expectedPath } : {}), baseImage: fixtureReference, platform: 'linux/amd64', timeoutSeconds: 60 };
  return { dir, publicDirectory, privateDir, output, expected, expectedPath, rpc, options, captured };
}
function verify(produced, f) {
  const verifier = join(produced.path, produced.taskId, 'tests/verify.py'), resultDir = join(f.dir, 'result');
  const result = spawnSync(python, ['-B', verifier, '--private', f.privateDir, '--output', f.output, '--result', resultDir], { encoding: 'utf8' });
  return { ...result, resultDir, detail: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}

for (const metric of ['accuracy', 'auc-roc', 'mean-column-wise-rmsle']) test(`standard resource task independently scores ${metric} without research artifacts`, async t => {
  const f = await fixture(t, 'scored', metric), produced = await produceTask(f.options, f.rpc);
  const task = join(produced.path, produced.taskId);
  const instruction = await readFile(join(task, 'instruction.md'), 'utf8');
  assert.match(instruction, /single task/); assert.match(instruction, /ordinary shell/);
  assert.doesNotMatch(instruction, /task_inspect|run_pipeline|rollout_finish|checkpoint/);
  const candidatePlan = JSON.parse(await readFile(join(f.dir, 'candidate/parameters.json')));
  assert.equal(candidatePlan.parameters.training.fit_accounting, 'observed');
  await assert.rejects(readFile(join(f.dir, 'candidate/expected.csv')), { code: 'ENOENT' });
  const lock = JSON.parse(await readFile(join(task, 'resource.lock.json')));
  assert.equal(lock.bindings.find(b => b.resource === 'verifier' && b.use === 'input-tree').consumer.role, 'verifier');
  assert.notEqual(lock.resources.verifier.manifestDigest, lock.resources.candidate.manifestDigest);
  // A plain program completes delivery; no pipeline factory, receipt, or second refit rollout.
  const script = spawnSync(python, ['-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.argv[2])', join(f.output, 'submission.csv'), f.expected]);
  assert.equal(script.status, 0);
  const result = verify(produced, f); assert.equal(result.status, 0, result.stderr);
  const rewards = JSON.parse(await readFile(join(result.resultDir, 'reward.json')));
  assert.equal(rewards.task_score, metric === 'mean-column-wise-rmsle' ? 0 : 1);
  assert.equal(rewards.quality_available, 1); assert.equal(result.detail.quality.source, 'external_verifier');
  const raw = f.captured.manifest.raw_metrics.metrics.find(m => m.id === 'task_score');
  assert.equal(raw.unit, metric); assert.equal(raw.direction, metric === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize');
  assert.equal(rewards.accuracy, undefined, 'formal metric keeps its declared name');
});

test('unlabeled delivery has no numeric quality metric and missing artifacts fail delivery', async t => {
  const f = await fixture(t, 'delivery'), produced = await produceTask(f.options, f.rpc);
  let result = verify(produced, f); assert.equal(result.status, 0);
  assert.equal(result.detail.status, 'delivery_failed');
  assert.equal(JSON.parse(await readFile(join(result.resultDir, 'reward.json'))).completed, 0);
  await writeFile(join(f.output, 'submission.csv'), f.expected);
  result = verify(produced, f); assert.equal(result.status, 0, result.stderr);
  const reward = JSON.parse(await readFile(join(result.resultDir, 'reward.json')));
  assert.equal(reward.valid_output, 1); assert.equal(reward.quality_available, 0); assert.equal(reward.task_score, undefined);
  assert.equal(result.detail.quality.status, 'unavailable');
  assert(!f.captured.manifest.raw_metrics.metrics.some(m => m.id === 'task_score' || m.id === 'accuracy'));
});

test('invalid submission differs from verifier failure and private evidence is not disclosed', async t => {
  const f = await fixture(t), produced = await produceTask(f.options, f.rpc);
  for (const content of ['id,target\n1,NaN\n2,1\n', 'id,target\n2,1\n1,0\n', 'id,target\n1,"unclosed\n']) {
    await writeFile(join(f.output, 'submission.csv'), content);
    const result = verify(produced, f); assert.equal(result.status, 0, result.stderr); assert.equal(result.detail.status, 'delivery_failed');
  }
  await writeFile(join(f.output, 'submission.csv'), f.expected);
  await writeFile(join(f.privateDir, 'expected.csv'), 'PRIVATE_CANARY_DO_NOT_LEAK');
  const result = verify(produced, f); assert.equal(result.status, 1); assert.equal(result.detail.status, 'infrastructure_error');
  await assert.rejects(readFile(join(result.resultDir, 'reward.json')), { code: 'ENOENT' });
  assert.doesNotMatch(result.stdout + result.stderr + await readFile(join(result.resultDir, 'feedback.json')), /PRIVATE_CANARY/);
});

test('unsupported hard constraints and old inputs fail before resource work', async t => {
  const f = await fixture(t); let calls = 0; const rpc = async () => { calls++; throw new Error('must not run'); };
  for (const [section, key, value] of [['training', 'max_fits', 2], ['training', 'fit_accounting', 'enforced'], ['training', 'cv_execution', 'trusted'], ['delivery', 'freeze_selection', true]]) {
    const parameters = defaultParameters(); parameters.parameters[section][key] = value;
    await assert.rejects(produceTask({ ...f.options, parameters }, rpc), /unsupported_constraint/);
    parameters.capability_requirements = [];
    await assert.rejects(produceTask({ ...f.options, parameters }, rpc), /unsupported_constraint/);
  }
  await assert.rejects(produceTask({ ...f.options, request: { protocol: 'analysis-rollout-request@2' } }, rpc), /unsupported task input/);
  await assert.rejects(produceTask({ ...f.options, evaluation: { mode: 'delivery', version: 'v1' } }, rpc), /cannot have private answers/);
  assert.equal(calls, 0);
});

test('private answers inside public inputs are rejected', async t => {
  const f = await fixture(t); await writeFile(join(f.publicDirectory, 'answers.csv'), f.expected);
  await assert.rejects(produceTask({ ...f.options, expected: join(f.publicDirectory, 'answers.csv') }, f.rpc), /private answers cannot be inside public/);
});

test('native import preserves original grader, declared description and data provenance without competition switches', async t => {
  const f = await fixture(t), repository = join(f.dir, 'repo'), dataRoot = join(f.dir, 'data'), competition = 'unseen-competition';
  const definition = join(repository, 'mlebench/competitions', competition), publicDir = join(dataRoot, competition, 'prepared/public'), privateDir = join(dataRoot, competition, 'prepared/private');
  for (const path of [definition, publicDir, privateDir]) await mkdir(path, { recursive: true });
  const inputs = { 'train.csv': 'id,feature,target\na,0,0\nb,1,1\n', 'test.csv': 'id,feature\n1,0\n2,1\n', 'sample_submission.csv': f.expected };
  for (const [name, content] of Object.entries(inputs)) await writeFile(join(publicDir, name), content);
  await writeFile(join(privateDir, 'answers.csv'), f.expected);
  await writeFile(join(definition, 'config.yaml'), `id: ${competition}\ncompetition_type: simple\ndescription: mlebench/competitions/${competition}/description.md\ndataset:\n  answers: ${competition}/prepared/private/answers.csv\n  sample_submission: ${competition}/prepared/public/sample_submission.csv\ngrader:\n  name: accuracy\n  grade_fn: mlebench.competitions.${competition}.grade:grade\n`);
  await writeFile(join(repository, 'mlebench/grade_helpers.py'), `import importlib
class Grader:
    def __init__(self, name, entrypoint):
        module, function = entrypoint.split(':')
        self.grade_fn = getattr(importlib.import_module(module), function)
    def __call__(self, submission, answers):
        return round(self.grade_fn(submission, answers), 5)
`);
  const grade = 'def grade(submission, answers):\n    return 0.375\n';
  await writeFile(join(definition, 'grade.py'), grade); await writeFile(join(definition, 'prepare.py'), '# Author-owned preparation\n');
  await writeFile(join(definition, 'description.md'), 'ORIGINAL_DESCRIPTION: Complete this prediction task.\n');
  const checksums = `public:\n${Object.entries(inputs).map(([name, content]) => `  ${name}: ${md5(content)}`).join('\n')}\nprivate:\n  answers.csv: ${md5(f.expected)}\n`;
  await writeFile(join(definition, 'checksums.yaml'), checksums);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
    const child = spawnSync('git', args, { cwd: repository, encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
  }
  const inspected = await inspectMlebench({ repository, dataRoot, competition });
  assert.equal(inspected.descriptor.competitionId, competition); assert.equal(inspected.descriptor.grader.kind, 'native');
  const produced = await importMlebench({ repository, dataRoot, competition, root: f.options.root, out: f.options.out, baseImage: fixtureReference, verifierCpus: 1, verifierMemoryMb: 256 }, f.rpc);
  assert.match(await readFile(join(produced.path, produced.taskId, 'task.toml'), 'utf8'), /\[verifier.environment\][\s\S]*?cpus = 1\nmemory_mb = 256/);
  assert.match(await readFile(join(produced.path, produced.taskId, 'instruction.md'), 'utf8'), /ORIGINAL_DESCRIPTION/);
  assert.equal(await readFile(join(f.privateDir, 'native/mlebench/competitions', competition, 'grade.py'), 'utf8'), grade);
  await assert.rejects(readFile(join(f.dir, 'candidate/mlebench/competitions', competition, 'grade.py')), { code: 'ENOENT' });
  // A tiny pandas test double proves dispatch uses the imported native function,
  // not the built-in accuracy implementation. Real native parity is a separate
  // Linux image check with pandas/sklearn installed.
  await writeFile(join(f.privateDir, 'native/pandas.py'), 'def read_csv(stream):\n    return stream.read()\n');
  await writeFile(join(f.output, 'submission.csv'), f.expected);
  const result = verify(produced, f); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(result.resultDir, 'reward.json'))).task_score, 0.375);
  await writeFile(join(publicDir, 'undeclared-answers.csv'), f.expected);
  await assert.rejects(inspectMlebench({ repository, dataRoot, competition }), /outside the declared checksums/);
  await rm(join(publicDir, 'undeclared-answers.csv'));
  const asset = 'geometry for row 1'; await mkdir(join(publicDir, 'test/1'), { recursive: true });
  await writeFile(join(publicDir, 'test/1/geometry.xyz'), asset);
  const publicAssets = [{ path: 'test/1/geometry.xyz', bytes: Buffer.byteLength(asset), digest: 'sha256:' + createHash('sha256').update(asset).digest('hex') }];
  assert.equal((await inspectMlebench({ repository, dataRoot, competition, publicAssets })).descriptor.verification, 'declared-checksums-and-assets');
  await assert.rejects(inspectMlebench({ repository, dataRoot, competition, publicAssets: [{ ...publicAssets[0], bytes: 0 }] }), /digest\/size/);
  await rm(join(publicDir, 'test'), { recursive: true });
  await writeFile(join(publicDir, 'test.csv'), 'id,feature\n1,CHANGED\n2,1\n');
  await assert.rejects(inspectMlebench({ repository, dataRoot, competition }), /checksum mismatch/);
});

test('user values and tightened policy are separately admitted and sealed before Meta', async t => {
  const f = await fixture(t), parameters = defaultParameters();
  const userParameters = structuredClone(parameters.parameters);
  userParameters.method.cv.seed = 101;
  userParameters.method.cv.folds = 4;
  const parameterPolicy = { '/method/cv/folds': { mutable: false, minimum: 3, maximum: 5 } };
  const produced = await produceTask({ ...f.options, parameters, userParameters, parameterPolicy }, f.rpc);
  const task = join(produced.path, produced.taskId), state = await admitTaskParameters(task);
  assert.equal(state.effective.method.cv.seed, 101);
  assert.equal(state.effective.method.cv.folds, 4);
  assert.equal(state.policy['/method/cv/folds'].mutable, false);
  assert(state.audit.some(row => row.actor === 'user' && row.path === '/method/cv/seed' && row.accepted));
  const bindings = JSON.parse(await readFile(join(task, 'parameter-overrides.json')));
  assert.equal(bindings.version, 1); assert.deepEqual(bindings.parameters, userParameters);
  const meta = structuredClone(userParameters); meta.method.cv.folds = 5;
  assert.throws(() => admitParameters(parameters, { user: userParameters, policy: parameterPolicy, meta }), /meta cannot change/);
  userParameters.training.max_fits = 10;
  let called = false;
  await assert.rejects(produceTask({ ...f.options, out: join(f.dir, 'hard-limit'), parameters, userParameters }, async () => { called = true; }), /unsupported_constraint/);
  assert.equal(called, false);
});

test('explicit trusted training binds installed implementation and fits all roles inside the declared total budget', async t => {
  const f = await fixture(t), coverage = 'trusted-service-top-level-attempts', parameters = defaultParameters(coverage);
  parameters.parameters.training = { max_fits: 6, fit_accounting: 'enforced', cv_execution: 'trusted' };
  parameters.parameters.delivery.freeze_selection = true;
  const baseImage = 'registry.test/runtime@sha256:6965b4ceca603f9fe9b0fd00a46bcfe8b684c2052bea79ae08a57ace0dcc7e14';
  const options = { ...f.options, baseImage, parameters, trustedTraining: { version: 1, coverage }, cpus: 3, memoryMb: 2048 };
  // This checks producer/authority admission with fixture trees. Runtime image
  // and Docker cgroup observations are exercised by the separate Linux canary.
  const rpc = async (...args) => args[1] === 'seal-dataset' ? { tasks: [{ task_digest: 'fixture' }], dataset_digest: 'fixture' } : f.rpc(...args);
  const produced = await produceTask(options, rpc), task = join(produced.path, produced.taskId);
  const state = await admitTaskParameters(task);
  assert.equal(state.bindings[0].coverage, coverage);
  assert.deepEqual(state.counters.trainer, { reserved: 0, consumed: 0, limit: 6, unit: 'trusted-service-top-level-attempt' });
  const compose = JSON.parse(await readFile(join(task, 'environment/docker-compose.yaml')));
  assert.equal(compose.services.trainer.network_mode, 'none'); assert.equal(compose.services.trainer.cpus, 1);
  assert.equal(compose.services.trainer.mem_limit, 1024 * 1024 ** 2);
  assert.equal(compose.services.trainer.volumes, undefined);
  const lock = JSON.parse(await readFile(join(task, 'resource.lock.json')));
  assert(lock.bindings.some(b => b.consumer.role === 'service' && b.consumer.serviceId === 'trainer' && b.target === 'data'));
  assert(state.contract.evaluation_inputs.includes('environment/services/trainer/runner.py'));
  await writeFile(join(task, 'environment/services/trainer/runner.py'), '# untrusted replacement');
  await assert.rejects(admitTaskParameters(task), /trusted capability source differs/);
  await assert.rejects(produceTask({ ...options, out: join(f.dir, 'invalid-budget'), cpus: 2 }, rpc), /total budget/);
  const broad = defaultParameters(); broad.parameters.training.max_fits = 6;
  await assert.rejects(produceTask({ ...options, out: join(f.dir, 'invalid-coverage'), parameters: broad }, rpc), /unsupported_constraint/);
});


test('ordinary task declares independent verifier resources and rejects invalid budgets before import', async t => {
  const f = await fixture(t);
  const produced = await produceTask({ ...f.options, cpus: 1, memoryMb: 1024, verifierCpus: 1, verifierMemoryMb: 256, timeoutSeconds: 3600 }, f.rpc);
  const task = join(produced.path, produced.taskId);
  const toml = await readFile(join(task, 'task.toml'), 'utf8');
  assert.match(toml, /\[environment\][\s\S]*?cpus = 1\nmemory_mb = 1024/);
  assert.match(toml, /\[verifier.environment\][\s\S]*?cpus = 1\nmemory_mb = 256/);
  assert.match(toml, /timeout_sec = 3600/);
  const descriptor = JSON.parse(await readFile(join(task, 'task-contract.json')));
  assert.equal(descriptor.runtime.verifierMemoryMb, 256);
  assert.equal(descriptor.runtime.verifierCpus, 1);
  for (const override of [{ verifierMemoryMb: 127 }, { verifierMemoryMb: 0 }, { verifierCpus: 0 }, { verifierCpus: 0.5 }]) {
    let called = false;
    await assert.rejects(produceTask({ ...f.options, ...override, out: join(f.dir, 'invalid-budget') }, async () => { called = true; }), /invalid verifier resource limits/);
    assert.equal(called, false);
  }
  const flags = parseArgs(['--config', 'task.json', '--out', 'dataset', '--root', 'state', '--cpus', '1', '--memory-mb', '1024', '--verifier-cpus', '1', '--verifier-memory-mb', '256']);
  assert.equal(flags.memoryMb, 1024); assert.equal(flags.verifierMemoryMb, 256); assert.equal(flags.verifierCpus, 1);
});

test('trusted trainer allocation subtracts the explicitly configured verifier budget', async t => {
  const f = await fixture(t), coverage = 'trusted-service-top-level-attempts';
  const baseImage = 'registry.test/runtime@sha256:6965b4ceca603f9fe9b0fd00a46bcfe8b684c2052bea79ae08a57ace0dcc7e14';
  const rpc = async (...args) => args[1] === 'seal-dataset' ? { tasks: [{ task_digest: 'fixture' }], dataset_digest: 'fixture' } : f.rpc(...args);
  const produced = await produceTask({ ...f.options, baseImage, trustedTraining: { version: 1, coverage }, cpus: 4, memoryMb: 2048, verifierCpus: 2, verifierMemoryMb: 256 }, rpc);
  const task = join(produced.path, produced.taskId), compose = JSON.parse(await readFile(join(task, 'environment/docker-compose.yaml')));
  assert.equal(compose.services.trainer.cpus, 1);
  assert.equal(compose.services.trainer.mem_limit, 1280 * 1024 ** 2);
  const state = await admitTaskParameters(task);
  assert.deepEqual(state.bindings[0].resource_budget, { cpu_millis: 4000, memory_bytes: 2048 * 1024 ** 2 });
});
