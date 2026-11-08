import { createHash } from 'node:crypto'

export const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-canonical JSON value')
  return JSON.stringify(value)
}
export const digest = value => sha(canonical(value))
export function assert(ok, message) { if (!ok) throw new Error(message) }
export function seal(body) { assert(!('digest' in body), 'already sealed'); return { ...structuredClone(body), digest: digest(body) } }
export function sourcePath(path) {
  assert(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) && !path.startsWith('/')
    && path.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe source path')
  return path
}
