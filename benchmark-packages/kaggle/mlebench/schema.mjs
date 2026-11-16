import { createHash } from 'node:crypto';

export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const digest = value => sha(canonical(value));
export function assert(value, message) { if (!value) throw new TypeError(message); }
export function sourcePath(value) {
  assert(typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f]/.test(value), 'invalid relative path');
  return value;
}
export function validateDelivery(input) {
  assert(input && input.format === 'csv', 'delivery.format must be csv');
  assert(Object.keys(input).every(k => ['format', 'path', 'maxBytes', 'idColumn', 'targetColumns', 'predictIds', 'valueType', 'labels'].includes(k)), 'unknown delivery contract field');
  const delivery = { ...input, path: input.path ?? 'submission.csv', maxBytes: input.maxBytes ?? 16 * 1024 ** 2 };
  sourcePath(delivery.path);
  assert(typeof delivery.idColumn === 'string' && delivery.idColumn.length > 0, 'delivery.idColumn required');
  assert(Array.isArray(delivery.targetColumns) && delivery.targetColumns.length > 0 && delivery.targetColumns.every(v => typeof v === 'string' && v)
    && new Set([delivery.idColumn, ...delivery.targetColumns]).size === delivery.targetColumns.length + 1, 'distinct delivery columns required');
  assert(Array.isArray(delivery.predictIds) && delivery.predictIds.length > 0 && delivery.predictIds.every(v => typeof v === 'string' && v)
    && new Set(delivery.predictIds).size === delivery.predictIds.length, 'nonempty unique prediction IDs required');
  assert(['label', 'number', 'probability', 'nonnegative'].includes(delivery.valueType), 'unsupported delivery.valueType');
  if (delivery.valueType === 'label') assert(Array.isArray(delivery.labels) && delivery.labels.length > 0 && delivery.labels.every(v => typeof v === 'string')
    && new Set(delivery.labels).size === delivery.labels.length, 'delivery labels required');
  assert(Number.isSafeInteger(delivery.maxBytes) && delivery.maxBytes > 0 && delivery.maxBytes <= 64 * 1024 ** 2, 'delivery.maxBytes out of range');
  return delivery;
}
export function validateEvaluation(input) {
  assert(input && ['scored', 'delivery'].includes(input.mode), 'evaluation.mode must explicitly be scored or delivery');
  assert(Object.keys(input).every(k => ['mode', 'version', 'metric', 'grader'].includes(k)), 'unknown evaluation contract field');
  assert(typeof input.version === 'string' && input.version.length > 0, 'evaluation.version required');
  if (input.mode === 'delivery') {
    assert(input.metric === undefined && input.grader === undefined, 'unlabeled delivery cannot declare a quality metric or grader');
    return { mode: 'delivery', version: input.version };
  }
  assert(['accuracy', 'auc-roc', 'mean-column-wise-rmsle'].includes(input.metric), 'unsupported quality metric');
  assert(input.grader && ['builtin', 'native'].includes(input.grader.kind), 'explicit evaluation.grader required');
  assert(Object.keys(input.grader).every(k => (input.grader.kind === 'native' ? ['kind', 'entrypoint', 'sourceDigest'] : ['kind']).includes(k)), 'unknown grader contract field');
  if (input.grader.kind === 'native') assert(typeof input.grader.entrypoint === 'string'
    && /^mlebench(?:\.[a-zA-Z0-9_-]+)+:[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.grader.entrypoint), 'invalid native grader entrypoint');
  return { ...input, direction: input.metric === 'mean-column-wise-rmsle' ? 'minimize' : 'maximize' };
}

// Benchmark-owned schema and capability mapping: no ML-specific fields in Hitch core.
export function defaultParameters(coverage = 'all-training') {
  return { version: 1,
    parameters: { method: { cv: { method: 'stratified_kfold', folds: 5, seed: 42 } },
      training: { max_fits: null, fit_accounting: 'observed', cv_execution: 'agent' }, delivery: { freeze_selection: false } },
    schema: { type: 'object', additionalProperties: false, required: ['method', 'training', 'delivery'], properties: {
      method: { type: 'object', additionalProperties: false, required: ['cv'], properties: { cv: { type: 'object', additionalProperties: false,
        required: ['method', 'folds', 'seed'], properties: { method: { type: 'string', enum: ['kfold', 'stratified_kfold'] },
          folds: { type: 'integer', minimum: 2, maximum: 10 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 } } } } },
      training: { type: 'object', additionalProperties: false, required: ['max_fits', 'fit_accounting', 'cv_execution'], properties: {
        max_fits: { type: ['integer', 'null'], minimum: 1 }, fit_accounting: { type: 'string', enum: ['observed', 'enforced'] }, cv_execution: { type: 'string', enum: ['agent', 'trusted'] } } },
      delivery: { type: 'object', additionalProperties: false, required: ['freeze_selection'], properties: { freeze_selection: { type: 'boolean' } } },
    } },
    parameter_policy: {
      '/method/cv/method': { mutable: true, actors: ['meta', 'target'], choices: ['kfold', 'stratified_kfold'], apply_at: 'training_start' },
      '/method/cv/folds': { mutable: true, actors: ['meta', 'target'], minimum: 3, maximum: 10, apply_at: 'training_start' },
      '/method/cv/seed': { mutable: false }, '/training/max_fits': { mutable: true, actors: ['meta'], nullable: true, minimum: 1, maximum: 50, apply_at: 'task_start' },
      '/training/fit_accounting': { mutable: false }, '/training/cv_execution': { mutable: false }, '/delivery/freeze_selection': { mutable: false },
    },
    capability_requirements: [
      { path: '/training/max_fits', condition: 'non_null', capability: 'trusted-fit-count@1', coverage },
      { path: '/training/fit_accounting', condition: 'equals', value: 'enforced', capability: 'trusted-fit-count@1', coverage },
      { path: '/training/cv_execution', condition: 'equals', value: 'trusted', capability: 'trusted-cv@1', coverage },
      { path: '/delivery/freeze_selection', condition: 'equals', value: true, capability: 'frozen-delivery@1', coverage },
    ],
  };
}

/** Task-package capabilities cannot be removed by editing the authoring JSON. */
export function bindBenchmarkCapabilities(contract, coverage = 'all-training') {
  const result = structuredClone(contract), required = defaultParameters(coverage).capability_requirements;
  result.capability_requirements ??= [];
  for (const requirement of required) {
    const parts = requirement.path.slice(1).split('/');
    let value = result.parameters, exists = true;
    for (const part of parts) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) { exists = false; break; }
      value = value[part];
    }
    if (exists && !result.capability_requirements.some(r => canonical(r) === canonical(requirement))) result.capability_requirements.push(requirement);
  }
  return result;
}
