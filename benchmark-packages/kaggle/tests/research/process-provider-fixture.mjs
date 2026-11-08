// Deterministic execution backend behind the real cross-package process wire.
import { AnalysisOperationProvider } from '../../research/lib/operation-provider.mjs'
import { Backend } from './project-fixture.mjs'

let input = ''
for await (const bytes of process.stdin) input += bytes
const { action, configuration, context, request, implementationIdentity } = JSON.parse(input)
const provider = await AnalysisOperationProvider.open(configuration, context)
class PersistentBackend extends Backend {
  async rollout(request, history) {
    const key = request.digest.slice(7)
    const previous = await this.store.load('fixture-rollouts', key)
    if (previous) return previous
    const result = await super.rollout(request, history)
    await this.store.save('fixture-rollouts', key, result)
    if (request.slotIndex === 3 && !await this.store.load('fixture-control', 'lost')) {
      await this.store.save('fixture-control', 'lost', { request: request.digest })
      throw new Error('transport lost after completed slot 3')
    }
    return result
  }
  async deliver(request) {
    const key = request.digest.slice(7), previous = await this.store.load('fixture-deliveries', key)
    if (previous) return previous
    this.quality = request.harness.commit === provider.project.harness.commit ? .7 : .8
    const result = await super.deliver(request)
    await this.store.save('fixture-deliveries', key, result)
    return result
  }
}
provider.backend = new PersistentBackend(provider.store)
try {
  if (implementationIdentity && implementationIdentity !== (await provider.describe()).identity) throw new Error('implementation changed')
  const result = action === 'describe' ? await provider.describe() : await provider[action](request)
  process.stdout.write(JSON.stringify(result))
} catch (error) { process.stderr.write(error.message); process.exitCode = 1 }
