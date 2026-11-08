import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const { createProjectControlPlane, saveProfile } = await import('rsi-gear')
import { bootstrap, sealHarness } from './harness-fixture.mjs'
import { buildProject } from '../../research/project.mjs'
import { AnalysisOperationProvider } from '../../research/lib/operation-provider.mjs'
import { carrierForTarget, copyRegisteredTarget } from '../../research/lib/target-source.mjs'
import { digest, defaultBudget } from '../../research/lib/contracts.mjs'
import { Store, atomicJson } from '../../research/lib/store.mjs'
import { command } from '../../research/lib/common.mjs'
import { ResearchProject } from '../../research/lib/project.mjs'
import { Backend, checkpoint, task } from './project-fixture.mjs'

test('Generic process provider + Project + Python GEPA compares configured experiment budgets per harness, promotes and resumes without resampling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.GEAR_PROFILE_ROOT
  process.env.GEAR_PROFILE_ROOT = join(root, 'profiles')
  t.after(() => { if (previous === undefined) delete process.env.GEAR_PROFILE_ROOT; else process.env.GEAR_PROFILE_ROOT = previous })
  const target = await bootstrap(join(root, 'target-carrier'))
  const original = target.harness
  await writeFile(join(target.targetRepository, 'harness/prompts/research.md'), 'Registered general research method B.\n')
  const manifest = await sealHarness(target.targetRepository, target.dshBaseRef, original.commit)
  await command('git', ['add', 'harness'], { cwd: target.targetRepository })
  await command('git', ['commit', '--no-gpg-sign', '-m', 'Registered method B'], { cwd: target.targetRepository })
  const candidate = { commit: await command('git', ['rev-parse', 'HEAD'], { cwd: target.targetRepository }), manifestDigest: manifest.digest }
  const store = new Store(join(root, 'research')), start = checkpoint(), checkpointRef = await store.put(start)
  const project = { projectId: 'test', research: { maxExperiments: 3 }, ...target, harness: original, task, model: 'fixture', runtime: {}, checkpointRef,
    budget: defaultBudget, modelAccounting: { mode: 'usage-only' },
    projectLimits: { maxSequences: 2, cpuSeconds: 2 * defaultBudget.cpuSeconds, wallSeconds: 2 * defaultBudget.wallSeconds } }
  await atomicJson(join(root, 'project.json'), project)
  await store.save('projects', 'test', { checkpoint: checkpointRef, stage: null })
  await new ResearchProject(store, project).stage('comparison', [original, candidate])
  const built = await buildProject(root, { checkpointRef, registered: [original, candidate], stageId: 'comparison' })
  assert.equal(built.config.generation, undefined)
  assert.deepEqual(built.config.budget, { rounds: 1, max_evaluations: 2, max_candidates: 1, repetitions: 1 })
  built.profile.command = [process.execPath, fileURLToPath(new URL('./process-provider-fixture.mjs', import.meta.url))]
  await saveProfile(built.targetProfile, built.profile)
  const rolloutCount = async () => (await readdir(join(store.root, 'fixture-rollouts'))).length
  const control = await createProjectControlPlane(built.cohort, { socketPath: join(root, 'gear.sock') })
  t.after(() => control.dispose())
  const application = control.application
  const { runId } = await application.admitRefine()
  await assert.rejects(application.resume(runId), /transport lost/)
  assert.equal((await application.store.read(runId)).status, 'needs_recovery')
  assert.equal(await rolloutCount(), 3)
  const report = await application.resume(runId)
  assert.equal(report.status, 'completed')
  assert.equal(report.validation_mode, 'shared-set-research')
  assert.notEqual(report.retained, 'anchor')
  assert.equal(report.scores.initial.seed.score, .7)
  assert.equal(report.scores.retained.seed.score, .8)
  assert.equal((await carrierForTarget(store, project, join(built.cohort, '.gear/runs', report.run_id, 'targets', report.retained), built.registered)).commit, candidate.commit)
  const backend = new Backend(store)
  assert.equal(await rolloutCount(), 6)
  assert.equal((await readdir(join(store.root, 'fixture-deliveries'))).length, 2)
  const calls = await Promise.all((await readdir(join(store.root, 'fixture-rollouts'))).map(name => store.load('fixture-rollouts', name.slice(0, -5))))
  assert.ok(calls.every(c => c.experiment.protocol === 'analysis-experiment@3'))
  const journal = await application.store.read(runId)
  assert.equal(journal.heldOutEvidence.length, 0)
  assert.equal(journal.physicalAttempts, 2)
  assert.equal(journal.operations.filter(o => o.request.operation.kind === 'evaluate_seed' && o.reservedAttempts > 0).length, 2)
  assert.equal((await application.resume(runId)).retained, report.retained)
  assert.equal(await rolloutCount(), 6)
  const archive = await application.archive(runId)
  assert.ok(JSON.stringify(archive).includes('analysis-operation@1'))

  // Import a genuinely edited Project target onto the fixed carrier; the checkout stays unchanged.
  const edited = join(root, 'edited')
  await copyRegisteredTarget(target.targetRepository, original, edited)
  await writeFile(join(edited, 'prompts/research.md'), 'New general method from a Project Meta provider.\n')
  const generated = await carrierForTarget(store, project, edited, [original, candidate])
  assert.notEqual(generated.commit, original.commit)
  assert.equal(await command('git', ['rev-parse', 'HEAD'], { cwd: target.targetRepository }), candidate.commit)
  assert.deepEqual(await carrierForTarget(store, project, edited, [original, candidate]), generated)

  // Receipts are bound to resources, not merely candidate IDs.
  const evaluation = journal.operations.find(o => o.request.operation.kind === 'evaluate_seed')
  const provider = new AnalysisOperationProvider(store, backend, project, start, built.configuration,
    { runId, targets: join(built.cohort, '.gear/runs', runId, 'targets') })
  assert.equal((await provider.inspect(evaluation.request)).state, 'complete')
  const frozen = join(provider.context.targets, 'anchor/prompts/research.md')
  await chmod(frozen, 0o600); await writeFile(frozen, 'changed after admission')
  await assert.rejects(provider.inspect(evaluation.request), /target resources changed/)
  await assert.rejects(provider.submit({ ...evaluation.request, partition: 'held_out' }), /held-out/)
  await assert.rejects(provider.submit({ ...evaluation.request, repetitions: 3 }), /one seed repetition/)

  const cancelled = { ...evaluation.request, operationId: digest('cancel before submission') }
  assert.equal((await provider.cancel(cancelled)).cancelled, true)
  await assert.rejects(provider.submit(cancelled), /cancelled/)
  assert.equal(await rolloutCount(), 6)
})
