// Runs only from an external consumer of the two tarballs. The target decisions
// are deterministic; training and refit use real Linux containers, not fake scores.
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prepare, SequenceRunner, sequencePlan, refit, exportSubmission } from 'agent-hitch/analysis/research'
import { fixture, competitions } from './fixture.mjs'
import { resourceRequest } from 'agent-hitch/resources'

const entry = import.meta.resolve('agent-hitch/analysis/research')
const { Store } = await import(new URL('./lib/store.mjs', entry))
const { HitchBackend } = await import(new URL('./lib/hitch-backend.mjs', entry))
const { digest, sha, verify } = await import(new URL('./lib/contracts.mjs', entry))
const root = process.cwd(), image = process.env.GEAR_ANALYSIS_IMAGE
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, timeout: 600_000, ...options })
assert(image?.includes('@sha256:'), 'GEAR_ANALYSIS_IMAGE must be a locally available pinned Linux runtime')
const input = await fixture(root, competitions[1])
const directory = join(root, 'journey')
const project = await prepare({ harness: join(root, 'harness'), out: directory, mlebenchRepository: input.repository, mlebenchData: input.dataRoot,
  competition: input.competition, fixture: true, python: process.env.ANALYSIS_TEST_PYTHON,
  hitchRoot: join(root, 'hitch-state'), baseImage: image, platform: process.env.GEAR_ANALYSIS_PLATFORM ?? 'linux/arm64',
  model: 'deterministic-test-target', experiment: { version: 'installed-ten-fold', maxExperiments: 2, validation: { method: 'stratified_kfold', folds: 10, shuffle: true, seed: 42 } } })
await resourceRequest(project.backend.root, 'configure', { protocol: 'hitch-resource-host@1',
  transport: { [image.split('@')[1]]: image }, imagePolicy: 'cache-first', platform: project.backend.platform, workspace: {} })
const store = new Store(join(directory, 'research')), start = await store.get(project.checkpointRef)
const plan = sequencePlan({ ...project, checkpoint: start, runtimeDigest: project.task.runtimeDigest })

await writeFile(join(root, 'run-target.mjs'), `
import { Driver } from '/carrier/fixed/driver.mjs'
const d = new Driver('/carrier')
await d.initialize(); await d.inspect()
await d.write('solution.py', "from sklearn.dummy import DummyClassifier\\ndef build_pipeline(config):\\n    return DummyClassifier(strategy='prior')\\n", null)
const config = { inputSchema: {}, preprocessing: {}, features: {}, model: 'dummy', hyperparameters: {}, prediction: { kind: 'probability', positiveLabel: '1' }, seed: 42 }
const plan = { version: 1, entrypoint: 'solution.py', variants: [{ id: 'baseline', config }],
  validation: { kind: d.plan.kind, folds: d.plan.folds, shuffle: d.plan.shuffle, seed: d.plan.seed }, selection: 'best_mean_utility', seed: 42, maxFits: d.plan.folds + 1, refitReserve: 1 }
const result = await d.experiments({ action: 'run', plan, hypothesis: 'constant probability baseline', intendedChange: 'deterministic integration fixture' })
await d.experiments({ action: 'select', experimentId: result.experimentId, variantId: 'baseline', reason: 'actual current-slot choice' })
await d.finish('deterministic container canary', [])
`)

class ContainerBackend extends HitchBackend {
  calls = 0
  lostReply = false
  manifests = new Map()
  async hitch(args, options) {
    if (args[0] === 'runs' && args[1] === 'artifacts' && this.manifests.has(args[3])) return this.manifests.get(args[3])
    return super.hitch(args, options)
  }
  async execute(request, checkpoint, options) {
    if (!checkpoint) return super.execute(request, checkpoint, options)
    const id = request.digest.slice(7), saved = await store.load('executions', id)
    if (saved) {
      this.manifests.set(saved.runId, { run_id: saved.runId, digest: saved.outputManifestDigest })
      return saved
    }
    // Exercise the installed producer and role/resource partitioning, even
    // though the model decision itself is supplied by the deterministic script.
    await this.materialize(request, checkpoint)
    const destination = join(root, 'container-results', id), output = join(destination, 'output')
    await mkdir(output, { recursive: true })
    const runId = 'run_' + id.slice(0, 32)
    this.calls++
    run('docker', ['run', '--rm', '--init', '--network', 'none', '--cpus', '2', '--memory', '4g',
      '--tmpfs', '/run:size=134217728,mode=755', '--tmpfs', '/opt/kaggle-runtime/work:size=1073741824,mode=755',
      '-e', 'HITCH_RUN_ID=' + runId, '-v', project.targetRepository + ':/carrier:ro',
      '-v', join(store.root, 'task-inputs', id) + ':/data:ro', '-v', output + ':/output',
      '-v', join(root, 'run-target.mjs') + ':/canary.mjs:ro', '--entrypoint', 'node', image, '/canary.mjs'])
    const entries = []
    for (const file of await readdir(output, { recursive: true, withFileTypes: true })) if (file.isFile()) {
      const bytes = await readFile(join(file.parentPath, file.name))
      entries.push({ name: file.name, digest: sha(bytes) })
      if (file.parentPath.endsWith('/objects')) assert.equal(await store.putBytes(bytes), 'sha256:' + file.name)
    }
    const body = verify(JSON.parse(await readFile(join(output, 'receipt.json'))))
    assert.equal(body.experiment.execution.status, 'completed')
    assert.equal(body.experiment.analysis.fits, 10)
    const operation = { requestDigest: request.digest, status: 'complete', destination, runId,
      output: body, outputManifestDigest: digest(entries.sort((a, b) => a.name.localeCompare(b.name))) }
    await store.save('executions', id, operation)
    this.manifests.set(runId, { run_id: runId, digest: operation.outputManifestDigest })
    if (!this.lostReply) { this.lostReply = true; throw new Error('canary lost reply after sealed execution') }
    return operation
  }
}

const backend = new ContainerBackend(store, project.backend)
await assert.rejects(new SequenceRunner(store, backend).run(plan, start), /lost reply/)
assert.equal(backend.calls, 1)
const receipt = await new SequenceRunner(store, backend).run(plan, start)
assert.equal(backend.calls, 2)
assert.deepEqual(await new SequenceRunner(store, backend).run(plan, start), receipt)
assert.equal(backend.calls, 2)
assert.equal(receipt.delivery.protocol, 'analysis-cv-selection@1')
assert.equal(receipt.total_score, 0.5)
await backend.verifyReceipt(receipt)

const refitDirectory = join(root, 'refitted'), out = join(root, 'submission')
await assert.rejects(exportSubmission(directory, plan.digest, out, { backend }), /run hitch-analysis refit first/)
const fitted = await refit(store, backend, project, receipt, refitDirectory)
assert.equal(fitted.delivery.fits, 1); assert.equal(fitted.delivery.searchCalls, 0); assert.equal(fitted.delivery.modelRequests, 0)
assert.deepEqual(await refit(store, backend, project, receipt, refitDirectory), fitted)
const exported = await exportSubmission(directory, plan.digest, out, { backend, refitDirectory })
assert.equal(exported.solutionDigest, receipt.delivery.solutionDigest)
assert.deepEqual(await exportSubmission(directory, plan.digest, out, { backend, refitDirectory }), exported)
assert.equal(exported.rawScore, null) // CV is never presented as an independent test score.
assert.equal(sha(await readFile(join(out, 'submission.csv'))), fitted.submissionDigest)
await writeFile(join(out, 'submission.csv'), 'tampered')
await assert.rejects(exportSubmission(directory, plan.digest, out, { backend, refitDirectory }))
console.log(JSON.stringify({ installedJourney: 'passed', researchFits: 20, recoveredWithoutExtraFit: true,
  frozenRefitFits: 1, refitBackend: 'hitch-eval', modelRequests: 0, selectedSolutionExport: 'passed' }))
