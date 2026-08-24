export { getAdapter, listDefinitions, normalizeRequest, publicDefinition } from "./catalog.js";
export type { AdapterCapabilities, AdapterDefinition, AdapterProcessRuntime, AdapterRequest, NormalizedEvent, ProcessSpecification, PublicAdapterDefinition, PublicRevisionSource, RevisionSourceDefinition } from "./contract.js";
export { detectVersion, discoverAgents, fingerprintExecutable, inspectAgent, resolveExecutable, selectVersionLine } from "./discovery.js";
export type { DiscoveredAgent } from "./discovery.js";
