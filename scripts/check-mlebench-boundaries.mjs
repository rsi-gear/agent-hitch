import assert from 'node:assert/strict'
import { readdir, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const removed = [
  'benchmark-packages/kaggle/research',
  'benchmark-packages/kaggle/analysis-contracts',
  'integrations/analysis',
  'integrations/analysis-runtime',
  'integrations/sealed-python',
  'src/adapters/providers/sealed-python.ts',
]
for (const path of removed) {
  assert.equal(await access(join(root, path)).then(() => true, () => false), false, `Removed execution path remains: ${path}`)
}
for (const directory of ['src', 'benchmark-packages/kaggle']) {
  for (const name of await readdir(join(root, directory), { recursive: true })) {
    if (!/\.(?:mjs|js|ts)$/.test(name) || name.startsWith('tests/')) continue
    const source = await readFile(join(root, directory, name), 'utf8')
    assert(!/\b(?:from|import)\s*(?:\(\s*)?['"][^'"]*(?:rsi-gear|gear\/(?:src|lib))/.test(source), `Optimization client dependency: ${name}`)
    assert(!/analysis-(?:research|round-cv|holdout-plan|solution|resolved-pipeline|execution-receipt)|research_worker|pipeline_runner/.test(source), `Removed execution protocol remains: ${name}`)
    if (directory === 'src') assert(!/\b(?:titanic|sklearn|build_pipeline)\b/i.test(source), `Benchmark-specific control logic: ${name}`)
  }
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert(!Object.keys(pkg.exports).some(key => key.startsWith('./analysis')))
assert(!pkg.bin['hitch-analysis'])
assert(!pkg.dependencies?.['rsi-gear'] && !pkg.peerDependencies?.['rsi-gear'])
assert(!pkg.devDependencies?.['@deepseek-ai/dsh-tools'])
console.log('MLE-bench boundary: ordinary tasks, independent verifier, no research execution chain or optimizer dependency')
