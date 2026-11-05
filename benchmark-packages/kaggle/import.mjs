#!/usr/bin/env node
// Public-resource-API producer. No evaluator special cases or private state reads.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEPENDENCIES = { numpy: '1.26.4', pandas: '2.2.3', 'scikit-learn': '1.5.2' };
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function parseArgs(argv) {
  const args = [...argv];
  const take = name => { const i = args.indexOf(name); if (i < 0) return undefined; if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`missing value: ${name}`); return args.splice(i, 2)[1]; };
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const config = { source: take('--source'), out: take('--out'), root: take('--root'), baseImage: take('--base-image'),
    platform: take('--platform') ?? 'linux/amd64', python: take('--python') ?? 'python3',
    seed: Number(take('--seed') ?? 42), folds: Number(take('--folds') ?? 5), holdoutFraction: Number(take('--holdout-fraction') ?? 0.2),
    timeoutSec: Number(take('--timeout-sec') ?? 300), synthetic: flag('--synthetic') };
  if (args.length || !config.source || !config.out || !config.root || !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(config.baseImage ?? '')
    || !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(config.platform)
    || !Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 2 ** 32 - 1
    || !Number.isInteger(config.folds) || config.folds < 2 || config.folds > 10
    || !Number.isFinite(config.holdoutFraction) || config.holdoutFraction <= 0 || config.holdoutFraction >= .5
    || !Number.isInteger(config.timeoutSec) || config.timeoutSec < 1 || config.timeoutSec > 3600) {
    throw new Error('Usage: import.mjs --source CSV_DIRECTORY --out NEW_DIRECTORY --root HITCH_ROOT --base-image PINNED_RUNTIME_IMAGE [--platform linux/amd64] [--seed 42] [--folds 5] [--holdout-fraction 0.2] [--timeout-sec 300] [--python python3] [--synthetic]');
  }
  return config;
}

export function rawMetrics(revision, finalization = false) {
  const common = { revision, unit: 'ratio', direction: 'maximize', range: { min: 0, max: 1 }, granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 };
  return { schema_version: '1', metrics: [
    ...(!finalization ? [{ ...common, id: 'accuracy', source: { path: 'verifier.result.rewards.accuracy', extractor: 'number-v1' } }] : []),
    { ...common, id: 'valid_output', source: { path: 'verifier.result.rewards.valid_output', extractor: 'number-v1' } },
    { ...common, id: 'pass_rate', source: { path: 'verifier.result.rewards.completed', extractor: 'equals-v1', equals: 1 } },
  ] };
}

async function command(executable, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exceeded = false;
    const collect = stream => chunk => { if (stream === 'stdout') stdout += chunk; else stderr += chunk; if (stdout.length + stderr.length > 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', reject); child.on('close', code => code === 0 && !exceeded ? resolve(stdout) : reject(new Error(`data preparation failed (${code}): ${stderr.slice(-4000)}`)));
  });
}

/** request override is used by deterministic contract tests; production always uses the public API. */
export async function importCompetition(options, request) {
  const config = parseArgs(['--source', options.source, '--out', options.out, '--root', options.root, '--base-image', options.baseImage,
    '--platform', options.platform ?? 'linux/amd64', '--python', options.python ?? 'python3', '--seed', String(options.seed ?? 42), '--folds', String(options.folds ?? 5),
    '--holdout-fraction', String(options.holdoutFraction ?? .2), '--timeout-sec', String(options.timeoutSec ?? 300), ...(options.synthetic ? ['--synthetic'] : [])]);
  request ??= (await import('agent-hitch/resources')).resourceRequest;
  const output = path.resolve(config.out), root = path.resolve(config.root);
  if (await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; })) throw new Error('output already exists');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hitch-kaggle-'));
  const staging = `${output}.partial-${randomUUID()}`;
  const leases = [];
  try {
    const preparedRoot = path.join(temporary, 'prepared');
    await command(config.python, [path.join(here, 'prepare.py'), '--source', path.resolve(config.source), '--out', preparedRoot,
      '--seed', String(config.seed), '--folds', String(config.folds), '--holdout-fraction', String(config.holdoutFraction),
      '--timeout-sec', String(config.timeoutSec), ...(config.synthetic ? ['--synthetic'] : [])]);
    const prepared = JSON.parse(await readFile(path.join(preparedRoot, 'prepared.json'), 'utf8'));
    const sourceNames = ['import.mjs', 'prepare.py', 'runtime/verify.py', 'runtime/requirements.txt', 'runtime/Dockerfile'];
    const sourceDigests = Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha(await readFile(path.join(here, name)))])));
    const adapterRevision = sha(canonical(sourceDigests));
    const competitionBody = { ...prepared, adapter_revision: adapterRevision, producer_sources: sourceDigests,
      runtime: { image: config.baseImage, platform: config.platform, python: '>=3.10', dependencies: DEPENDENCIES,
        cpus: 2, memory_mb: 2048, task_timeout_sec: config.timeoutSec, artifact_max_file_bytes: 16 * 1024 ** 2, artifact_max_total_bytes: 64 * 1024 ** 2 } };
    const competition = { ...competitionBody, digest: sha(canonical(competitionBody)) };
    // A failed import may leave conservative pins. Different inputs must not
    // collide with those pins when the user retries the same destination.
    const owner = `producer:kaggle:${output}:${competition.digest}`;
    await mkdir(path.dirname(output), { recursive: true }); await mkdir(staging, { mode: 0o700 });
    await writeFile(path.join(staging, 'competition.json'), `${JSON.stringify(competition, null, 2)}\n`, { mode: 0o600 });
    const image = { kind: 'oci-image', manifestDigest: config.baseImage.split('@')[1], platform: config.platform };
    const datasets = {};
    for (const partition of ['seed', 'held-out', 'finalization']) {
      const dataset = path.join(staging, partition); await mkdir(dataset);
      const tasks = prepared.tasks.filter(task => task.partition === partition);
      for (const task of tasks) {
        const directory = path.join(dataset, task.task_id);
        await mkdir(path.join(directory, 'environment/candidate'), { recursive: true }); await mkdir(path.join(directory, 'tests'));
        const resources = { runtime: image };
        const bindings = [];
        for (const role of ['candidate', 'verifier']) {
          const imported = await request(root, 'import', { source: path.join(preparedRoot, partition, task.task_id, role), kind: 'tree', owner: `${owner}:${task.task_id}:${role}` });
          leases.push(imported.leaseId); resources[role] = imported.resource;
          bindings.push({ resource: role, consumer: { role }, use: 'input-tree', target: role === 'candidate' ? 'data' : 'private', access: 'private-copy' });
          bindings.push({ resource: 'runtime', consumer: { role }, use: 'environment-image', slot: 'build-base' });
        }
        await writeFile(path.join(directory, 'resource.lock.json'), `${JSON.stringify({ protocol: 'hitch-resource-lock@1', resources, bindings, requiredCapabilities: ['tree@1', 'oci-image@1', 'private-copy@1', 'harbor-role-context@1'] }, null, 2)}\n`);
        await writeFile(path.join(directory, 'instruction.md'), 'Call run_pipeline once with no arguments. It trains the sealed pipeline on the task-provided training rows and writes predictions and its execution receipt. Do not modify source, inputs, or the output files. Report the tool result.\n');
        await writeFile(path.join(directory, 'environment/docker-compose.yaml'), JSON.stringify({ services: { main: { platform: config.platform, build: { context: 'candidate', dockerfile: 'Dockerfile' }, user: '0:0', init: true } } }, null, 2));
        const checkRuntime = "import sys,pathlib,ctypes,numpy,pandas,sklearn; assert sys.version_info >= (3,10); assert (numpy.__version__,pandas.__version__,sklearn.__version__)==('1.26.4','2.2.3','1.5.2'); assert pathlib.Path('/opt/kaggle-runtime').is_dir(); ctypes.CDLL('libseccomp.so.2')";
        await writeFile(path.join(directory, 'environment/candidate/Dockerfile'), `FROM ${config.baseImage}\nCOPY data /data\nRUN --network=none python3 -c "${checkRuntime}"\nRUN --network=none mkdir -p /app /output && chmod 700 /output && chmod -R a-w /data\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
        await writeFile(path.join(directory, 'tests/Dockerfile'), `FROM ${config.baseImage}\nCOPY . /tests\nWORKDIR /tests\nCMD ["sleep", "infinity"]\n`);
        await copyFile(path.join(here, 'runtime/verify.py'), path.join(directory, 'tests/verify.py'));
        await writeFile(path.join(directory, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py --private /tests/private --predictions /output --result /logs/verifier\n', { mode: 0o755 });
        // The trusted DSH runtime needs model egress; the candidate Python
        // subprocess is separately confined with chroot/UID/seccomp by its carrier.
        await writeFile(path.join(directory, 'task.toml'), `schema_version = "1.4"\nartifacts = [{ source = "/output/predictions.csv" }, { source = "/output/receipt.json" }]\n[environment]\nworkdir = "/app"\nnetwork_mode = "public"\ncpus = 2\nmemory_mb = 2048\n[agent]\ntimeout_sec = ${config.timeoutSec + 120}\n[verifier]\ntimeout_sec = 60\nenvironment_mode = "separate"\n[verifier.environment]\nnetwork_mode = "no-network"\ncpus = 1\nmemory_mb = 512\n`);
      }
      const manifest = await request(root, 'seal-dataset', { directory: dataset, owner: `${owner}:${partition}`, taskIds: tasks.map(task => task.task_id), manifest: {
        benchmark: { id: `${prepared.competition}-${partition}`, revision: competition.digest },
        adapter: { id: 'kaggle-tabular', revision: adapterRevision, output_protocol: 'gear-harbor-eval-result-v1' },
        scoring: { total_score: { source_metric: 'total_score', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } },
        raw_metrics: rawMetrics(adapterRevision, partition === 'finalization'),
        execution: { backend: 'harbor-role-context@1', resolver: 'hitch-resource-resolver@1', platform: config.platform }, required_capabilities: ['harbor-role-context@1'],
      } });
      datasets[partition] = { path: partition, digest: manifest.dataset_digest };
    }
    const result = { schema_version: '1', competition_digest: competition.digest, datasets };
    await writeFile(path.join(staging, 'import.json'), `${JSON.stringify(result, null, 2)}\n`);
    await rename(staging, output);
    return { competition: path.join(output, 'competition.json'), competitionDigest: competition.digest,
      seed: path.join(output, 'seed'), heldOut: path.join(output, 'held-out'), finalization: path.join(output, 'finalization'), datasets };
  } finally {
    // Imports are pinned by each sealed task; release temporary import leases even on failure.
    const ended = await Promise.allSettled(leases.map(leaseId => request(root, 'lease-end', { leaseId, confirmation: 'ended' })));
    await rm(temporary, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true });
    const failures = ended.filter(result => result.status === 'rejected');
    if (failures.length) process.stderr.write(`Warning: ${failures.length} resource import leases could not be released; they remain retained.\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  importCompetition(parseArgs(process.argv.slice(2))).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
