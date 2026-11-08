import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './common.mjs'
import { assert, digest, initialCheckpoint, researchBudget, seal } from './contracts.mjs'
import { experimentConfig, researchConfig } from './research-config.mjs'
import { atomicJson, json, optionalJson, Store, locked } from './store.mjs'
import { fileHash } from './mlebench.mjs'
import { executionBinding, refitBinding } from './hitch-backend.mjs'

export async function materializeValidation(train, prediction, supplied, { python } = {}) {
  const experiment = experimentConfig(supplied, prediction.metric)
  const configurationDigest = digest(experiment), trainDigest = await fileHash(train)
  const policyDigest = digest({ protocol: 'analysis-evaluation-policy@1', experiment, trainDigest, metric: prediction.metric })
  const planner = fileURLToPath(new URL('../../../../integrations/analysis-runtime/research_worker.py', import.meta.url))
  const plan = JSON.parse(await command(python ?? process.env.GEAR_MLEBENCH_PYTHON ?? 'python3', [planner,
    JSON.stringify({ train, prediction, policy: { experiment, configurationDigest, policyDigest } })]))
  assert(plan.configurationDigest === configurationDigest && plan.trainDigest === trainDigest, 'data changed while materializing validation')
  return { experiment, plan }
}

export async function registerExperiment(directory, experiment) {
  const path = join(directory, 'experiment-versions', `${experiment.version}.json`)
  await mkdir(join(directory, 'experiment-versions'), { recursive: true })
  try { await writeFile(path, JSON.stringify(experiment) + '\n', { flag: 'wx', mode: 0o444 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert(digest(await json(path)) === digest(experiment), 'experiment version already exists with different configuration; choose a new version')
  }
}

/** A new policy starts a separate history and budget. Existing assignments never get redrawn. */
export async function configureExperiment(directory, supplied) {
  directory = resolve(directory)
  const base = await json(join(directory, 'project.json'))
  supplied ??= base.experiment
  if (!supplied) return { directory, project: base }
  const experiment = experimentConfig(supplied, base.task.prediction.metric)
  if (base.experimentRoot && base.experimentRoot !== directory) {
    const origin = await json(join(base.experimentRoot, 'project.json'))
    assert(digest(origin) === base.parentProjectDigest, 'parent experiment project changed')
    if (digest(base.experiment) !== digest(experiment)) return configureExperiment(base.experimentRoot, experiment)
  }
  await registerExperiment(base.experimentRoot ?? directory, experiment)
  if (base.experiment && digest(base.experiment) === digest(experiment)) {
    assert(digest(await json(join(directory, 'data/validation.json'))) === digest(base.validationPlan), 'frozen row assignments changed')
    return { directory, project: base }
  }
  const destination = join(directory, 'experiments', digest(experiment).slice(7))
  const existing = await optionalJson(join(destination, 'project.json'))
  if (existing) {
    assert(digest(existing.experiment) === digest(experiment) && existing.parentProjectDigest === digest(base), 'experiment context changed')
    assert(digest(await json(join(destination, 'data/validation.json'))) === digest(existing.validationPlan), 'frozen row assignments changed')
    return { directory: destination, project: existing }
  }
  const store = new Store(join(destination, 'research'))
  return locked(store.path('locks', 'initialize'), async () => {
    const persisted = await optionalJson(join(destination, 'data/validation.json'))
    const plan = persisted ?? (await materializeValidation(base.backend.train, base.task.prediction, experiment)).plan
    assert(plan.configurationDigest === digest(experiment) && plan.trainDigest === await fileHash(base.backend.train), 'frozen experiment data or policy changed')
    const { digest: _, ...body } = base.task
    const task = seal({ ...body, protocol: base.task.benchmark ? 'analysis-task@7' : 'analysis-task@8',
      experiment, evaluationPlan: plan, validationPlanDigest: plan.policyDigest })
    const research = researchConfig({ maxExperiments: experiment.maxExperiments, validation: experiment.validation }), budget = researchBudget(research)
    const projectId = `${base.projectId}-${digest(experiment).slice(7, 23)}`
    const checkpoint = initialCheckpoint({ researchProjectId: projectId, taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
      dataScopeDigest: digest(task.benchmark ? { inputs: task.inputs, benchmark: task.benchmark } : task.inputs),
      validationPlanDigest: task.validationPlanDigest, runtimeDigest: task.runtimeDigest,
      scorerDigest: digest({ metric: task.prediction.metric, scoringDigest: base.runtime.scoringDigest, selection: 'frozen-outer-mean@1' }) })
    const checkpointRef = await store.put(checkpoint)
    const project = { ...base, projectId, task, experiment, research, budget, checkpointRef, validationPlan: plan,
      parentProjectDigest: digest(base), experimentRoot: directory, projectLimits: { ...base.projectLimits,
        maxTargetExperiments: base.projectLimits.maxSequences * research.maxExperiments,
        cpuSeconds: base.projectLimits.maxSequences * budget.cpuSeconds, wallSeconds: base.projectLimits.maxSequences * budget.wallSeconds },
      backend: { ...base.backend, workDirectory: destination, validationPlan: plan } }
    if (!persisted) await atomicJson(join(destination, 'data/validation.json'), plan)
    await store.save('projects', projectId, { checkpoint: checkpointRef, stage: null, previousStage: null })
    await store.save('bindings', 'execution', await executionBinding(project.backend))
    await store.save('bindings', 'refit', await refitBinding(project.backend))
    await atomicJson(join(destination, 'project.json'), project)
    return { directory: destination, project }
  })
}
