import type { AdapterDefinition, AdapterProcessRuntime, AdapterRequest, ProcessSpecification } from "../adapters/index.js";
import type { PreparedArtifact, ResolvedRevision } from "../artifacts/index.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { statePaths } from "../foundation/index.js";

export async function prepareAdapterRuntimeHome(root: string, runId: string): Promise<string> {
  // Harness homes contain private state and dependency symlinks. Only redacted
  // provider evidence and canonical trajectories belong in the sealed bundle.
  const runtimeHome = path.join(statePaths(root).temporary, "runtime-homes", runId);
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  return runtimeHome;
}

/** Bind a verified artifact and its invocation prefix to the adapter request. */
export async function prepareAdapterProcess(
  adapter: AdapterDefinition,
  request: AdapterRequest,
  artifact: PreparedArtifact,
  resolution: ResolvedRevision,
  runDirectory: string,
  runtimeHome: string,
  runtimeOverrides: Pick<AdapterProcessRuntime, "model_endpoint" | "model_endpoint_credential" | "model_endpoint_max_output_tokens"> = {},
): Promise<ProcessSpecification> {
  const specification = await adapter.process(request, artifact.executable, {
    entrypoint_integrity: artifact.entrypoint_integrity,
    observed_version: artifact.observed_version ?? undefined,
    resolution, run_directory: runDirectory, runtime_home: runtimeHome, ...runtimeOverrides,
  });
  if (artifact.entrypoint_args?.length) specification.args.unshift(...artifact.entrypoint_args);
  return specification;
}
