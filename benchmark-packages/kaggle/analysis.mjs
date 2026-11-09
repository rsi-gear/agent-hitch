// One ordinary Harbor task: public inputs -> unrestricted agent tools -> sealed
// output artifacts -> a separate verifier. This module owns no research lifecycle.
import { cp, mkdir, copyFile, readFile, writeFile, mkdtemp, rm, rename, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assert, canonical, digest, sha, validateDelivery, validateEvaluation, defaultParameters, bindBenchmarkCapabilities } from './mlebench/schema.mjs';
import { treeManifest, fileHash } from './mlebench/files.mjs';
const here = import.meta.dirname;
const capabilities = ['tree@1', 'oci-image@1', 'private-copy@1', 'harbor-role-context@1'];

export async function produceTask(options, resourceRequest) {
  const allowed = ['root', 'out', 'id', 'instruction', 'publicDirectory', 'delivery', 'evaluation', 'expected', 'nativeGraderDirectory', 'parameters', 'userParameters', 'parameterPolicy', 'baseImage', 'platform', 'timeoutSeconds', 'cpus', 'memoryMb', 'provenance', 'trustedTraining'];
  assert(options && Object.keys(options).every(k => allowed.includes(k)), 'unsupported task input; import a new task instead of an old research request');
  const { root, out, instruction, publicDirectory, expected, nativeGraderDirectory, baseImage } = options;
  assert(typeof root === 'string' && typeof out === 'string' && typeof publicDirectory === 'string', 'root, out and publicDirectory required');
  assert(typeof instruction === 'string' && instruction.trim(), 'task instruction required');
  const delivery = validateDelivery(options.delivery), evaluation = validateEvaluation(options.evaluation);
  if (evaluation.mode === 'scored') {
    assert(delivery.valueType === ({ accuracy: 'label', 'auc-roc': 'probability', 'mean-column-wise-rmsle': 'nonnegative' })[evaluation.metric], 'delivery domain does not match the declared metric');
    assert(evaluation.metric === 'mean-column-wise-rmsle' || delivery.targetColumns.length === 1, 'classification metrics require one target');
  }
  assert(evaluation.mode === 'scored' ? typeof expected === 'string' : expected === undefined, 'scored tasks require private answers; delivery tasks cannot have private answers');
  assert(evaluation.grader?.kind === 'native' ? typeof nativeGraderDirectory === 'string' : nativeGraderDirectory === undefined, 'native grader source binding mismatch');
  assert(/^[^\s]+@sha256:[a-f0-9]{64}$/.test(baseImage) && /^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(options.platform ?? 'linux/amd64'), 'pinned runtime image and Linux platform required');
  const platform = options.platform ?? 'linux/amd64', timeoutSeconds = options.timeoutSeconds ?? 3600, cpus = options.cpus ?? 2, memoryMb = options.memoryMb ?? 4096;
  assert(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 86400 && Number.isFinite(cpus) && cpus > 0
    && Number.isSafeInteger(memoryMb) && memoryMb >= 128, 'invalid task resource limits');
  assert(!await lstat(out).catch(e => { if (e.code !== 'ENOENT') throw e; }), 'output already exists');
  const { admitParameters, admitTaskParameters, validateParameterContract } = await import('agent-hitch/parameters');
  const trusted = options.trustedTraining;
  let plugin;
  if (trusted !== undefined) {
    assert(trusted && trusted.version === 1 && trusted.coverage === 'trusted-service-top-level-attempts'
      && Object.keys(trusted).every(k => ['version', 'coverage', 'maxActionSeconds'].includes(k)), 'trustedTraining must explicitly declare supported service-only coverage');
    assert(Number.isInteger(cpus) && cpus >= 3 && memoryMb >= 1536, 'trusted training requires a total budget of at least 3 CPUs and 1536 MiB');
    assert(delivery.path === 'submission.csv' && delivery.targetColumns.length === 1 && ['label', 'probability'].includes(delivery.valueType), 'trusted service supports one classification submission.csv');
    plugin = JSON.parse(await readFile(join(here, 'runtime/training-service.json'), 'utf8'));
  }
  const coverage = trusted ? trusted.coverage : 'all-training';
  const parameters = bindBenchmarkCapabilities(validateParameterContract(options.parameters ?? defaultParameters(coverage)), coverage);
  assert(parameters.evaluation_inputs === undefined && parameters.capability_bindings === undefined, 'task producer owns evaluation input and capability bindings');
  parameters.evaluation_inputs = ['instruction.md', 'resource.lock.json', 'task-contract.json', 'task.toml',
    'environment/candidate/Dockerfile', 'environment/docker-compose.yaml', 'tests/Dockerfile', 'tests/verify.py', 'tests/scoring.py', 'tests/test.sh'];
  if (trusted) {
    parameters.capability_bindings = [{ id: 'trainer', plugin: plugin.id, protocol: plugin.protocol,
      capabilities: plugin.capabilities, coverage: plugin.coverage, service: 'trainer', output_directory: '/output', entrypoint: plugin.entrypoint,
      source: { path: 'environment/services/trainer/runner.py', sha256: await fileHash(join(here, 'runtime/training-service.py')) },
      runtime_image: baseImage, dependencies: plugin.dependencies, dependency_packages: plugin.dependency_packages,
      counter: { limit_parameter: '/training/max_fits', unit: plugin.count_unit },
      max_action_seconds: trusted.maxActionSeconds ?? timeoutSeconds,
      resource_budget: { cpu_millis: cpus * 1000, memory_bytes: memoryMb * 1024 ** 2 } }];
    parameters.evaluation_inputs.push('environment/services/trainer/Dockerfile', 'environment/services/trainer/runner.py');
  }
  // Ordinary/default admission stays fail-closed before any resource work.
  // Trusted bindings are verified against the staged isolated role below.
  if (!trusted) admitParameters(parameters, {
    ...(options.userParameters !== undefined ? { user: options.userParameters } : {}),
    ...(options.parameterPolicy !== undefined ? { policy: options.parameterPolicy } : {}),
  });
  const parameterOverrides = options.userParameters !== undefined || options.parameterPolicy !== undefined
    ? { version: 1, ...(options.userParameters !== undefined ? { parameters: options.userParameters } : {}),
      ...(options.parameterPolicy !== undefined ? { parameter_policy: options.parameterPolicy } : {}) } : undefined;
  const publicRoot = await realpath(publicDirectory), publicFiles = await treeManifest(publicRoot);
  assert(publicFiles.length > 0 && !publicFiles.some(f => ['parameters.json', 'service-task.json'].includes(f.path)), 'public inputs cannot replace the authoritative parameters copy');
  if (expected) assert(!(await realpath(expected)).startsWith(publicRoot + sep), 'private answers cannot be inside public inputs');
  const privateAnswersDigest = expected ? await fileHash(expected) : null;
  const graderFiles = nativeGraderDirectory ? await treeManifest(nativeGraderDirectory) : [];
  if (options.provenance?.publicTreeDigest) assert(digest(publicFiles) === options.provenance.publicTreeDigest, 'public provenance changed before sealing');
  if (options.provenance?.privateAnswersDigest) assert(privateAnswersDigest === options.provenance.privateAnswersDigest, 'private provenance changed before sealing');
  if (evaluation.grader?.sourceDigest) assert(digest(graderFiles) === evaluation.grader.sourceDigest, 'native grader provenance changed before sealing');
  const verifierFiles = ['verify.py', 'scoring.py'];
  const revision = digest(Object.fromEntries(await Promise.all(verifierFiles.map(async name => [name, sha(await readFile(join(here, 'runtime', name)))]))));
  const taskBody = { version: 1, delivery, evaluation, parameters, ...(trusted ? { trustedTraining: { ...trusted, binding: 'trainer', count_unit: plugin.count_unit, source_digest: parameters.capability_bindings[0].source.sha256 } } : {}), ...(parameterOverrides ? { parameterOverrides } : {}), publicFiles, privateAnswersDigest,
    graderFiles, verifierRevision: revision, runtime: { image: baseImage, platform, cpus, memoryMb, timeoutSeconds }, provenance: options.provenance ?? {} };
  const taskIdentity = digest(taskBody), id = options.id ?? `task-${taskIdentity.slice(7, 31)}`;
  assert(typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id), 'invalid task ID');
  const staging = `${resolve(out)}.partial-${randomUUID()}`, temporary = await mkdtemp(join(tmpdir(), 'hitch-task-'));
  const leases = [], owner = `producer:task:${taskIdentity}:${randomUUID()}`;
  resourceRequest ??= (await import('agent-hitch/resources')).resourceRequest;
  try {
    const publicStage = join(temporary, 'public'), privateStage = join(temporary, 'private');
    await cp(publicRoot, publicStage, { recursive: true }); await mkdir(privateStage);
    await writeFile(join(publicStage, 'parameters.json'), canonical(parameters));
    await writeFile(join(privateStage, 'task.json'), canonical({ ...taskBody, taskIdentity }));
    if (expected) await copyFile(expected, join(privateStage, 'expected.csv'));
    if (nativeGraderDirectory) await cp(nativeGraderDirectory, join(privateStage, 'native'), { recursive: true });
    // Detect changes while copying before sealing either role's immutable resource.
    const stagedPublic = (await treeManifest(publicStage)).filter(f => f.path !== 'parameters.json');
    assert(canonical(stagedPublic) === canonical(publicFiles), 'public inputs changed during import');
    if (expected) assert(await fileHash(join(privateStage, 'expected.csv')) === privateAnswersDigest, 'private answers changed during import');
    if (nativeGraderDirectory) assert(canonical(await treeManifest(join(privateStage, 'native'))) === canonical(graderFiles), 'grader changed during import');
    let trainerStage;
    if (trusted) {
      trainerStage = join(temporary, 'trainer'); await mkdir(trainerStage);
      for (const name of ['train.csv', 'test.csv']) {
        assert(publicFiles.some(f => f.path === name), 'trusted service requires declared train.csv and test.csv');
        await copyFile(join(publicStage, name), join(trainerStage, name));
      }
      await writeFile(join(trainerStage, 'service-task.json'), canonical({ version: 1, id_column: delivery.idColumn,
        target_column: delivery.targetColumns[0], predict_ids: delivery.predictIds,
        metric: delivery.valueType === 'label' ? 'accuracy' : 'auc-roc' }));
    }
    const resources = { runtime: { kind: 'oci-image', manifestDigest: baseImage.split('@')[1], platform } }, bindings = [];
    for (const [role, source] of [['candidate', publicStage], ['verifier', privateStage], ...(trusted ? [['trainer', trainerStage]] : [])]) {
      const imported = await resourceRequest(root, 'import', { kind: 'tree', source, owner: `${owner}:${role}` });
      leases.push(imported.leaseId); resources[role] = imported.resource;
      const consumer = role === 'trainer' ? { role: 'service', serviceId: 'trainer' } : { role };
      bindings.push({ resource: role, consumer, use: 'input-tree', target: role === 'verifier' ? 'private' : 'data', access: 'private-copy' });
      bindings.push({ resource: 'runtime', consumer, use: 'environment-image', slot: 'build-base' });
    }
    const task = join(staging, id);
    await mkdir(join(task, 'environment/candidate'), { recursive: true }); await mkdir(join(task, 'tests'));
    await writeFile(join(task, 'resource.lock.json'), canonical({ protocol: 'hitch-resource-lock@1', resources, bindings, requiredCapabilities: capabilities }));
    await writeFile(join(task, 'parameters.json'), canonical(parameters));
    if (parameterOverrides) await writeFile(join(task, 'parameter-overrides.json'), canonical(parameterOverrides));
    await writeFile(join(task, 'task-contract.json'), canonical({ ...taskBody, taskIdentity }));
    const quality = evaluation.mode === 'scored' ? `An independent verifier scores the submission using ${evaluation.metric} (${evaluation.version}).`
      : 'This is an unlabeled prediction delivery task. A valid submission proves delivery only; official test quality is unavailable. Internal CV is diagnostic, not an official score.';
    await writeFile(join(task, 'instruction.md'), `${instruction.trim()}\n\nPublic inputs are in /data. Complete analysis, training, final refit if needed, and prediction in this single task. Use ordinary shell, file and code tools. Write /output/${delivery.path} with columns ${[delivery.idColumn, ...delivery.targetColumns].join(', ')} in the supplied sample/test ID order. The limit is ${delivery.maxBytes} bytes. No special finish/select call is required.\n\n${quality}\n\nRead /data/parameters.json for task defaults and permitted paths. Its rules are frozen outside the sandbox. The generic configuration tool is: python3 /tmp/hitch-parameters.py show; to register a new training action, python3 /tmp/hitch-parameters.py submit ACTION_ID FULL_PARAMETERS_JSON_FILE. Register authorized changes before the action starts. Configuration registration does not certify code compliance; ordinary training observations and self-reported CV are unverified.\n`);
    if (trusted) {
      await writeFile(join(task, 'instruction.md'), (await readFile(join(task, 'instruction.md'), 'utf8')) + `
This task explicitly binds the trusted tabular service. Its fit limit covers only top-level attempts inside that service, not arbitrary learning elsewhere. Successful delivery must come from the service and match its host-verified evidence. Each CV fold and final fit consumes one attempt; failed attempts count. The host reserves the entire action before starting and preserves it across cancellation/recovery.
Call the generic service channel with: python3 /tmp/hitch-parameters.py call REQUEST_JSON_FILE.
An evaluation request is {"binding":"trainer","id":"model-a","parameter_action":"task","operation":"evaluate","arguments":{"model":{"algorithm":"logistic_regression","features":["NUMERIC_COLUMN"],"scale":true,"parameters":{"C":1,"max_iter":300,"fit_intercept":true}}}}.
Supported algorithms: logistic_regression (C>0 up to100, max_iter1..2000, fit_intercept boolean) or decision_tree (max_depth1..64, min_samples_leaf1..1024). Features must be named numeric input columns excluding ID and target; median imputation is automatic, scale is optional. Arbitrary imports, Python objects and factories are not supported by this opt-in service.
Use parameter_action:"task" for admitted task-start values, or the ID of a prior accepted parameter submission. For final delivery call {"binding":"trainer","id":"final","parameter_action":"task","operation":"deliver","arguments":{"source_action":"model-a"}}. This final fit and CSV write are part of this task. When freeze_selection is enabled, the chosen model/parameters cannot change during delivery. Reuse an action id only for an identical request; a retry never starts additional fits. Internal trusted CV remains diagnostic and is not the external quality score.
`);
    }
    const services = { main: { platform, build: { context: 'candidate', dockerfile: 'Dockerfile' }, user: '0:0', init: true } };
    if (trusted) {
      services.trainer = { platform, build: { context: 'services/trainer', dockerfile: 'Dockerfile' },
        network_mode: 'none', cpus: cpus - 2, mem_limit: (memoryMb - 1024) * 1024 ** 2, init: true };
      await mkdir(join(task, 'environment/services/trainer'), { recursive: true });
      await copyFile(join(here, 'runtime/training-service.py'), join(task, 'environment/services/trainer/runner.py'));
      await writeFile(join(task, 'environment/services/trainer/Dockerfile'), `FROM ${baseImage}\nCOPY data /data\nCOPY runner.py /opt/mlebench-service/runner.py\nRUN --network=none chmod -R a-w /data /opt/mlebench-service\nWORKDIR /opt/mlebench-service\nCMD ["sleep", "infinity"]\n`);
    }
    await writeFile(join(task, 'environment/docker-compose.yaml'), JSON.stringify({ services }));
    await writeFile(join(task, 'environment/candidate/Dockerfile'), `FROM ${baseImage}\nCOPY data /data\nRUN --network=none mkdir -p /app /output && chmod -R a-w /data\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
    const nativeProbe = evaluation.grader?.kind === 'native'
      ? `RUN --network=none PYTHONPATH=/tests/private/native python3 -c "import importlib; getattr(importlib.import_module('${evaluation.grader.entrypoint.split(':')[0]}'), '${evaluation.grader.entrypoint.split(':')[1]}')"\n` : '';
    await writeFile(join(task, 'tests/Dockerfile'), `FROM ${baseImage}\nCOPY . /tests\nWORKDIR /tests\n${nativeProbe}CMD ["sleep", "infinity"]\n`);
    for (const name of verifierFiles) await copyFile(join(here, 'runtime', name), join(task, 'tests', name));
    await writeFile(join(task, 'tests/test.sh'), '#!/bin/sh\nset -eu\npython3 /tests/verify.py --private /tests/private --output /output --result /logs/verifier\n', { mode: 0o755 });
    await writeFile(join(task, 'task.toml'), `schema_version = "1.4"\nartifacts = [{ source = "/output" }]\n[environment]\nworkdir = "/app"\nnetwork_mode = "public"\ncpus = ${trusted ? 1 : cpus}\nmemory_mb = ${trusted ? 512 : memoryMb}\n[agent]\ntimeout_sec = ${timeoutSeconds}\n[verifier]\ntimeout_sec = 120\nenvironment_mode = "separate"\n[verifier.environment]\nnetwork_mode = "no-network"\ncpus = 1\nmemory_mb = ${trusted ? 512 : 1024}\n`);
    await admitTaskParameters(task);
    const common = { revision, unit: 'ratio', direction: 'maximize', range: { min: 0, max: 1 }, granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 };
    const metrics = ['valid_output', 'completed', 'quality_available', ...(trusted ? ['constraints_verified'] : [])].map(metric => ({ ...common, id: metric, source: { path: `verifier.result.rewards.${metric}`, extractor: 'number-v1' } }));
    if (evaluation.mode === 'scored') {
      const qualityMetric = { ...common, id: 'task_score', unit: evaluation.metric, direction: evaluation.direction,
        source: { path: 'verifier.result.rewards.task_score', extractor: 'number-v1' } };
      if (evaluation.direction === 'minimize') delete qualityMetric.range;
      metrics.push(qualityMetric);
    }
    const manifest = await resourceRequest(root, 'seal-dataset', { directory: staging, owner, taskIds: [id], manifest: {
      benchmark: { id: `mlebench-${id}`, revision: taskIdentity }, adapter: { id: 'mlebench-task', revision, output_protocol: 'gear-harbor-eval-result-v1' },
      scoring: { total_score: { source_metric: 'total_score', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } },
      raw_metrics: { schema_version: '1', metrics }, execution: { backend: 'harbor-role-context@1', resolver: 'hitch-resource-resolver@1', platform }, required_capabilities: ['harbor-role-context@1'],
    } });
    await mkdir(dirname(resolve(out)), { recursive: true }); await rename(staging, resolve(out));
    return { path: resolve(out), taskId: id, taskDigest: manifest.tasks[0].task_digest, datasetDigest: manifest.dataset_digest,
      evaluation: { ...evaluation, qualityAvailable: evaluation.mode === 'scored' } };
  } finally {
    const results = await Promise.allSettled(leases.map(leaseId => resourceRequest(root, 'lease-end', { leaseId, confirmation: 'ended' })));
    await rm(temporary, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true });
    if (results.some(r => r.status === 'rejected')) process.stderr.write('Task input leases remain retained after release failure.\n');
  }
}
