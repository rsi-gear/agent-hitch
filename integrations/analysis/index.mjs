/** Published analysis integration. Callers never resolve repository-private paths. */
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assert, digest, seal, sha } from './protocol.mjs'
import { command } from '../../benchmark-packages/kaggle/mlebench/support.mjs'

export { validateTabularSubmission } from '../../benchmark-packages/kaggle/mlebench/submission.mjs'
export { schema, validateRequest, validateSchema } from '../../benchmark-packages/kaggle/analysis-contracts/schemas.mjs'
export { upstreamRevision, fileHash, treeManifest, inspectMlebench, importMlebench } from '../../benchmark-packages/kaggle/mlebench/import.mjs'
export { prepareTabularData, inspectDeploymentData, installMlebenchCompetition, runNativeMlebench } from '../../benchmark-packages/kaggle/mlebench/native.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runtime = join(root, 'integrations/analysis-runtime')
const workerNames = ['client.mjs', 'confinement.py', 'pipeline_runner.py', 'research_worker.py', 'scoring.py', 'worker.py']
const contractRoot = join(root, 'benchmark-packages/kaggle/analysis-contracts')

async function regular(path) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 16 * 1024 ** 2, 'expected bounded regular analysis asset')
  return readFile(path)
}

export async function describeAnalysisRuntime() {
  const bytes = await regular(join(runtime, 'runtime-integrity.json'))
  const entry = await regular(join(root, 'integrations/sealed-python/cli.js'))
  const approved = entry.toString().match(/RUNTIME_MANIFEST_DIGEST = '(sha256:[a-f0-9]{64})'/)?.[1]
  assert(approved && sha(bytes) === approved, 'analysis runtime manifest differs from the sealed executor')
  const manifest = JSON.parse(bytes)
  assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(workerNames), 'unexpected analysis runtime closure')
  const files = []
  for (const path of workerNames) {
    const contents = await regular(join(runtime, path))
    assert(sha(contents) === manifest[path], `analysis runtime changed: ${path}`)
    files.push({ path, digest: manifest[path], bytes: contents.length })
  }
  return seal({ protocol: 'hitch-analysis-runtime@1', manifestDigest: approved, files })
}

/** Materialize only authenticated release bytes; never overwrite a registered carrier. */
export async function materializeAnalysisRuntime(destination, { expectedDigest } = {}) {
  const descriptor = await describeAnalysisRuntime()
  assert(!expectedDigest || descriptor.digest === expectedDigest, 'analysis runtime version differs from the frozen binding')
  destination = resolve(destination)
  assert(!await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null }), 'runtime destination already exists')
  await mkdir(dirname(destination), { recursive: true })
  const temporary = await mkdtemp(join(dirname(destination), '.analysis-runtime-'))
  try {
    for (const file of [...descriptor.files, { path: 'runtime-integrity.json', digest: descriptor.manifestDigest }]) {
      const bytes = await regular(join(runtime, file.path))
      assert(sha(bytes) === file.digest, 'analysis runtime changed during materialization')
      await writeFile(join(temporary, file.path), bytes, { flag: 'wx', mode: 0o444 })
    }
    // A task-owned destination is new and is registered only after this atomic rename.
    assert(!await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null }), 'runtime destination already exists')
    await rename(temporary, destination)
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return descriptor
}

export async function verifyAnalysisRuntime(directory, expected) {
  assert(expected?.protocol === 'hitch-analysis-runtime@1', 'analysis runtime descriptor required')
  const { digest: expectedDigest, ...body } = expected
  assert(digest(body) === expectedDigest && JSON.stringify(expected.files.map(f => f.path)) === JSON.stringify(workerNames), 'invalid analysis runtime descriptor')
  const manifest = await regular(join(directory, 'runtime-integrity.json'))
  assert(sha(manifest) === expected.manifestDigest, 'analysis runtime manifest changed')
  const hashes = JSON.parse(manifest)
  for (const file of expected.files) {
    const bytes = await regular(join(directory, file.path))
    assert(bytes.length === file.bytes && sha(bytes) === file.digest && hashes[file.path] === file.digest, `analysis runtime changed: ${file.path}`)
  }
  return expected
}

export async function readAnalysisContract(name) {
  assert(['schemas.mjs', 'analysis.schema.json', 'golden.json'].includes(name), 'unknown analysis contract asset')
  return regular(join(contractRoot, name))
}

/** The public binding preserves existing producer/verifier/schema/scoring identities. */
export async function describeAnalysisIntegration() {
  const sources = {
    producer: 'benchmark-packages/kaggle/analysis.mjs',
    verifier: 'benchmark-packages/kaggle/runtime/analysis-verify.py',
    schema: 'benchmark-packages/kaggle/analysis-contracts/schemas.mjs',
    scoring: 'integrations/analysis-runtime/scoring.py',
  }
  const execution = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, path]) => [key, sha(await regular(join(root, path)))])))
  return seal({ protocol: 'hitch-analysis-integration@1', runtime: await describeAnalysisRuntime(), execution })
}

export async function prepareAnalysisTask(options, resourceRequest) {
  const { produceAnalysisTask } = await import('../../benchmark-packages/kaggle/analysis.mjs')
  return produceAnalysisTask(options, resourceRequest)
}

/** Create an executable client from the installed package, without requiring a checkout. */
export async function materializeAnalysisClient(destination) {
  const entry = join(root, 'dist/bin/hitch.js')
  await regular(entry)
  await mkdir(dirname(resolve(destination)), { recursive: true })
  await writeFile(destination, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`, { flag: 'wx', mode: 0o755 })
  return resolve(destination)
}

/** The generic Git harness resolver consumes an exact snapshot of installed release assets. */
export async function materializeAnalysisExecutor(destination, { expectedDigest } = {}) {
  destination = resolve(destination)
  await mkdir(destination)
  await mkdir(join(destination, 'integrations/sealed-python'), { recursive: true })
  const runtime = await materializeAnalysisRuntime(join(destination, 'integrations/analysis-runtime'), { expectedDigest })
  await writeFile(join(destination, 'integrations/sealed-python/cli.js'), await regular(join(root, 'integrations/sealed-python/cli.js')), { flag: 'wx', mode: 0o755 })
  await writeFile(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n', { flag: 'wx' })
  const git = args => command('git', args, { cwd: destination })
  await git(['init', '--quiet', '-b', 'analysis-runtime'])
  await git(['add', 'integrations', 'package.json'])
  await git(['-c', 'user.name=Hitch Runtime', '-c', 'user.email=runtime@hitch.invalid', 'commit', '--no-gpg-sign', '-qm', 'Seal installed analysis runtime'])
  return { repository: destination, commit: await git(['rev-parse', 'HEAD']), runtime }
}

export { prepare as prepareAnalysisProject, bootstrap as bootstrapAnalysisHarness, sealHarness } from '../../benchmark-packages/kaggle/research/prepare.mjs'
export { buildProject as exportOptimizationProject } from '../../benchmark-packages/kaggle/research/project.mjs'
export { AnalysisOperationProvider } from '../../benchmark-packages/kaggle/research/lib/operation-provider.mjs'

export { configureExperiment as configureAnalysisExperiment } from '../../benchmark-packages/kaggle/research/lib/experiment-config.mjs'
