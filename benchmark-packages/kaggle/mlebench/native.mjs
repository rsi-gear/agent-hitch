import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { assert } from '../../../integrations/analysis/protocol.mjs'
import { command } from './support.mjs'
import { inspectMlebench, treeManifest, fileHash } from './import.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export async function prepareTabularData(options, out) {
  const args = ['--train', resolve(options.train), '--predict', resolve(options.predict),
    '--id-column', options.idColumn ?? 'PassengerId', '--target-column', options.targetColumn ?? 'Survived', '--out', out,
    ...(options.existingCompetition ? ['--existing-competition', resolve(options.existingCompetition)] : [])]
  await command(options.python ?? 'python3', [join(here, 'prepare-data.py'), ...args])
  return JSON.parse(await readFile(join(out, 'prepared.json')))
}
export async function inspectDeploymentData(directory, { python = 'python3' } = {}) {
  return JSON.parse(await command(python, [join(here, 'mlebench-deployment.py'), '--directory', directory]))
}
export async function installMlebenchCompetition(competition, destination) {
  assert(competition === 'titanic', 'unknown bundled MLE-bench competition')
  await mkdir(dirname(resolve(destination)), { recursive: true })
  await cp(join(here, 'competitions', competition), destination, { recursive: true, errorOnExist: true, force: false })
}
export async function runNativeMlebench(action, options) {
  assert(['prepare', 'grade'].includes(action), 'unsupported native MLE-bench action')
  assert(/^[a-z0-9][a-z0-9-]*$/.test(options.competition), 'invalid competition ID')
  if (action === 'grade') { assert(options.submission, 'submission required'); await inspectMlebench(options) }
  const output = await command(options.python ?? 'python3', [join(here, 'mlebench-native.py'), action,
    '--data-root', resolve(options.dataRoot), '--competition', options.competition,
    ...(options.submission ? ['--submission', resolve(options.submission)] : [])],
    { env: { ...process.env, PYTHONPATH: resolve(options.repository) } })
  if (action === 'prepare' && options.recordChecksums) {
    assert(options.competition === 'titanic', 'do not overwrite official benchmark checksums')
    const body = {}
    for (const role of ['public', 'private']) {
      const directory = join(options.dataRoot, options.competition, 'prepared', role)
      body[role] = Object.fromEntries(await Promise.all((await treeManifest(directory)).filter(f => !f.path.includes('/') && f.path.endsWith('.csv'))
        .map(async f => [f.path, await fileHash(join(directory, f.path), 'md5')])))
    }
    await writeFile(join(options.repository, 'mlebench/competitions', options.competition, 'checksums.yaml'), yaml.dump(body))
  }
  return JSON.parse(output)
}
