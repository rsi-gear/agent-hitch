#!/usr/bin/env node
// Opt-in v5 adapter over an explicitly selected v4 package. Uses public APIs only.
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBenchmarkAdapterManifest } from 'agent-hitch/evals';
import { hash, identity, resourceRequest, configuredResourceStore } from 'agent-hitch/resources';
const args = process.argv.slice(2), action = args.shift();
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const legacy = option('--legacy'), output = option('--out'), root = option('--root'), image = option('--runtime-image'), candidateBase = option('--candidate-image'), recipeFile = option('--recipe');
const selected = []; while (args.includes('--task')) selected.push(option('--task'));
if (args.length || !['prepare-runtime', 'import'].includes(action) || !legacy || !output || !root) throw new Error('Usage: resources.mjs prepare-runtime|import --legacy V4_DATASET --out NEW_DIRECTORY --root HITCH_ROOT [--task ID] [--runtime-image DIGEST_REF --candidate-image DIGEST_REF --recipe RECIPE_JSON]');
const old = JSON.parse(await readFile(path.join(legacy, 'benchmark.adapter.json'), 'utf8'));
if (old.schema_version !== '1' || old.adapter.id !== 'automationbench-public-source') throw new Error('expected a v1 AutomationBench public source package');
const ids = selected.length ? [...selected].sort() : old.tasks.map(t => t.task_id);
if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !old.tasks.some(t => t.task_id === id))) throw new Error('invalid explicit task selection');
const verified = await buildBenchmarkAdapterManifest({ dataset: legacy, benchmark: old.benchmark, adapter: old.adapter, scoring: old.scoring, taskIds: ids });
if (verified.tasks.some(t => t.task_digest !== old.tasks.find(item => item.task_id === t.task_id)?.task_digest)) throw new Error('selected v4 task integrity mismatch');
await mkdir(output);
const owner = `producer:automationbench-v5:${path.resolve(output)}`, first = path.join(legacy, ids[0]);
if (action === 'prepare-runtime') {
  const runtime = path.join(output, 'runtime');
  await cp(path.join(first, 'tests/runtime'), runtime, { recursive: true, filter: file => path.basename(file) !== 'task.json' });
  const originalDockerfile = await readFile(path.join(first, 'tests/Dockerfile'), 'utf8');
  const base = originalDockerfile.match(/^FROM (\S+)$/m)?.[1]; if (!/@sha256:[a-f0-9]{64}$/.test(base ?? '')) throw new Error('runtime base must be immutable');
  // Dependencies are installed once. The recipe retains every source byte,
  // executable bit, empty directory, uv lock and adapter script in the file CAS.
  const dockerfile = `FROM ${base}\nRUN pip install --no-cache-dir uv==0.8.15\nCOPY runtime/upstream /opt/upstream\nWORKDIR /opt/upstream\nRUN uv sync --frozen --no-dev\nCOPY runtime/official.py runtime/server.py runtime/score_contract.py /runtime/\nENV PATH="/opt/upstream/.venv/bin:$PATH" PYTHONPATH="/runtime:/opt/upstream" PYTHONDONTWRITEBYTECODE=1 HF_HOME=/tmp/hf\nCOPY recipe.json /runtime/hitch-resource-recipe.json\n`;
  await writeFile(path.join(output, 'Dockerfile'), dockerfile);
  const source = await resourceRequest(root, 'import', { source: runtime, kind: 'tree', owner: `${owner}:runtime-source` });
  const body = { protocol: 'automationbench-runtime-recipe@1', source: source.resource, dockerfileDigest: hash(dockerfile), upstreamRevision: old.benchmark.revision, platform: 'linux/amd64' };
  const recipe = { ...body, digest: identity(body.protocol, body) }; await writeFile(path.join(output, 'recipe.json'), JSON.stringify(recipe, null, 2));
  await resourceRequest(root, 'pin', { owner, generation: 1, purpose: 'rebuild-inputs', lock: { protocol: 'hitch-resource-lock@1', resources: { source: source.resource }, bindings: [], requiredCapabilities: [] } });
  await resourceRequest(root, 'lease-end', { leaseId: source.leaseId, confirmation: 'ended' });
  console.log(JSON.stringify({ context: path.resolve(output), recipe: recipe.digest, next: 'Build and explicitly publish this context; pass its platform manifest digest to import.' }));
} else {
  if (!recipeFile || ![image, candidateBase].every(ref => /@sha256:[a-f0-9]{64}$/.test(ref ?? ''))) throw new Error('import requires a recipe and fixed runtime/candidate image digests');
  const recipe = JSON.parse(await readFile(recipeFile, 'utf8')), { digest, ...body } = recipe;
  if (digest !== identity('automationbench-runtime-recipe@1', body) || recipe.upstreamRevision !== old.benchmark.revision) throw new Error('runtime recipe identity mismatch');
  const observed = JSON.parse(await command('docker', ['run', '--rm', '--network', 'none', '--platform', recipe.platform, '--entrypoint', 'cat', image, '/runtime/hitch-resource-recipe.json']));
  if (JSON.stringify(observed) !== JSON.stringify(recipe)) throw new Error('runtime image was built from a different recipe');
  const { store } = await configuredResourceStore(root);
  const tree = await store.objects.readTree(recipe.source.manifestDigest);
  for (const id of ids) await verifyRuntime(path.join(legacy, id, 'tests/runtime'), tree);
  const expected = tree.entries.filter(e => e.kind === 'file' && (e.path.startsWith('upstream/') || ['official.py', 'server.py', 'score_contract.py'].includes(e.path))).map(e => ({ path: e.path.startsWith('upstream/') ? '/opt/' + e.path : '/runtime/' + e.path, digest: e.digest }));
  await command('docker', ['run', '--rm', '-i', '--network', 'none', '--platform', recipe.platform, '--entrypoint', 'python', image, '-c', 'import json,hashlib,sys,pathlib; rows=json.load(sys.stdin); assert all("sha256:"+hashlib.sha256(pathlib.Path(r["path"]).read_bytes()).hexdigest()==r["digest"] for r in rows), "runtime image source differs from recipe"'], JSON.stringify(expected));
  const adapterRevision = hash(await readFile(fileURLToPath(import.meta.url)));
  for (const id of ids) {
    const source = path.join(legacy, id), target = path.join(output, id);
    await mkdir(path.join(target, 'environment/candidate/runtime'), { recursive: true }); await mkdir(path.join(target, 'environment/services/simulator'), { recursive: true }); await mkdir(path.join(target, 'tests'));
    for (const name of ['task.toml', 'instruction.md', 'source-prompt.json']) await cp(path.join(source, name), path.join(target, name));
    for (const name of ['call.py', 'tools.json']) await cp(path.join(source, 'environment/runtime', name), path.join(target, 'environment/candidate/runtime', name));
    await cp(path.join(source, 'tests/test.sh'), path.join(target, 'tests/test.sh'));
    const row = await readFile(path.join(source, 'tests/runtime/task.json'));
    await writeFile(path.join(target, 'tests/task.json'), row); await writeFile(path.join(target, 'environment/services/simulator/task.json'), row);
    await writeFile(path.join(target, 'environment/candidate/Dockerfile'), `FROM ${candidateBase}\nCOPY runtime /runtime\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
    await writeFile(path.join(target, 'environment/services/simulator/Dockerfile'), `FROM ${image}\nCOPY task.json /data/task.json\nCMD ["python", "/runtime/server.py"]\n`);
    await writeFile(path.join(target, 'tests/Dockerfile'), `FROM ${image}\nCOPY task.json /data/task.json\nCOPY test.sh /tests/test.sh\nCMD ["sleep", "infinity"]\n`);
    const compose = JSON.parse(await readFile(path.join(source, 'environment/docker-compose.yaml'), 'utf8'));
    compose.services.main.build = { context: 'candidate', dockerfile: 'Dockerfile' }; compose.services.simulator.build = { context: 'services/simulator', dockerfile: 'Dockerfile' };
    await writeFile(path.join(target, 'environment/docker-compose.yaml'), JSON.stringify(compose));
    await writeFile(path.join(target, 'runtime-provenance.json'), JSON.stringify({ protocol: 'automationbench-resource-adapter@1', sourceTask: old.tasks.find(t => t.task_id === id), sourceDataset: old.dataset_digest, recipe }));
    const resources = { candidate: { kind: 'oci-image', manifestDigest: candidateBase.split('@')[1], platform: recipe.platform }, runtime: { kind: 'oci-image', manifestDigest: image.split('@')[1], platform: recipe.platform }, rebuild: recipe.source };
    const bindings = [{ resource: 'candidate', consumer: { role: 'candidate' }, use: 'environment-image', slot: 'build-base' }, ...[{ role: 'verifier' }, { role: 'service', serviceId: 'simulator' }].map(consumer => ({ resource: 'runtime', consumer, use: 'environment-image', slot: 'build-base' }))];
    await writeFile(path.join(target, 'resource.lock.json'), JSON.stringify({ protocol: 'hitch-resource-lock@1', resources, bindings, requiredCapabilities: ['oci-image@1', 'harbor-role-context@1'] }));
  }
  const manifest = await resourceRequest(root, 'seal-dataset', { directory: path.resolve(output), owner, taskIds: ids, manifest: { benchmark: old.benchmark, adapter: { ...old.adapter, revision: adapterRevision }, scoring: old.scoring, ...(old.raw_metrics ? { raw_metrics: old.raw_metrics } : {}), required_capabilities: ['harbor-role-context@1'], execution: { backend: 'harbor-role-context@1', resolver: 'hitch-resource-resolver@1', platform: recipe.platform } } });
  console.log(JSON.stringify({ dataset: path.resolve(output), digest: manifest.dataset_digest, recipe: recipe.digest }));
}
async function command(executable, argv, input) { return new Promise((resolve, reject) => { const child = spawn(executable, argv, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] }); let text = ''; if (input !== undefined) child.stdin.end(input); child.stdout.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) child.kill(); }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`${executable} exited ${code}`))); }); }
async function verifyRuntime(directory, tree) {
  const remaining = new Map(tree.entries.map(entry => [entry.path, entry]));
  async function visit(dir, prefix = '') {
    for (const name of await readdir(dir)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === 'task.json') continue;
      const file = path.join(dir, name), info = await lstat(file), entry = remaining.get(relative);
      if (!entry || info.isSymbolicLink()) throw new Error('v4 runtime differs from the shared recipe');
      remaining.delete(relative);
      if (entry.kind === 'directory' && info.isDirectory()) await visit(file, relative);
      else if (entry.kind !== 'file' || !info.isFile() || entry.size !== info.size || entry.executable !== Boolean(info.mode & 0o111) || entry.digest !== hash(await readFile(file))) throw new Error('v4 runtime differs from the shared recipe');
    }
  }
  await visit(directory); if (remaining.size) throw new Error('v4 runtime is missing recipe inputs');
}
