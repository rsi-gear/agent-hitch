import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, atomicJson } from '../../research/lib/store.mjs'
import { digest, seal, sha } from '../../research/lib/contracts.mjs'
import { exportSubmission } from '../../research/mlebench.mjs'

test('CV export requires its registered refit and never trains, substitutes a source or invents a test score', async t => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-export-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'research')), solution = digest('actual final selection')
  const task = seal({ prediction: { kind: 'tabular', metric: 'auc-roc', idColumn: 'id', targetColumns: ['target'], labels: ['0','1'] },
    predictIds: ['1','2'], benchmark: { competitionId: 'test' } })
  const project = { task, backend: { refit: { scope: 'mle-bench-public' } } }
  await atomicJson(join(root, 'project.json'), project)
  const plan = seal({ task }), selected = seal({ protocol: 'analysis-cv-selection@1', status: 'completed', solutionDigest: solution })
  const receipt = seal({ planDigest: plan.digest, delivery: selected, selections: [{ incumbentSolutionDigest: solution }] })
  await store.save('sequences', plan.digest.slice(7), { plan, receipt })
  const destination = join(root, 'execution'), refitDirectory = join(root, 'refit'), out = join(root, 'export')
  await mkdir(join(destination, 'output'), { recursive: true })
  const predictions = Buffer.from('id,target\n1,0.4\n2,0.6\n')
  await writeFile(join(destination, 'output/predictions.csv'), predictions)
  const delivered = seal({ requestDigest: digest('refit request'), status: 'completed', solutionDigest: solution,
    runId: 'refit-run', outputManifestDigest: digest('output manifest'), predictionsDigest: sha(predictions), score: null, metric: 'auc-roc' })
  const result = seal({ protocol: 'analysis-refit-result@1', requestDigest: delivered.requestDigest,
    selectionPlan: { sourceSequenceReceiptDigest: receipt.digest }, delivery: delivered })
  const operation = { status: 'complete', destination, runId: delivered.runId, outputManifestDigest: delivered.outputManifestDigest }
  await store.save('executions', delivered.requestDigest.slice(7), operation)
  await store.save('refits', delivered.requestDigest.slice(7), result)
  await atomicJson(join(refitDirectory, 'refit.json'), result)
  const backend = { async admit(value) { assert.deepEqual(value, plan) }, async verifyReceipt(value) { assert.deepEqual(value, receipt) },
    async hitch(args) { assert.deepEqual(args, ['runs', 'artifacts', 'list', delivered.runId, '--json']);
      return { run_id: delivered.runId, digest: delivered.outputManifestDigest } } }
  await assert.rejects(exportSubmission(root, plan.digest, out, { backend }), /run hitch-analysis refit first/)
  const first = await exportSubmission(root, plan.digest, out, { backend, refitDirectory })
  assert.equal(first.solutionDigest, solution); assert.equal(first.rawScore, null)
  assert.deepEqual(await readFile(join(out, 'submission.csv')), predictions)
  assert.deepEqual(await exportSubmission(root, plan.digest, out, { backend, refitDirectory }), first)
  const { digest: _, ...body } = result
  await atomicJson(join(refitDirectory, 'refit.json'), seal({ ...body, delivery: { ...delivered, solutionDigest: digest('historical best') } }))
  await assert.rejects(exportSubmission(root, plan.digest, out, { backend, refitDirectory }), /final selected solution/)
  await atomicJson(join(refitDirectory, 'refit.json'), result)
  await writeFile(join(destination, 'output/predictions.csv'), 'tampered')
  await assert.rejects(exportSubmission(root, plan.digest, out, { backend, refitDirectory }), /predictions changed/)
  await atomicJson(join(root, 'project.json'), { ...project, backend: { refit: { scope: 'kaggle-official-deployment' } } })
  await assert.rejects(exportSubmission(root, plan.digest, out, { backend, refitDirectory }), /deployment predictions/)
})
