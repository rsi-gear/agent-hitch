import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'hitch-analysis-installed-'))
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, ...options })
try {
  const packaged = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: source }))[0]
  const paths = packaged.files.map(file => file.path)
  for (const path of ['benchmark-packages/kaggle/research/cli.mjs', 'benchmark-packages/kaggle/research/lib/operation-provider.mjs', 'integrations/analysis-runtime/research_worker.py']) assert(paths.includes(path), path)
  assert(!paths.some(path => path.startsWith('benchmark-packages/kaggle/tests/')))
  assert.equal(paths.filter(path => path.endsWith('/research_worker.py')).length, 1)
  assert.equal(paths.filter(path => path.endsWith('/scoring.py')).length, 1)
  const consumer = join(root, 'consumer'); mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'installed-analysis-check', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packaged.filename)], { cwd: consumer })
  const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/agent-hitch/package.json')))
  assert(!manifest.dependencies?.['rsi-gear'] && !manifest.peerDependencies?.['rsi-gear'])
  cpSync(join(source, 'benchmark-packages/kaggle/tests/fixtures/harness'), join(consumer, 'harness'), { recursive: true })
  const python = process.env.GEAR_MLEBENCH_PYTHON ?? process.env.GEAR_PYTHON ?? 'python3'
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareAnalysisProject, configureAnalysisExperiment, exportOptimizationProject, describeAnalysisIntegration, verifyAnalysisRuntime, validateSchema, readAnalysisContract } from 'agent-hitch/analysis'
const root = process.cwd(), python = process.env.ANALYSIS_TEST_PYTHON
const train = join(root, 'train.csv'), predict = join(root, 'predict.csv')
await writeFile(train, 'id,x,label\\n' + Array.from({length: 20}, (_, i) => i+','+i+','+(i%2)).join('\\n') + '\\n')
await writeFile(predict, 'id,x\\n21,21\\n22,22\\n')
const directory = join(root, 'project')
const project = await prepareAnalysisProject({ out: directory, harness: join(root, 'harness'), legacyCsv: true, train, predict,
  idColumn: 'id', targetColumn: 'label', family: 'synthetic', python,
  hitchRoot: join(root, 'hitch-state'), model: 'fixture/model', platform: 'linux/arm64', baseImage: 'fixture@sha256:' + '1'.repeat(64) })
assert.equal(project.backend.hitchRepository, undefined)
assert.equal(project.backend.executorRepository, join(directory, 'executor'))
assert.match(project.backend.executorCommit, /^[a-f0-9]{40,64}$/)
const integration = await describeAnalysisIntegration()
assert.equal(project.backend.analysisIntegrationDigest, integration.digest)
await verifyAnalysisRuntime(join(project.targetRepository, 'fixed/runtime'), integration.runtime)
assert.equal((await lstat(project.backend.executable)).isFile(), true)
assert.match(execFileSync(project.backend.executable, ['--version'], { encoding: 'utf8' }), /\\d+\\.\\d+\\.\\d+/)
const golden = JSON.parse(await readAnalysisContract('golden.json'))
validateSchema('Checkpoint', golden.checkpoint)
const changed = { ...project.experiment, version: 'ten', validation: { ...project.experiment.validation, folds: 10 } }
const next = await configureAnalysisExperiment(directory, changed)
assert.equal(next.project.validationPlan.folds, 10)
assert.deepEqual(await configureAnalysisExperiment(directory, changed), next)
const exported = await exportOptimizationProject(directory, { out: join(root, 'optimization'), metaProfile: 'configured-meta', experiment: changed })
assert.equal(exported.profile.configuration.experiment.validation.folds, 10)
console.log(JSON.stringify({ standaloneHitch: 'passed', installedPreparation: 'passed', frozenExecutor: 'passed', parameterizedPolicy: 'passed', genericProjectExport: 'passed', legacyCheckpoint: 'passed' }))
`)
  const env = { ...process.env, ANALYSIS_TEST_PYTHON: python, GEAR_MLEBENCH_PYTHON: python, PYTHONPATH: '', NODE_PATH: '',
    PATH: `${dirname(process.execPath)}:${process.env.PATH}` }
  delete env.NODE_TEST_CONTEXT
  process.stdout.write(run(process.execPath, ['probe.mjs'], { cwd: consumer, env }))
  assert.match(run(join(consumer, 'node_modules/.bin/hitch-analysis'), ['--help'], { cwd: consumer, env }), /Usage: hitch-analysis/)
  // Test inputs remain outside the published package; production modules resolve to installed release bytes.
  cpSync(join(source, 'benchmark-packages/kaggle/tests'), join(consumer, 'tests'), { recursive: true })
  symlinkSync(join(consumer, 'node_modules/agent-hitch/benchmark-packages/kaggle/research'), join(consumer, 'research'), 'dir')
  if (process.env.GEAR_TEST_GEAR_PACKAGE) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(process.env.GEAR_TEST_GEAR_PACKAGE)], { cwd: consumer })
    const gear = JSON.parse(readFileSync(join(consumer, 'node_modules/rsi-gear/package.json')))
    assert(!gear.exports['./analysis-research'] && !gear.bin['gear-analysis'])
    process.stdout.write(run(process.execPath, ['--test', 'tests/research/gear-project.integration.mjs'], { cwd: consumer, env, timeout: 180_000 }))
  }
  if (process.env.GEAR_ANALYSIS_IMAGE) {
    writeFileSync(join(consumer, 'fixture.mjs'), readFileSync(join(source, 'benchmark-packages/kaggle/tests/research/mlebench-fixture.mjs'), 'utf8')
      .replaceAll('../../research/', './research/').replaceAll('../fixtures/research/mlebench/', './tests/fixtures/research/mlebench/'))
    cpSync(join(source, 'benchmark-packages/kaggle/tests/installed-journey.mjs'), join(consumer, 'journey.mjs'))
    process.stdout.write(run(process.execPath, ['journey.mjs'], { cwd: consumer, env, timeout: 900_000 }))
  }
} finally {
  if (process.env.GEAR_ANALYSIS_KEEP) console.log(`Installed analysis artifacts: ${root}`)
  else rmSync(root, { recursive: true, force: true })
}
