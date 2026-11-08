/** Benchmark interpretation belongs to the published Hitch producer. */
export { fileHash, treeManifest, upstreamRevision, inspectMlebench } from 'agent-hitch/analysis'
import { importMlebench as importDataset } from 'agent-hitch/analysis'
import { researchConfig } from './research-config.mjs'
export function importMlebench(options, out) {
  return importDataset({ ...options, validation: researchConfig(options.research).validation }, out)
}
