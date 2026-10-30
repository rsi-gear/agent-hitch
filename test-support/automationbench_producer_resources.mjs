// Run both real producer entrypoints against deterministic Git/Docker/resource
// transport fixtures. Filesystem export and task/dataset sealing are real.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBenchmarkAdapterManifest } from 'agent-hitch/evals';
import { hash, identity } from 'agent-hitch/resources';

const root = await mkdtemp(path.join(os.tmpdir(), 'hitch-ab-producer-resources-'));
const repo = process.cwd(), reference = 'a'.repeat(40), domains = ['marketing', 'sales', 'support'];
const json = async (file, value) => writeFile(file, JSON.stringify(value, null, 2));
const read = async file => JSON.parse(await readFile(file, 'utf8'));
try {
  const producer = path.join(root, 'producer'), bin = path.join(root, 'bin');
  await cp(path.join(repo, 'benchmark-packages/automationbench'), producer, { recursive: true });
  await mkdir(bin);
  const shim = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), executable=path.basename(process.argv[1]);
if(executable==='git') {
 if(args[0]==='clone') { fs.mkdirSync(args.at(-1),{recursive:true}); fs.writeFileSync(path.join(args.at(-1),'LICENSE'),'fixture license'); }
 if(args.includes('rev-parse')) console.log(${JSON.stringify(reference)});
} else if(args.includes('/runtime/export.py')) {
 const output=args[args.indexOf('-v')+1].split(':')[0];
 const rows=${JSON.stringify(domains)}.map(domain=>({id:domain+'.sample',tools:[],contract_sha256:'f'.repeat(64),row:{prompt:[{role:'user',content:'fixture '+domain}],example_id:domain}}));
 fs.writeFileSync(path.join(output,'tasks.json'),JSON.stringify(rows));
} else if(args.includes('cat')) console.log(fs.readFileSync(process.env.HITCH_FIXTURE_RECIPE,'utf8'));
`;
  for (const name of ['git', 'docker']) await writeFile(path.join(bin, name), shim, { mode: 0o755 });
  await json(path.join(bin, 'package.json'), { type: 'module' });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const run = (script, args, extra = {}) => {
    const result = spawnSync(process.execPath, [path.join(producer, script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  const v4 = path.join(root, 'v4');
  run('import.mjs', ['--source', 'fixture', '--ref', reference, '--out', v4, ...domains.flatMap(domain => ['--task', domain + '.sample'])]);
  const original = await read(path.join(v4, 'benchmark.adapter.json'));
  for (const domain of domains) {
    const compose = await read(path.join(v4, domain + '-sample/environment/docker-compose.yaml'));
    assert.equal(compose.services.simulator.cpus, 1);
    assert.equal(compose.services.simulator.mem_limit, '1024m');
  }
  // Simulate a verified historical v4 dataset: missing limits, alternate
  // explicit deploy limits, and explicit top-level limits in three domains.
  const legacy = path.join(root, 'legacy');
  await cp(v4, legacy, { recursive: true });
  for (const domain of domains) {
    const file = path.join(legacy, domain + '-sample/environment/docker-compose.yaml');
    const compose = await read(file), simulator = compose.services.simulator;
    delete simulator.cpus; delete simulator.mem_limit;
    if (domain === 'sales') simulator.deploy = { resources: { limits: { cpus: '2.0', memory: '2048m' } } };
    if (domain === 'support') Object.assign(simulator, { cpus: 3, mem_limit: '3072m' });
    await json(file, compose);
  }
  const old = await buildBenchmarkAdapterManifest({ dataset: legacy, benchmark: original.benchmark,
    adapter: original.adapter, scoring: original.scoring, taskIds: original.tasks.map(task => task.task_id) });
  await json(path.join(legacy, 'benchmark.adapter.json'), old);
  assert.notEqual(original.dataset_digest, old.dataset_digest);
  for (const entry of original.tasks) assert.notEqual(entry.task_digest, old.tasks.find(task => task.task_id === entry.task_id).task_digest);

  const entries = [];
  async function visit(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const relative = prefix ? prefix + '/' + name : name;
      if (relative === 'task.json') continue;
      const file = path.join(directory, name), info = await stat(file);
      if (info.isDirectory()) { entries.push({ path: relative, kind: 'directory' }); await visit(file, relative); }
      else entries.push({ path: relative, kind: 'file', size: info.size, executable: Boolean(info.mode & 0o111), digest: hash(await readFile(file)) });
    }
  }
  await visit(path.join(legacy, 'marketing-sample/tests/runtime'));
  const treeFile = path.join(root, 'tree.json'), recipeFile = path.join(root, 'recipe.json');
  await json(treeFile, { entries });
  const recipeBody = { protocol: 'automationbench-runtime-recipe@1', source: { kind: 'tree', manifestDigest: 'sha256:' + 'b'.repeat(64) }, dockerfileDigest: 'sha256:' + 'c'.repeat(64), upstreamRevision: reference, platform: 'linux/amd64' };
  await json(recipeFile, { ...recipeBody, digest: identity(recipeBody.protocol, recipeBody) });
  // Only transport/image prerequisites are fixtures. The public manifest
  // implementation performs real content-addressed sealing for both exports.
  const packageDir = path.join(root, 'node_modules/agent-hitch');
  await mkdir(packageDir, { recursive: true });
  await json(path.join(packageDir, 'package.json'), { type: 'module', exports: { './evals': './evals.mjs', './resources': './resources.mjs' } });
  const evals = pathToFileURL(path.join(repo, 'dist/src/evals/index.js')).href;
  const resources = pathToFileURL(path.join(repo, 'dist/src/resources/index.js')).href;
  await writeFile(path.join(packageDir, 'evals.mjs'), `export { buildBenchmarkAdapterManifest } from ${JSON.stringify(evals)};`);
  await writeFile(path.join(packageDir, 'resources.mjs'), `
export { hash, identity } from ${JSON.stringify(resources)};
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildBenchmarkAdapterManifest } from ${JSON.stringify(evals)};
export async function configuredResourceStore() { return {store:{objects:{readTree:async()=>JSON.parse(await readFile(process.env.HITCH_FIXTURE_TREE,'utf8'))}}}; }
export async function resourceRequest(_root, action, input) {
 if(action!=='seal-dataset') throw new Error('unexpected resource action');
 const manifest=await buildBenchmarkAdapterManifest({...input.manifest,dataset:input.directory,taskIds:input.taskIds});
 await writeFile(path.join(input.directory,'benchmark.adapter.json'),JSON.stringify(manifest)); return manifest;
}
`);
  const v5 = path.join(root, 'v5');
  run('resources.mjs', ['import', '--legacy', legacy, '--out', v5, '--root', root, '--recipe', recipeFile,
    '--runtime-image', 'fixture/runtime@sha256:' + 'd'.repeat(64), '--candidate-image', 'fixture/python@sha256:' + 'e'.repeat(64)],
    { HITCH_FIXTURE_RECIPE: recipeFile, HITCH_FIXTURE_TREE: treeFile });
  const next = await read(path.join(v5, 'benchmark.adapter.json'));
  assert.notEqual(next.dataset_digest, old.dataset_digest);
  for (const domain of domains) {
    const before = await read(path.join(legacy, domain + '-sample/environment/docker-compose.yaml'));
    const after = await read(path.join(v5, domain + '-sample/environment/docker-compose.yaml'));
    const simulator = after.services.simulator;
    if (domain === 'marketing') { assert.equal(simulator.cpus, 1); assert.equal(simulator.mem_limit, '1024m'); assert.equal(before.services.simulator.cpus, undefined); }
    if (domain === 'sales') { assert.deepEqual(simulator.deploy, before.services.simulator.deploy); assert.equal(simulator.cpus, undefined); assert.equal(simulator.mem_limit, undefined); }
    if (domain === 'support') { assert.equal(simulator.cpus, 3); assert.equal(simulator.mem_limit, '3072m'); }
    assert.notEqual(next.tasks.find(task => task.task_id === domain + '-sample').task_digest, old.tasks.find(task => task.task_id === domain + '-sample').task_digest);
  }
  assert.deepEqual(await read(path.join(legacy, 'benchmark.adapter.json')), old);
  console.log('AutomationBench v4/v5 generic simulator resources and export identities passed');
} finally { await rm(root, { recursive: true, force: true }); }
