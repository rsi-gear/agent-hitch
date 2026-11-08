#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runNativeMlebench, installMlebenchCompetition } from 'agent-hitch/analysis'
import { cli, isMain } from './lib/common.mjs'
import { inspectMlebench } from './lib/mlebench.mjs'
import { assert, seal, sha, verify } from './lib/contracts.mjs'
import { Store, json, atomicJson, optionalJson } from './lib/store.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { validateTabularSubmission } from './lib/submission.mjs'

export async function exportSubmission(directory, sequence, destination, { refitDirectory, backend } = {}) {
  directory = resolve(directory)
  const project = await json(join(directory, 'project.json')), store = new Store(join(directory, 'research'))
  const state = await store.load('sequences', sequence.replace(/^sha256:/, ''))
  assert(state?.receipt && state.receipt.delivery.status === 'completed' && project.task.benchmark, 'valid MLE-bench final selected solution required')
  verify(state.plan); verify(state.receipt)
  assert(state.plan.task.digest === project.task.digest && state.receipt.planDigest === state.plan.digest
    && state.receipt.selections.at(-1).incumbentSolutionDigest === state.receipt.delivery.solutionDigest, 'export must use this task and its actual final selected solution')
  backend ??= new HitchBackend(store, project.backend); await backend.admit(state.plan); await backend.verifyReceipt(state.receipt)
  let delivered = state.receipt.delivery
  if (delivered.protocol === 'analysis-cv-selection@1') {
    assert(refitDirectory, 'CV selection has no test predictions; run hitch-analysis refit first and pass --refit DIRECTORY')
    assert(project.backend.refit.scope === 'mle-bench-public', 'deployment predictions cannot be exported as a benchmark submission')
    const result = verify(await json(join(resolve(refitDirectory), 'refit.json')))
    const registered = await store.load('refits', result.requestDigest.slice(7))
    assert(result.protocol === 'analysis-refit-result@1' && registered && verify(registered).digest === result.digest
      && result.delivery.requestDigest === result.requestDigest && result.selectionPlan.sourceSequenceReceiptDigest === state.receipt.digest
      && result.delivery.solutionDigest === delivered.solutionDigest && result.delivery.status === 'completed', 'refit does not belong to the final selected solution')
    delivered = result.delivery
  }
  const op = await store.load('executions', delivered.requestDigest.slice(7))
  assert(op?.status === 'complete' && op.runId === delivered.runId && op.outputManifestDigest === delivered.outputManifestDigest, 'sealed final execution unavailable')
  const manifest = await backend.hitch(['runs', 'artifacts', 'list', delivered.runId, '--json'], { executor: true })
  assert(manifest.run_id === delivered.runId && manifest.digest === delivered.outputManifestDigest, 'sealed final execution artifacts changed')
  const bytes = await readFile(join(op.destination, 'output/predictions.csv'))
  assert(sha(bytes) === delivered.predictionsDigest, 'sealed final selected solution predictions changed')
  validateTabularSubmission(bytes, project.task)
  const out = resolve(destination); await mkdir(out, { recursive: true })
  try { await writeFile(join(out, 'submission.csv'), bytes, { flag: 'wx' }) }
  catch (e) { if (e.code !== 'EEXIST' || sha(await readFile(join(out, 'submission.csv'))) !== sha(bytes)) throw e }
  const report = seal({ protocol: 'mlebench-sealed-submission@1', competition_id: project.task.benchmark.competitionId,
    submission_path: join(out, 'submission.csv'), submissionDigest: sha(bytes), sequenceReceiptDigest: state.receipt.digest,
    runId: delivered.runId, solutionDigest: delivered.solutionDigest, rawScore: delivered.score ?? null, metric: delivered.metric ?? project.task.prediction.metric })
  const existing = await optionalJson(join(out, 'receipt.json'))
  if (existing) { verify(existing); assert(existing.digest === report.digest, 'export directory belongs to another sequence') }
  await atomicJson(join(out, 'receipt.json'), report)
  await writeFile(join(out, 'submissions.jsonl'), JSON.stringify({ competition_id: report.competition_id, submission_path: report.submission_path }) + '\n')
  return report
}

export async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(['repository', 'data-root', 'competition', 'python', 'project', 'sequence', 'out', 'submission', 'refit'].map(k => [k, { type: 'string' }])),
    fixture: { type: 'boolean' }, 'record-checksums': { type: 'boolean' },
  } })
  const action = positionals[0]
  if (action === 'export') {
    assert(v.project && v.sequence && v.out, '--project, --sequence, --out required')
    console.log(JSON.stringify(await exportSubmission(v.project, v.sequence, v.out, { refitDirectory: v.refit }))); return
  }
  assert(v.repository && v['data-root'] && v.competition, '--repository, --data-root, --competition required')
  const options = { repository: resolve(v.repository), dataRoot: resolve(v['data-root']), competition: v.competition, fixture: v.fixture ?? false }
  if (action === 'install-competition') {
    await installMlebenchCompetition(options.competition, join(options.repository, 'mlebench/competitions', options.competition)); return
  }
  if (action === 'inspect') { console.log(JSON.stringify((await inspectMlebench(options)).descriptor, null, 2)); return }
  assert(['prepare-local', 'grade'].includes(action), 'action must be inspect, prepare-local, grade or export')
  if (action === 'grade') { assert(v.submission, '--submission required'); await inspectMlebench(options) }
  const output = await runNativeMlebench(action === 'grade' ? 'grade' : 'prepare', { ...options,
    python: v.python, submission: v.submission, recordChecksums: v['record-checksums'] })
  console.log(JSON.stringify(output))
}
if (isMain(import.meta.url)) cli(main)
