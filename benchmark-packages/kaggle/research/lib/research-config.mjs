/** Admission settings, never editable harness resources. */
export const defaultResearchConfig = Object.freeze({
  maxExperiments: 5,
  validation: Object.freeze({ folds: 5, shuffle: true, scope: 'round', seed: 42 }),
})

export function researchConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['maxExperiments', 'validation'].includes(k))) throw new Error('invalid research configuration')
  const supplied = value.validation ?? {}
  if (supplied?.method) {
    const { version: _, ...config } = experimentConfig({ version: 'validation-v1', ...value })
    return config
  }
  if (supplied && Object.hasOwn(supplied, 'fraction')) {
    if (Object.keys(supplied).some(k => !['fraction', 'seed'].includes(k))
      || typeof supplied.fraction !== 'number' || supplied.fraction <= 0 || supplied.fraction >= 1
      || !Number.isFinite(supplied.fraction)) throw new Error('invalid legacy validation fraction')
    const maxExperiments = value.maxExperiments ?? defaultResearchConfig.maxExperiments, seed = supplied.seed ?? 42
    if (!Number.isSafeInteger(maxExperiments) || maxExperiments < 1 || !Number.isSafeInteger(seed) || seed < 0) throw new Error('invalid research budget or seed')
    return { maxExperiments, validation: { fraction: supplied.fraction, seed } }
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || Object.keys(supplied).some(k => !['folds', 'shuffle', 'scope', 'seed'].includes(k))) throw new Error('invalid validation configuration')
  const result = { maxExperiments: value.maxExperiments ?? defaultResearchConfig.maxExperiments,
    validation: { ...defaultResearchConfig.validation, ...supplied } }
  if (!Number.isSafeInteger(result.maxExperiments) || result.maxExperiments < 1) throw new Error('maxExperiments must be a positive integer')
  const { folds, shuffle, scope, seed } = result.validation
  if (folds !== 5 || shuffle !== true || scope !== 'round'
    || !Number.isSafeInteger(seed) || seed < 0) throw new Error('validation requires shuffled five-fold CV shared by the round')
  return result
}

/** Frozen client policy. Concrete row assignments are generated only by Hitch. */
export function experimentConfig(value = {}, metric = 'accuracy') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['version', 'maxExperiments', 'validation'].includes(k))) throw new Error('invalid experiment configuration')
  const version = value.version ?? 'validation-v1', maxExperiments = value.maxExperiments ?? 5
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new Error('experiment version required')
  if (!Number.isSafeInteger(maxExperiments) || maxExperiments < 1) throw new Error('maxExperiments must be positive')
  const v = value.validation ?? { method: metric === 'mean-column-wise-rmsle' ? 'kfold' : 'stratified_kfold', folds: 5, shuffle: true, seed: 42 }
  const holdout = ['holdout', 'stratified_holdout'].includes(v?.method)
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || !['kfold', 'stratified_kfold', 'holdout', 'stratified_holdout'].includes(v.method)
    || Object.keys(v).some(k => !['method', 'shuffle', 'seed', holdout ? 'fraction' : 'folds'].includes(k)))
    throw new Error('unsupported validation method or parameter')
  if (typeof v.shuffle !== 'boolean' || !Number.isSafeInteger(v.seed) || v.seed < 0 || v.seed > 4294967295)
    throw new Error('validation requires boolean shuffle and uint32 seed')
  if (holdout ? typeof v.fraction !== 'number' || !Number.isFinite(v.fraction) || v.fraction <= 0 || v.fraction >= 1
    : !Number.isSafeInteger(v.folds) || v.folds < 2 || v.folds > 10) throw new Error('invalid validation folds or fraction')
  return { version, maxExperiments, validation: { method: v.method, ...(holdout ? { fraction: v.fraction } : { folds: v.folds }), shuffle: v.shuffle, seed: v.seed } }
}

export function experimentBudget(request) {
  const total = request.maxExperiments ?? defaultResearchConfig.maxExperiments
  return { current: request.slotIndex, total, remaining: total - request.slotIndex,
    includingCurrent: total - request.slotIndex + 1 }
}
