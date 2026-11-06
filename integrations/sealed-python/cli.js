#!/usr/bin/env node
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_MANIFEST_DIGEST = 'sha256:e2007fa9c7423c9f8dee4ffe61474d3767e503ca5b706bc37ee87cf0aa0018e1';
const sha = b => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => sha(canonical(value));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function regular(path, limit = 16 * 1024 ** 2) { const s = await lstat(path); assert(s.isFile() && s.nlink === 1 && s.size <= limit, 'expected bounded regular input'); return readFile(path); }
function verify(value) { const { digest: expected, ...body } = value; assert(digest(body) === expected, 'sealed input changed'); return value; }

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--version') { console.log('hitch-sealed-python 1'); return; }
  assert(process.argv.length === 2, 'sealed executor accepts no command overrides');
  const runtimeManifest = await regular(join(here, 'runtime-integrity.json'));
  assert(sha(runtimeManifest) === RUNTIME_MANIFEST_DIGEST, 'fixed runtime manifest changed');
  const expected = JSON.parse(runtimeManifest);
  for (const [path, hash] of Object.entries(expected)) assert(sha(await regular(join(here, path))) === hash, 'fixed worker changed');
  const request = verify(JSON.parse(await regular('/data/request.json')));
  assert(['analysis-delivery-request@1', 'analysis-audit-request@1', 'analysis-refit-request@1'].includes(request.protocol), 'not a sealed execution request');
  const solution = verify(request.solution);
  assert(solution.protocol === 'analysis-solution@1' && solution.runtimeDigest === request.runtimeDigest, 'solution runtime mismatch');
  const files = {};
  for (const f of solution.files) {
    assert(/^[a-zA-Z0-9_./-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe source path');
    assert(/^sha256:[a-f0-9]{64}$/.test(f.digest) && !files[f.path], 'invalid source closure');
    const path = `/data/objects/${f.digest.slice(7)}`, bytes = await regular(path);
    assert(sha(bytes) === f.digest && bytes.length === f.bytes, 'source digest mismatch'); files[f.path] = path;
  }
  assert(files[solution.entrypoint] && solution.entrypoint.endsWith('.py'), 'missing solution entrypoint');
  for (const name of ['train', 'predict']) assert(sha(await regular(`/data/${name}.csv`, 1024 ** 3)) === request.task.inputs[`${name}Digest`], 'data input changed');
  assert(/^run_[a-f0-9]{32}$/.test(process.env.HITCH_RUN_ID ?? ''), 'assigned run ID required');
  await mkdir('/run/analysis-refit', { recursive: true }); await mkdir('/output', { recursive: true });
  const generic = request.task.prediction.kind === 'tabular';
  const job = { operation: generic ? 'predict' : 'script', files,
    ...(generic ? { prediction: request.task.prediction, predictIds: request.task.predictIds, publicFiles: request.task.publicFiles, publicDirectory: '/data/public' } : {}), inputs: { 'train.csv': '/data/train.csv', 'predict.csv': '/data/predict.csv' },
    entrypoint: solution.entrypoint, argv: ['--train', '/work/inputs/train.csv', '--predict', '/work/inputs/predict.csv',
      '--output', '/work/scratch/predictions.csv', '--seed', String(solution.trainingSeed)],
    outputDirectory: '/run/analysis-refit/results', wallSeconds: Math.min(300, request.allowance.wallSeconds),
    cpuSeconds: Math.min(600, request.allowance.cpuSeconds) };
  await writeFile('/run/analysis-refit/job.json', JSON.stringify(job));
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/local/bin/python3', ['-B', join(here, 'worker.py'), '--job', '/run/analysis-refit/job.json'],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const abort = () => child.kill('SIGTERM'); process.once('SIGTERM', abort); process.once('SIGINT', abort);
    child.stdout.on('data', data => { out += data; if (out.length > 1024 ** 2) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { err = (err + data).slice(-2000); });
    child.once('error', reject); child.once('close', code => {
      process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
      if (code) reject(new Error(`fixed execution failed (${code}): ${err}`));
      else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
    });
  });
  let predictionsDigest = null;
  if (result.exitCode === 0 && !result.limit && result.outputFiles.includes('predictions.csv')) {
    const bytes = await regular('/run/analysis-refit/results/predictions.csv');
    predictionsDigest = sha(bytes); await writeFile('/output/predictions.csv', bytes, { flag: 'wx', mode: 0o444 });
  }
  const body = { protocol: 'analysis-execution-receipt@1', requestDigest: request.digest, solutionDigest: solution.digest,
    runId: process.env.HITCH_RUN_ID, status: predictionsDigest ? 'completed' : 'candidate_failed',
    predictionsDigest, modelRequests: 0, cpuSeconds: result.cpuSeconds, wallSeconds: result.wallSeconds, diagnostics: result.logs };
  await writeFile('/output/receipt.json', JSON.stringify({ ...body, digest: digest(body) }), { flag: 'wx', mode: 0o444 });
  console.log(JSON.stringify({ type: 'message.completed', text: `sealed execution: ${body.status}` }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
