import type { AdapterDefinition, AdapterRequest, ProcessSpecification } from "../adapters/index.js";
import type { PreparedArtifact, ResolvedRevision } from "../artifacts/index.js";

/** Bind a verified artifact and its invocation prefix to the adapter request. */
export async function prepareAdapterProcess(
  adapter: AdapterDefinition,
  request: AdapterRequest,
  artifact: PreparedArtifact,
  resolution: ResolvedRevision,
  runDirectory: string,
  runtimeHome: string,
): Promise<ProcessSpecification> {
  const specification = await adapter.process(request, artifact.executable, {
    entrypoint_integrity: artifact.entrypoint_integrity,
    observed_version: artifact.observed_version ?? undefined,
    resolution, run_directory: runDirectory, runtime_home: runtimeHome,
  });
  if (artifact.entrypoint_args?.length) specification.args.unshift(...artifact.entrypoint_args);
  return specification;
}
