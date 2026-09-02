import { detectVersion, fingerprintExecutable, resolveExecutable } from "../foundation/index.js";
export { detectVersion, fingerprintExecutable, resolveExecutable, selectVersionLine } from "../foundation/index.js";
import { getAdapter, listDefinitions, publicDefinition } from "./catalog.js";
import type { PublicAdapterDefinition } from "./contract.js";

export interface DiscoveredAgent extends PublicAdapterDefinition {
  status: "available" | "unavailable";
  executable?: string;
  version?: string;
  identity?: string;
}

export async function discoverAgents({
  env = process.env,
  probeVersions = true,
}: { env?: NodeJS.ProcessEnv; probeVersions?: boolean } = {}): Promise<DiscoveredAgent[]> {
  return Promise.all(listDefinitions().map((definition) => inspectDefinition(definition, { env, probeVersions })));
}

export async function inspectAgent(
  id: string,
  { env = process.env, probeVersions = true }: { env?: NodeJS.ProcessEnv; probeVersions?: boolean } = {},
): Promise<DiscoveredAgent> {
  const definition = publicDefinition(getAdapter(id));
  return inspectDefinition(definition, { env, probeVersions });
}

async function inspectDefinition(
  definition: PublicAdapterDefinition,
  { env, probeVersions }: { env: NodeJS.ProcessEnv; probeVersions: boolean },
): Promise<DiscoveredAgent> {
  const configured = env[definition.path_env]?.trim() || definition.command;
  const executable = await resolveExecutable(configured, env.PATH || "", env.PATHEXT);
  if (!executable) return { ...definition, status: "unavailable" };

  const version = probeVersions
    ? await detectVersion(executable, getAdapter(definition.id).version_args)
    : "";
  const identity = await fingerprintExecutable(executable);
  return { ...definition, status: "available", executable, version, identity };
}
