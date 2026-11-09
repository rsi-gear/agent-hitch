#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { produceTask } from './analysis.mjs';
import { importMlebench } from './mlebench/import.mjs';
import { assert } from './mlebench/schema.mjs';

export async function importCompetition(options, resourceRequest) {
  return produceTask(options, resourceRequest);
}
export const usage = `hitch-mlebench --config TASK.json --out NEW_DATASET --root HITCH_ROOT
hitch-mlebench --repository MLE_BENCH_REPO --data-root PREPARED_DATA --competition ID --base-image IMAGE@sha256:DIGEST --out NEW_DATASET --root HITCH_ROOT [--platform linux/amd64] [--timeout-seconds 3600] [--public-assets ASSET_MANIFEST.json]

Custom TASK.json explicitly declares instruction, publicDirectory, delivery, evaluation,
parameters (optional), and baseImage. Relative input paths are relative to TASK.json.
Use evaluation.mode=delivery for unlabeled prediction tasks; use scored with an
explicit private expected CSV and grader for a custom evaluation version.
Old research projects/checkpoints/rollout configuration are not supported.
`;
export function parseArgs(argv) {
  const options = {};
  const names = { '--config': 'config', '--out': 'out', '--root': 'root', '--repository': 'repository', '--data-root': 'dataRoot', '--competition': 'competition', '--base-image': 'baseImage', '--platform': 'platform', '--timeout-seconds': 'timeoutSeconds', '--public-assets': 'publicAssetsFile' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]], value = argv[i + 1];
    assert(key && !Object.hasOwn(options, key) && typeof value === 'string' && value && !value.startsWith('--'), usage);
    options[key] = key === 'timeoutSeconds' ? Number(value) : value;
  }
  assert(options.out && options.root && (options.config ? !options.repository && !options.dataRoot && !options.competition && !options.publicAssetsFile : options.repository && options.dataRoot && options.competition && options.baseImage), usage);
  return options;
}
export async function runCli(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return usage;
  const args = parseArgs(argv);
  if (!args.config) {
    const { publicAssetsFile, ...options } = args;
    if (publicAssetsFile) {
      const { parseParameterJSON } = await import('agent-hitch/parameters');
      options.publicAssets = parseParameterJSON(await readFile(publicAssetsFile, 'utf8'));
    }
    return importMlebench(options);
  }
  const { config, ...overrides } = args, base = dirname(resolve(config));
  const { parseParameterJSON } = await import('agent-hitch/parameters');
  const options = parseParameterJSON(await readFile(config, 'utf8'));
  for (const name of ['publicDirectory', 'expected']) if (typeof options[name] === 'string') options[name] = resolve(base, options[name]);
  return importCompetition({ ...options, ...overrides });
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then(value => console.log(typeof value === 'string' ? value : JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
