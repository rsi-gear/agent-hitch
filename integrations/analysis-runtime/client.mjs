import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Container-local transport for the fixed worker. It does not create another eval. */
export function runAnalysisWorker(jobPath, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/local/bin/python3', ['-B', fileURLToPath(new URL('./worker.py', import.meta.url)), '--job', jobPath],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', overflow = false
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    child.stdout.on('data', bytes => { out += bytes; if (out.length > 8 * 1024 ** 2) { overflow = true; abort() } })
    child.stderr.on('data', bytes => { err = (err + bytes).slice(-4000) })
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(signal.reason)
      if (code || overflow) return reject(new Error(`fixed worker failed: ${err}`))
      try { resolve(JSON.parse(out)) } catch (error) { reject(error) }
    })
  })
}
