#!/usr/bin/env node
// A terminal producer whose primary shared dependency is a data tree.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resourceRequest } from 'agent-hitch/resources';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const source = option('--source'), output = option('--out'), root = option('--root'), base = option('--base-image'), count = Number(option('--tasks') ?? 3), platform = option('--platform') ?? 'linux/amd64';
if (args.length || !source || !output || !root || !/@sha256:[a-f0-9]{64}$/.test(base ?? '') || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('Usage: node import.mjs --source DATA_TREE --out NEW_DIRECTORY --root HITCH_ROOT --base-image PINNED_PYTHON_IMAGE [--tasks N] [--platform linux/amd64]');
const values = JSON.parse(await readFile(path.join(source, 'values.json'), 'utf8'));
if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw new Error('source values.json must be a nonempty array of finite numbers');
await mkdir(output); // Never alter an existing dataset.
const owner = `producer:shared-tree:${path.resolve(output)}`;
const imported = await resourceRequest(root, 'import', { source: path.resolve(source), kind: 'tree', owner });
const image = { kind: 'oci-image', manifestDigest: base.split('@')[1], platform }, ids = [];
for (let i = 0; i < count; i++) {
  const id = `sum-${String(i + 1).padStart(4, '0')}`, task = path.join(output, id); ids.push(id);
  await mkdir(path.join(task, 'environment/candidate'), { recursive: true }); await mkdir(path.join(task, 'tests'));
  await writeFile(path.join(task, 'instruction.md'), `Read /data/values.json and write the sum of its first ${i + 1} values to /app/answer.json.\n`);
  await writeFile(path.join(task, 'environment/docker-compose.yaml'), JSON.stringify({ services: { main: { platform, build: { context: 'candidate', dockerfile: 'Dockerfile' } } } }));
  await writeFile(path.join(task, 'environment/candidate/Dockerfile'), `FROM ${base}\nCOPY data /data\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
  await writeFile(path.join(task, 'tests/Dockerfile'), `FROM ${base}\nCOPY . /tests\nCMD ["sleep", "infinity"]\n`);
  await writeFile(path.join(task, 'tests/expected.json'), JSON.stringify(values.slice(0, i + 1).reduce((n, x) => n + x, 0)));
  await writeFile(path.join(task, 'tests/verify.py'), 'import json, pathlib, sys\nanswer = pathlib.Path(sys.argv[1])\nexpected = json.loads(pathlib.Path("/tests/expected.json").read_text())\nscore = int(answer.exists() and json.loads(answer.read_text()) == expected)\noutput = pathlib.Path("/logs/verifier"); output.mkdir(parents=True, exist_ok=True)\n(output / "reward.json").write_text(json.dumps({"reward": score}))\n');
  await writeFile(path.join(task, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython /tests/verify.py /evidence/answer.json\n', { mode: 0o755 });
  // Candidate artifacts cross the role boundary only via Harbor's explicit evidence export.
  await writeFile(path.join(task, 'task.toml'), 'schema_version = "1.4"\nartifacts = [{ source = "/app/answer.json" }]\n[environment]\nworkdir = "/app"\nnetwork_mode = "none"\n[verifier]\nenvironment_mode = "separate"\n[verifier.environment]\nnetwork_mode = "none"\n');
  await writeFile(path.join(task, 'resource.lock.json'), JSON.stringify({ protocol: 'hitch-resource-lock@1', resources: { data: imported.resource, python: image }, requiredCapabilities: ['tree@1', 'private-copy@1'], bindings: [
    { resource: 'data', consumer: { role: 'candidate' }, use: 'input-tree', target: 'data', access: 'private-copy' },
    ...['candidate', 'verifier'].map(role => ({ resource: 'python', consumer: { role }, use: 'environment-image', slot: 'build-base' })),
  ] }));
}
const manifest = await resourceRequest(root, 'seal-dataset', { directory: path.resolve(output), owner, taskIds: ids, manifest: {
  benchmark: { id: 'shared-tree-sums', revision: imported.resource.manifestDigest }, adapter: { id: 'shared-tree-terminal', revision: '1', output_protocol: 'gear-harbor-eval-result-v1' },
  required_capabilities: ['harbor-role-context@1'], execution: { backend: 'harbor-role-context@1', resolver: 'hitch-resource-resolver@1', platform },
  scoring: { total_score: { source_metric: 'reward', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } },
} });
await resourceRequest(root, 'lease-end', { leaseId: imported.leaseId, confirmation: 'ended' });
console.log(JSON.stringify({ dataset: path.resolve(output), digest: manifest.dataset_digest, sharedTree: imported.resource }));
