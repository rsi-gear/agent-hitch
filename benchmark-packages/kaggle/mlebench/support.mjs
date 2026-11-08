import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const json = async path => JSON.parse(await readFile(path, 'utf8'))
export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export function command(executable, args, { cwd, env = process.env, signal, maxBytes = 8 * 1024 ** 2 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', count = 0, overflow = false
    const collect = (kind, bytes) => {
      count += bytes.length
      if (count > maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      if (kind === 'stdout') stdout += bytes; else stderr += bytes
    }
    child.stdout.on('data', bytes => collect('stdout', bytes)); child.stderr.on('data', bytes => collect('stderr', bytes))
    child.once('error', reject)
    child.once('close', code => {
      if (overflow) return reject(new Error('benchmark command output exceeded limit'))
      if (code) return reject(new Error(`${executable} failed (${code}): ${(stderr || stdout).slice(-2000)}`))
      accept(stdout.trim())
    })
  })
}
