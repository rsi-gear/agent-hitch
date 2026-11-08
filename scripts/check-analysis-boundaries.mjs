import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
for (const directory of ['benchmark-packages/kaggle/research', 'integrations/analysis']) {
  for (const name of await readdir(join(root, directory), { recursive: true })) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue
    const source = await readFile(join(root, directory, name), 'utf8')
    assert(!/\b(?:from|import)\s*(?:\(\s*)?['"][^'"]*(?:rsi-gear|gear\/(?:src|lib))/.test(source), `Optimization client dependency: ${name}`)
    assert(!/\b(?:ProjectApplication|createProjectControlPlane)\b/.test(source), `Task execution must not start the client optimizer: ${name}`)
  }
}
for (const file of ['worker.py', 'research_worker.py', 'pipeline_runner.py', 'confinement.py', 'scoring.py']) {
  const copies = []
  for (const directory of ['integrations', 'benchmark-packages/kaggle'])
    for (const name of await readdir(join(root, directory), { recursive: true }))
      if (name.split('/').at(-1) === file) copies.push(`${directory}/${name}`)
  assert.deepEqual(copies, [`integrations/analysis-runtime/${file}`], `Duplicate fixed runtime: ${file}`)
}
console.log('Analysis boundary: Hitch owns execution, one runtime source, no optimization client dependency')
