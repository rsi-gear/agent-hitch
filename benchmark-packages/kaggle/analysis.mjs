// Ordinary resource-v2 task producer for one experiment or sealed execution.
import { mkdir, copyFile, readFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { validateSchema, validateRequest } from './analysis-contracts/schemas.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const sha = x => `sha256:${createHash('sha256').update(x).digest('hex')}`;

/** Private inputs are imported separately and never copied into candidate trees. */
export async function produceAnalysisTask(options, resourceRequest) {
  const { root, out, candidate, expected, baseImage, platform, request, timeoutSeconds } = options;
  validateRequest(request);
  validateSchema('Task', request.task);
  if (request.solution) validateSchema('Solution', request.solution);
  if (['analysis-rollout-request@1', 'analysis-rollout-request@2'].includes(request.protocol)) validateSchema('Checkpoint', JSON.parse(await readFile(join(candidate, 'checkpoint.json'), 'utf8')));
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(baseImage) || !/^linux\/(amd64|arm64)$/.test(platform)
    || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('pinned runtime and bounded timeout required');
  resourceRequest ??= (await import('agent-hitch/resources')).resourceRequest;
  const id = `analysis-${request.digest.slice(7, 31)}`, research = ['analysis-rollout-request@1', 'analysis-rollout-request@2'].includes(request.protocol);
  const staging = `${out}.partial-${randomUUID()}`, temporary = await mkdtemp(join(tmpdir(), 'analysis-private-'));
  const leases = [], owner = `producer:analysis:${request.digest}:${randomUUID()}`;
  const revision = sha(Buffer.concat(await Promise.all(['analysis-verify.py', 'scoring.py'].map(name => readFile(join(here, 'runtime', name))))));
  try {
    await writeFile(join(temporary, 'request.json'), JSON.stringify(request));
    if (expected) await copyFile(expected, join(temporary, 'expected.csv'));
    const resources = { runtime: { kind: 'oci-image', manifestDigest: baseImage.split('@')[1], platform } }, bindings = [];
    for (const [role, source] of [['candidate', candidate], ['verifier', temporary]]) {
      const imported = await resourceRequest(root, 'import', { kind: 'tree', source, owner: `${owner}:${role}` });
      leases.push(imported.leaseId); resources[role] = imported.resource;
      bindings.push({ resource: role, consumer: { role }, use: 'input-tree', target: role === 'candidate' ? 'data' : 'private', access: 'private-copy' });
      bindings.push({ resource: 'runtime', consumer: { role }, use: 'environment-image', slot: 'build-base' });
    }
    const task = join(staging, id);
    await mkdir(join(task, 'environment/candidate'), { recursive: true }); await mkdir(join(task, 'tests'));
    await writeFile(join(task, 'resource.lock.json'), JSON.stringify({ protocol: 'hitch-resource-lock@1', resources, bindings,
      requiredCapabilities: ['tree@1', 'oci-image@1', 'private-copy@1', 'harbor-role-context@1', 'bounded-tmpfs@1'] }));
    await writeFile(join(task, 'instruction.md'), research
      ? 'Complete exactly one experiment. Call task_inspect, follow its policy and guidance, evaluate or reuse one solution, select, and finish. All prior facts are explicitly provided in the checkpoint. Never search the network or estimate external labels.\n'
      : 'Execute the sealed solution and write its exact predictions. No model session or source changes are permitted.\n');
    await writeFile(join(task, 'environment/docker-compose.yaml'), JSON.stringify({ services: { main: {
      platform, build: { context: 'candidate', dockerfile: 'Dockerfile' }, user: '0:0', init: true,
      tmpfs: ['/opt/kaggle-runtime/work:size=1073741824,mode=755', '/run:size=134217728,mode=755'],
    } } }));
    await writeFile(join(task, 'environment/candidate/Dockerfile'), `FROM ${baseImage}\nCOPY data /data\nRUN --network=none mkdir -p /app /output && chmod 700 /output && chmod -R a-w /data\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
    await writeFile(join(task, 'tests/Dockerfile'), `FROM ${baseImage}\nCOPY . /tests\nWORKDIR /tests\nCMD ["sleep", "infinity"]\n`);
    await copyFile(join(here, 'runtime/analysis-verify.py'), join(task, 'tests/verify.py'));
    await copyFile(join(here, 'runtime/scoring.py'), join(task, 'tests/scoring.py'));
    await writeFile(join(task, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py\n', { mode: 0o755 });
    await writeFile(join(task, 'task.toml'), `schema_version = "1.4"\nartifacts = [{ source = "/output" }]\n[environment]\nworkdir = "/app"\nnetwork_mode = "${research ? 'public' : 'no-network'}"\ncpus = 2\nmemory_mb = 4096\n[agent]\ntimeout_sec = ${timeoutSeconds}\n[verifier]\ntimeout_sec = 60\nenvironment_mode = "separate"\n[verifier.environment]\nnetwork_mode = "no-network"\ncpus = 1\nmemory_mb = 512\n`);
    const generic = request.task.protocol !== 'analysis-task@1';
    const metrics = ['valid_output', 'completed', ...(!research && expected ? [generic ? 'task_score' : 'accuracy'] : [])].map(metric => ({ id: metric,
      revision, unit: metric === 'task_score' ? request.task.prediction.metric : 'ratio',
      direction: metric === 'task_score' && request.task.prediction.metric === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize',
      ...(metric === 'task_score' && request.task.prediction.metric === 'mean-column-wise-rmsle' ? {} : { range: { min: 0, max: 1 } }), granularity: 'trial', repetitionReducer: 'mean',
      taskReducer: 'weighted-mean', comparisonPrecision: 1e-9, source: { path: `verifier.result.rewards.${metric}`, extractor: 'number-v1' } }));
    const manifest = await resourceRequest(root, 'seal-dataset', { directory: staging, owner, taskIds: [id], manifest: {
      benchmark: { id: 'analysis-single-step', revision: request.digest },
      adapter: { id: 'analysis-tabular', revision, output_protocol: 'gear-harbor-eval-result-v1' },
      scoring: { total_score: { source_metric: 'total_score', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } },
      raw_metrics: { schema_version: '1', metrics },
      execution: { backend: 'harbor-role-context@1', resolver: 'hitch-resource-resolver@1', platform }, required_capabilities: ['harbor-role-context@1', 'bounded-tmpfs@1'],
    } });
    await rename(staging, out);
    return { path: out, taskId: id, taskDigest: manifest.tasks[0].task_digest, datasetDigest: manifest.dataset_digest };
  } finally {
    const results = await Promise.allSettled(leases.map(leaseId => resourceRequest(root, 'lease-end', { leaseId, confirmation: 'ended' })));
    await rm(temporary, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true });
    if (results.some(r => r.status === 'rejected')) process.stderr.write('Analysis input leases remain retained after release failure.\n');
  }
}
