import { assert } from './contracts.mjs'

/** The consumer binds its own reader implementation; Hitch supplies public locators. */
export class TrajectoryEvidence {
  constructor(backend) {
    this.backend = backend
    this.descriptor = { format: 'hitch-canonical-events-v1', configuration: {
      executable: backend.config.executorExecutable, root: backend.config.root,
    } }
  }
  async capture(runId, taskId, repetition, signal) {
    const base = { kind: 'trajectory', format: this.descriptor.format, task_id: taskId, repetition, locator: { run_id: runId } }
    try {
      const page = await this.backend.hitch(['trajectory', 'events', runId, '--limit', '1', '--max-bytes', '36864', '--json'], { executor: true, signal })
      assert(page.schema_version === '1' && page.run_id === runId && /^sha256:[a-f0-9]{64}$/.test(page.canonical_sha256), 'trajectory identity mismatch')
      return { ...base, status: 'available', content_digest: page.canonical_sha256, reason: null }
    } catch {
      signal?.throwIfAborted()
      return { ...base, status: 'unavailable', content_digest: null, reason: 'trajectory-source-unavailable' }
    }
  }
}
