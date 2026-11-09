import { cp, mkdir, readFile, writeFile, lstat, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { command } from './support.mjs';
import { assert, digest, sha, sourcePath, validateDelivery } from './schema.mjs';
import { fileHash, within, treeManifest } from './files.mjs';
import { parseCsv } from './submission.mjs';
import { produceTask } from '../analysis.mjs';
export { fileHash, treeManifest } from './files.mjs';

async function table(path) {
  const info = await lstat(path); assert(info.isFile() && info.size <= 1024 ** 3, 'CSV input exceeds profile');
  const [columns, ...rows] = parseCsv((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  assert(columns?.length && new Set(columns).size === columns.length && rows.length
    && rows.every(row => row.length === columns.length), 'invalid public CSV table');
  return { columns, rows };
}
async function pythonSources(repository) {
  const directory = join(repository, 'mlebench'), result = [];
  const visit = async prefix => {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      if (name === '__pycache__') continue;
      const file = prefix ? `${prefix}/${name}` : name, info = await lstat(join(directory, file));
      assert(!info.isSymbolicLink(), 'native grader source cannot contain symlinks');
      if (info.isDirectory()) await visit(file);
      else if (name.endsWith('.py')) result.push({ path: `mlebench/${file}`, digest: await fileHash(join(directory, file)), bytes: info.size });
    }
  };
  await visit(''); return result;
}

/** Import declared prepared inputs and native grader; never infer evaluation from a competition name. */
export async function inspectMlebench({ repository, dataRoot, competition, publicAssets = [] }) {
  repository = resolve(repository); dataRoot = resolve(dataRoot);
  assert(/^[a-z0-9][a-z0-9-]*$/.test(competition), 'invalid competition ID');
  const definition = await within(repository, join(repository, 'mlebench/competitions', competition));
  const config = yaml.load(await readFile(join(definition, 'config.yaml'), 'utf8'));
  assert(config?.id === competition && config.competition_type === 'simple', 'only declared simple tabular tasks are supported');
  assert(['accuracy', 'auc-roc', 'mean-column-wise-rmsle'].includes(config.grader?.name), 'unsupported metric profile');
  assert(typeof config.grader.grade_fn === 'string' && /^mlebench(?:\.[a-zA-Z0-9_-]+)+:[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.grader.grade_fn), 'invalid native grader entrypoint');
  const description = await within(repository, resolve(repository, config.description));
  const publicDir = await within(dataRoot, join(dataRoot, competition, 'prepared/public'));
  const privateDir = await within(dataRoot, join(dataRoot, competition, 'prepared/private'));
  const answers = await within(privateDir, resolve(dataRoot, config.dataset.answers));
  const sampleSubmission = await within(publicDir, resolve(dataRoot, config.dataset.sample_submission));
  const checksums = yaml.load(await readFile(join(definition, 'checksums.yaml'), 'utf8'));
  for (const [role, directory] of [['public', publicDir], ['private', privateDir]]) {
    assert(checksums[role] && Object.keys(checksums[role]).length, 'missing prepared-data checksums');
    const required = role === 'public' ? ['train.csv', 'test.csv', relative(directory, sampleSubmission)] : [relative(directory, answers)];
    assert(required.every(path => Object.hasOwn(checksums[role], path)), 'checksums omit a required table');
    for (const [path, expected] of Object.entries(checksums[role])) {
      sourcePath(path);
      assert(await fileHash(await within(directory, join(directory, path)), 'md5') === expected, `prepared-data checksum mismatch: ${role}/${path}`);
    }
  }
  const sample = await table(sampleSubmission), train = await table(join(publicDir, 'train.csv')), test = await table(join(publicDir, 'test.csv'));
  const idColumn = sample.columns[0], targetColumns = sample.columns.slice(1), predictIds = sample.rows.map(row => row[0]);
  assert(targetColumns.length > 0 && train.columns.includes(idColumn) && targetColumns.every(c => train.columns.includes(c))
    && test.columns.includes(idColumn) && targetColumns.every(c => !test.columns.includes(c)), 'incompatible public training/test/submission columns');
  const testIds = test.rows.map(row => row[test.columns.indexOf(idColumn)]);
  assert(new Set(testIds).size === testIds.length && testIds.length === predictIds.length && predictIds.every(id => testIds.includes(id)), 'sample and test IDs differ');
  const metric = config.grader.name;
  assert(metric === 'mean-column-wise-rmsle' || targetColumns.length === 1, 'classification metrics require one target');
  const labels = [...new Set(train.rows.map(row => row[train.columns.indexOf(targetColumns[0])]))].sort();
  if (metric === 'auc-roc') assert(JSON.stringify(labels) === '["0","1"]', 'AUC metric profile requires 0/1 labels');
  const delivery = validateDelivery({ format: 'csv', path: 'submission.csv', idColumn, targetColumns, predictIds,
    valueType: metric === 'accuracy' ? 'label' : metric === 'auc-roc' ? 'probability' : 'nonnegative', ...(metric === 'accuracy' ? { labels } : {}) });
  const answer = await table(answers), answerId = answer.columns.indexOf(idColumn);
  assert(answerId >= 0 && targetColumns.every(c => answer.columns.includes(c)) && JSON.stringify(answer.rows.map(row => row[answerId])) === JSON.stringify(predictIds), 'private answer IDs/order differ from sample');
  const sourceRevision = await command('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const definitionFiles = await Promise.all(['config.yaml', 'prepare.py', 'grade.py', 'checksums.yaml'].map(async path => ({ path, digest: await fileHash(join(definition, path)) })));
  const descriptionText = await readFile(description, 'utf8'); definitionFiles.push({ path: 'description.md', digest: sha(descriptionText) });
  const publicFiles = await treeManifest(publicDir), graderFiles = await pythonSources(repository);
  assert(Array.isArray(publicAssets), 'publicAssets must be an explicit asset manifest');
  const assetPaths = new Set();
  for (const asset of publicAssets) {
    assert(asset && Object.keys(asset).every(k => ['path', 'digest', 'bytes'].includes(k)), 'invalid public asset declaration');
    sourcePath(asset.path);
    assert(!assetPaths.has(asset.path) && !Object.hasOwn(checksums.public, asset.path), 'duplicate public asset declaration');
    assetPaths.add(asset.path);
    const file = publicFiles.find(f => f.path === asset.path);
    assert(file && file.digest === asset.digest && file.bytes === asset.bytes, 'declared public asset differs from its digest/size');
  }
  assert(JSON.stringify(publicFiles.map(f => f.path).sort()) === JSON.stringify([...Object.keys(checksums.public), ...assetPaths].sort()), 'public inputs include files outside the declared checksums/assets');
  const entrypointFile = config.grader.grade_fn.split(':')[0].replaceAll('.', '/') + '.py';
  assert(graderFiles.some(file => file.path === entrypointFile), 'native grader source is missing');
  const descriptor = { version: 1, format: 'mle-bench', competitionId: competition, sourceRevision,
    definitionDigest: digest(definitionFiles), publicTreeDigest: digest(publicFiles), privateAnswersDigest: await fileHash(answers),
    grader: { kind: 'native', entrypoint: config.grader.grade_fn, sourceDigest: digest(graderFiles) },
    metric, verification: publicAssets.length ? 'declared-checksums-and-assets' : 'declared-checksums', definitionFiles, publicFiles, graderFiles };
  return { descriptor, config, repository, public: publicDir, answers, sampleSubmission, delivery, description: descriptionText };
}

export async function importMlebench(options, resourceRequest) {
  const allowed = ['repository', 'dataRoot', 'competition', 'out', 'root', 'baseImage', 'platform', 'parameters', 'userParameters', 'parameterPolicy', 'timeoutSeconds', 'cpus', 'memoryMb', 'verifierCpus', 'verifierMemoryMb', 'publicAssets', 'trustedTraining'];
  assert(options && Object.keys(options).every(k => allowed.includes(k)), 'unsupported MLE-bench import option; old research configuration is not accepted');
  const imported = await inspectMlebench(options), temporary = await mkdtemp(join(tmpdir(), 'mlebench-native-'));
  try {
    const native = join(temporary, 'native'); await mkdir(native);
    for (const file of imported.descriptor.graderFiles) {
      const destination = join(native, file.path); await mkdir(dirname(destination), { recursive: true });
      await cp(join(imported.repository, file.path), destination);
    }
    return await produceTask({ root: options.root, out: options.out, id: options.competition, publicDirectory: imported.public,
      instruction: imported.description, delivery: imported.delivery, expected: imported.answers,
      evaluation: { mode: 'scored', version: digest(imported.descriptor), metric: imported.descriptor.metric, grader: imported.descriptor.grader },
      nativeGraderDirectory: native, provenance: imported.descriptor, baseImage: options.baseImage, platform: options.platform,
      trustedTraining: options.trustedTraining, parameters: options.parameters, userParameters: options.userParameters, parameterPolicy: options.parameterPolicy, timeoutSeconds: options.timeoutSeconds, cpus: options.cpus, memoryMb: options.memoryMb, verifierCpus: options.verifierCpus, verifierMemoryMb: options.verifierMemoryMb }, resourceRequest);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
