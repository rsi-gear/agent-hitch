import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepare } from './harness-fixture.mjs'
import { configureExperiment, materializeValidation } from '../../research/lib/experiment-config.mjs'
import { experimentConfig } from '../../research/lib/research-config.mjs'
import { AnalysisOperationProvider } from '../../research/lib/operation-provider.mjs'
import { roundValidation } from '../../research/lib/validation.mjs'
import { validateSearchPlan } from '../../research/lib/pipeline.mjs'
import { compatible, digest } from '../../research/lib/contracts.mjs'
import { Store } from '../../research/lib/store.mjs'
import { validateSchema } from '../../research/lib/schemas.mjs'

const config = (version, validation) => ({ version, maxExperiments: 2, validation: { method: 'stratified_kfold', folds: 5, shuffle: true, seed: 42, ...validation } })
const prediction = { kind: 'tabular', idColumn: 'id', targetColumns: ['target'], labels: ['0', '1'], metric: 'accuracy' }
async function data(t) {
  const root = await mkdtemp(join(tmpdir(), 'hitch-policy-')); t.after(() => rm(root, { recursive: true, force: true }))
  const train = join(root, 'train.csv'), predict = join(root, 'test.csv')
  await writeFile(train, 'id,x,target\n' + Array.from({ length: 40 }, (_, i) => `${i},${i},${i % 2}\n`).join(''))
  await writeFile(predict, 'id,x\n41,41\n42,42\n')
  return { root, train, predict }
}

test('policy supports 5/10 folds, shuffle, seeds and holdout proportions; unsupported algorithms fail', async t => {
  const { train } = await data(t)
  const { plan: five } = await materializeValidation(train, prediction, config('five', {}))
  const { plan: ten } = await materializeValidation(train, prediction, config('ten', { folds: 10 }))
  const { plan: seeded } = await materializeValidation(train, prediction, config('seed', { seed: 7 }))
  const { plan: ordered } = await materializeValidation(train, prediction, config('ordered', { shuffle: false }))
  for (const plan of [five, ten, seeded, ordered]) {
    validateSchema('RoundValidation', plan)
    assert.equal(plan.rowIds.length, 40)
    assert.equal(new Set(plan.foldAssignments).size, plan.folds)
    assert.equal(plan.seed, plan === seeded ? 7 : 42)
    assert.equal(plan.trainDigest, five.trainDigest)
  }
  assert.notDeepEqual(five.foldAssignments, seeded.foldAssignments)
  assert.notDeepEqual(five.foldAssignments, ordered.foldAssignments)
  assert.notEqual(five.configurationDigest, ten.configurationDigest)
  const { plan: holdout } = await materializeValidation(train, prediction, { version: 'holdout', validation: { method: 'stratified_holdout', fraction: .2, shuffle: true, seed: 42 } })
  assert.equal(holdout.folds, 1); assert.equal(holdout.foldAssignments.filter(a => a === 0).length, 8)
  assert.equal(holdout.foldAssignments.filter(a => a === -1).length, 32)
  for (const invalid of [config('x', { folds: 1 }), config('x', { method: 'group' }), config('x', { method: 'time' }), config('x', { seed: -1 }), config('x', { typo: 1 })])
    assert.throws(() => experimentConfig(invalid))
})

test('new versions isolate checkpoints and provider identity; resume reuses exact persisted assignments', async t => {
  const { root, train, predict } = await data(t), directory = join(root, 'project')
  const base = await prepare({ out: directory, legacyCsv: true, train, predict, idColumn: 'id', targetColumn: 'target', family: 'fixture',
    hitchRoot: join(root, 'hitch'), hitchExecutable: '/fixture/hitch', executorExecutable: '/fixture/hitch',
    baseImage: 'fixture@sha256:' + 'a'.repeat(64), platform: 'linux/arm64', model: 'fixture', experiment: config('five', {}) })
  validateSchema('Task', base.task)
  const changed = config('ten', { folds: 10 })
  const next = await configureExperiment(directory, changed)
  assert.notEqual(next.directory, directory)
  assert.notEqual(next.project.task.digest, base.task.digest)
  assert.equal(next.project.validationPlan.folds, 10)
  const first = await new Store(join(directory, 'research')).get(base.checkpointRef)
  const second = await new Store(join(next.directory, 'research')).get(next.project.checkpointRef)
  assert.equal(second.history.length, 0)
  assert.throws(() => compatible(first, second), /scope mismatch/)
  assert.deepEqual(roundValidation(next.project.task, digest('first checkpoint')), roundValidation(next.project.task, digest('later checkpoint')))
  const configuration = { project: directory, projectDigest: digest(base), registered: [base.harness] }
  await assert.rejects(AnalysisOperationProvider.open(configuration, {}), /versioned experiment configuration required/)
  const oldProvider = await AnalysisOperationProvider.open({ ...configuration, experiment: base.experiment }, {})
  const newProvider = await AnalysisOperationProvider.open({ ...configuration, experiment: changed }, {})
  assert.notEqual((await oldProvider.describe()).identity, (await newProvider.describe()).identity)
  await assert.rejects(AnalysisOperationProvider.open({ ...configuration, experiment: changed, checkpointRef: base.checkpointRef }, {}), /ENOENT|another experiment/)
  await assert.rejects(configureExperiment(directory, config('five', { folds: 10 })), /choose a new version/)
  await assert.rejects(configureExperiment(next.directory, config('five', { folds: 10 })), /choose a new version/)
  const bytes = await readFile(join(next.directory, 'data/validation.json'))
  assert.deepEqual(await configureExperiment(directory, changed), next)
  assert.deepEqual(await readFile(join(next.directory, 'data/validation.json')), bytes)
  await writeFile(join(next.directory, 'data/validation.json'), '{}')
  await assert.rejects(configureExperiment(directory, changed), /row assignments changed/)
})

test('candidate search cannot change the outer policy and budgets use the configured fold count', () => {
  const model = { inputSchema: {}, preprocessing: {}, features: {}, model: 'dummy', hyperparameters: {}, prediction: { kind: 'label' }, seed: 1 }
  const frozen = { kind: 'stratified', method: 'stratified_kfold', folds: 10, shuffle: false, seed: 42 }
  const plan = { version: 1, entrypoint: 'solution.py', variants: [{ id: 'a', config: model }], validation: { ...frozen }, selection: 'best_mean_utility', seed: 1, maxFits: 11, refitReserve: 1 }
  assert.deepEqual(validateSearchPlan(plan, { roundValidation: frozen }).validation, frozen)
  for (const validation of [{ ...frozen, folds: 5 }, { ...frozen, seed: 2 }, { ...frozen, shuffle: true }])
    assert.throws(() => validateSearchPlan({ ...plan, validation }, { roundValidation: frozen }), /frozen outer/)
  assert.throws(() => validateSearchPlan({ ...plan, maxFits: 6 }, { roundValidation: frozen }), /fit budget/)
  const holdout = { kind: 'stratified', method: 'stratified_holdout', folds: 1, shuffle: true, seed: 42, fraction: .2 }
  assert.equal(validateSearchPlan({ ...plan, validation: holdout, maxFits: 2 }, { roundValidation: holdout }).validation.fraction, .2)
})
