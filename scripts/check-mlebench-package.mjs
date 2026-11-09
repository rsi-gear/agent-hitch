import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'hitch-mlebench-installed-'))
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') }, ...options,
})
try {
  const packaged = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: source }))[0]
  const paths = packaged.files.map(file => file.path)
  for (const path of ['benchmark-packages/kaggle/index.mjs', 'benchmark-packages/kaggle/import.mjs', 'benchmark-packages/kaggle/analysis.mjs', 'dist/src/parameters/index.js']) assert(paths.includes(path), path)
  assert(!paths.some(path => /(?:kaggle\/(?:research|analysis-contracts|tests)\/|integrations\/(?:analysis|analysis-runtime|sealed-python)\/|providers\/sealed-python\.)/.test(path)), 'Package contains removed research execution assets or fixtures')
  const consumer = join(root, 'consumer'); mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'installed-task-check', private: true, type: 'module' }))
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packaged.filename)], { cwd: consumer })
  const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/agent-hitch/package.json')))
  assert(!manifest.dependencies?.['rsi-gear'] && !manifest.peerDependencies?.['rsi-gear'])
  assert(!manifest.bin['hitch-analysis'])
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict'
import * as tasks from 'agent-hitch/mlebench'
import * as parameters from 'agent-hitch/parameters'
for (const name of ['produceTask', 'importCompetition', 'importMlebench', 'inspectMlebench']) assert.equal(typeof tasks[name], 'function', name)
assert(Object.keys(parameters).length > 0)
for (const entry of ['agent-hitch/analysis', 'agent-hitch/analysis/contracts', 'agent-hitch/analysis/research']) {
  await assert.rejects(import(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
console.log('Installed public task and parameter APIs load; removed APIs are unavailable')
`)
  process.stdout.write(run(process.execPath, ['probe.mjs'], { cwd: consumer }))
  assert.match(run(process.execPath, [join(consumer, 'node_modules/agent-hitch/benchmark-packages/kaggle/import.mjs'), '--help'], { cwd: consumer }), /hitch-mlebench/)
} finally {
  rmSync(root, { recursive: true, force: true })
}
