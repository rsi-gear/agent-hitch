#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli, isMain } from './lib/common.mjs'
import { json, optionalJson, Store } from './lib/store.mjs'
import { configureExperiment } from './lib/experiment-config.mjs'
import { researchConfig } from './lib/research-config.mjs'
import { roundValidation } from './lib/validation.mjs'
import { assert, digest } from './lib/contracts.mjs'
import { metrics, objective } from './lib/operation-provider.mjs'
import { copyRegisteredTarget } from './lib/target-source.mjs'

async function immutableJson(path, value) {
  const previous = await optionalJson(path)
  if (previous) { assert(digest(previous) === digest(value), `project configuration changed: ${path}`); return }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
/** Export a generic optimization client configuration; the client owns optimization and promotion. */
export async function buildProject(directory, { metaProfile, checkpointRef, registered, stageId, maxCandidates = 1, passEnv = [], out, experiment } = {}) {
  directory = resolve(directory)
  const explicitCheckpoint = checkpointRef
  const configured = await configureExperiment(directory, experiment)
  directory = configured.directory
  const project = configured.project, store = new Store(join(directory, 'research'))
  const head = await store.load('projects', project.projectId)
  checkpointRef ??= head.checkpoint
  const checkpoint = await store.get(checkpointRef)
  const research = researchConfig(project.research)
  if (!registered) {
    const event = head.stage ? await store.get(head.stage) : null
    const commit = event?.adoptedCommit ?? project.harness.commit
    const { command } = await import('./lib/common.mjs')
    const manifest = JSON.parse(await command('git', ['show', `${commit}:harness/manifest.json`], { cwd: project.targetRepository }))
    registered = [{ commit, manifestDigest: manifest.digest }]
  }
  assert(registered.length === 1 || registered.length === 2, 'one anchor or two registered methods required')
  assert(registered.length === 2 || metaProfile, '--meta-profile is required for autonomous refinement')
  assert(Number.isSafeInteger(maxCandidates) && maxCandidates > 0, 'maxCandidates must be positive')
  if (registered.length === 2) assert(maxCandidates === 1, 'registered comparison has exactly one candidate')
  const cohort = out ? resolve(out) : join(directory, 'clients', digest({ checkpointRef, registered, stageId: stageId ?? null }).slice(7))
  const validation = roundValidation(project.task, checkpoint.digest)
  if (validation) await immutableJson(join(cohort, 'validation.json'), validation)
  const configuration = { project: directory, projectDigest: digest(project), ...(explicitCheckpoint || checkpointRef !== project.checkpointRef ? { checkpointRef } : {}), registered, ...(project.experiment ? { experiment: project.experiment } : {}) }
  const profile = { command: [process.execPath, fileURLToPath(new URL('./provider.mjs', import.meta.url))],
    workingDirectory: directory, configuration,
    passEnv: [...new Set(['HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GEAR_TARGET_CODEX_AUTH_FILE', 'GEAR_DSH_CODEX_MODULE', ...passEnv])].sort(),
    timeoutMs: Math.ceil((project.budget.wallSeconds + 300) * 1000) }
  const targetProfile = `hitch-analysis-${digest(profile).slice(7,39)}`
  await immutableJson(join(cohort, 'provider-profile.json'), profile)
  const config = { version: 1, benchmark: 'benchmark.yaml', target: { adapter: 'dsh', path: 'target', profile: targetProfile },
    meta: { profile: registered.length === 2 ? targetProfile : metaProfile }, algorithm: 'gepa', objective, metrics: metrics(project.task),
    validation: { mode: 'research' }, evaluation: { repair: { max_retries: 0, max_projections: 0, backoff_ms: [0] } },
    budget: { rounds: 1, max_evaluations: maxCandidates + 1, max_candidates: maxCandidates, repetitions: 1 } }
  const existing = await optionalJson(join(cohort, 'gear.yaml'))
  if (!existing) await copyRegisteredTarget(project.targetRepository, registered[0], join(cohort, 'target'))
  await immutableJson(join(cohort, 'gear.yaml'), config)
  await immutableJson(join(cohort, 'benchmark.yaml'), { version: 1, source: 'tasks.jsonl', template: 'text' })
  const guidance = await readFile(new URL('./meta-task-context.txt', import.meta.url), 'utf8')
  const task = { id: project.task.taskId, family: project.task.taskFamilyId, split: 'seed', expected: 'sequence-receipt',
    instruction: `analysis-research-sequence@1\n${project.task.description}\nEach method receives the sequential experiment budget and starting checkpoint frozen by its provider configuration. `
      + 'Improve workflow.yaml, prompts, skills, workflows/research and tools/experiment. Preserve the empty preset and fixed carrier. '
      + (validation ? 'Every candidate uses the frozen outer evaluation policy and the same materialized row assignments. Compare the selected solution by mean CV utility, with no extra local test. '
        : 'This frozen legacy project retains its original validation protocol. ')
      + 'This is shared-set development evidence.\n\n' + guidance }
  const row = JSON.stringify(task) + '\n'
  try { await writeFile(join(cohort, 'tasks.jsonl'), row, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert(await readFile(join(cohort, 'tasks.jsonl'), 'utf8') === row, 'frozen task changed') }
  return { cohort, config, project, store, checkpoint, registered, configuration, profile, targetProfile,
    budgetPreview: { sequences: maxCandidates + 1, experimentsPerHarness: research.maxExperiments, researchRollouts: research.maxExperiments * (maxCandidates + 1),
      validation: validation ? { mode: project.task.evaluationPlan ? 'frozen_outer_validation' : 'round_five_fold_cv', ...validation } : { mode: project.task.protocol === 'analysis-task@3' ? 'holdout' : 'legacy-cv', ...research.validation },
      deliveries: validation ? 0 : maxCandidates + 1, repetitions: 1, sequenceWallSeconds: project.budget.wallSeconds,
      sequenceCpuSeconds: project.budget.cpuSeconds, experimentWallSeconds: project.budget.experimentWallSeconds,
      experimentCpuSeconds: project.budget.experimentCpuSeconds, model: project.modelAccounting } }
}

export async function main() {
  const { values: v } = parseArgs({ options: { project: { type: 'string' }, out: { type: 'string' }, 'meta-profile': { type: 'string' }, 'experiment-config': { type: 'string' } } })
  assert(v.project && v.out && v['meta-profile'], '--project, --out and --meta-profile required')
  const built = await buildProject(v.project, { out: v.out, metaProfile: v['meta-profile'], ...(v['experiment-config'] ? { experiment: await json(resolve(v['experiment-config'])) } : {}) })
  console.log(JSON.stringify({ project: built.cohort, profile: built.targetProfile,
    profileFile: join(built.cohort, 'provider-profile.json'), budgetPreview: built.budgetPreview }))
}
if (isMain(import.meta.url)) cli(main)
