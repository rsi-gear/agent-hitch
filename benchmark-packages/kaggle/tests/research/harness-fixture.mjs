import { fileURLToPath } from 'node:url'
import { prepare as prepareTask, bootstrap as bootstrapCarrier } from '../../research/prepare.mjs'
export { sealHarness } from '../../research/prepare.mjs'
export const harness = fileURLToPath(new URL('../fixtures/harness', import.meta.url))
export const prepare = options => prepareTask({ harness, ...options })
export const bootstrap = (repository, install = false, options = {}) => bootstrapCarrier(repository, install, { harness, ...options })
