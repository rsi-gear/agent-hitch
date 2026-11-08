import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/foundation/index.js';

const publicEntry: string = 'agent-hitch/analysis';
const analysis = await import(publicEntry);

test('public analysis runtime rejects drift, tampering and overwriting an existing carrier', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hitch-analysis-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await analysis.describeAnalysisRuntime();
  const destination = path.join(root, 'runtime');
  await assert.rejects(analysis.materializeAnalysisRuntime(destination, { expectedDigest: 'sha256:' + '0'.repeat(64) }), /frozen binding/);
  assert.deepEqual(await analysis.materializeAnalysisRuntime(destination, { expectedDigest: descriptor.digest }), descriptor);
  assert.deepEqual(await analysis.verifyAnalysisRuntime(destination, descriptor), descriptor);
  await assert.rejects(analysis.materializeAnalysisRuntime(destination), /already exists/);
  const worker = path.join(destination, 'worker.py');
  await chmod(worker, 0o600);
  await writeFile(worker, 'raise RuntimeError("tampered")\n');
  await assert.rejects(analysis.verifyAnalysisRuntime(destination, descriptor), /runtime changed/);
  await assert.rejects(analysis.readAnalysisContract('../runtime/scoring.py'), /unknown/);
});

test('installed analysis assets produce a self-contained exact Git executor and runnable client', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'hitch-analysis-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = await analysis.describeAnalysisRuntime();
  const executor = await analysis.materializeAnalysisExecutor(path.join(root, 'executor'), { expectedDigest: descriptor.digest });
  assert.match(executor.commit, /^[a-f0-9]{40,64}$/);
  assert.equal((await runCommand('git', ['status', '--porcelain'], { cwd: executor.repository })).stdout, '');
  const entry = path.join(executor.repository, 'integrations/sealed-python/cli.js');
  assert.match((await runCommand(process.execPath, [entry, '--version'])).stdout, /hitch-sealed-python/);
  await analysis.verifyAnalysisRuntime(path.join(executor.repository, 'integrations/analysis-runtime'), descriptor);
  const client = await analysis.materializeAnalysisClient(path.join(root, 'bin/hitch.mjs'));
  assert.match((await runCommand(client, ['--version'])).stdout, /\d+\.\d+\.\d+/);
  const schema = JSON.parse((await analysis.readAnalysisContract('analysis.schema.json')).toString());
  assert.deepEqual(schema, analysis.schema);
  const golden = JSON.parse((await analysis.readAnalysisContract('golden.json')).toString());
  analysis.validateSchema('Task', golden.task);
  assert.equal((await readFile(path.join(executor.repository, 'package.json'), 'utf8')).includes('"type":"module"'), true);
});
