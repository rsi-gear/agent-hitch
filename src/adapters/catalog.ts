import path from "node:path";
import { HitchError } from "../foundation/index.js";
import type { AdapterDefinition, AdapterRequest, PublicAdapterDefinition } from "./contract.js";
import { claudeAdapter } from "./providers/claude.js";
import { codexAdapter } from "./providers/codex.js";
import { deepseekAdapter } from "./providers/deepseek.js";
import { opencodeAdapter } from "./providers/opencode.js";
import { piAdapter } from "./providers/pi.js";

const definitions: Record<string, AdapterDefinition> = Object.fromEntries(
  [codexAdapter, claudeAdapter, piAdapter, opencodeAdapter, deepseekAdapter].map((definition) => [definition.id, definition]),
);

export function listDefinitions(): PublicAdapterDefinition[] {
  return Object.values(definitions).map(publicDefinition);
}

export function getAdapter(id: string): AdapterDefinition {
  const adapter = definitions[id];
  if (!adapter) throw new HitchError(`unknown harness: ${id}`, { code: "harness_not_found", exitCode: 3 });
  return adapter;
}

export function publicDefinition(definition: AdapterDefinition): PublicAdapterDefinition {
  const revisionSources = definition.revision_sources || {};
  return {
    id: definition.id,
    display_name: definition.display_name,
    command: definition.command,
    path_env: definition.path_env,
    capabilities: definition.capabilities,
    requirements: definition.requirements,
    revision_selectors: ["installed", ...Object.keys(revisionSources)],
    revision_sources: Object.fromEntries(Object.entries(revisionSources).map(([selector, source]) => [
      selector,
      {
        type: source.type,
        ...(source.package ? { package: source.package } : {}),
        ...(source.packages ? { packages: source.packages } : {}),
        ...(source.url ? { url: source.url } : {}),
      },
    ])),
  };
}

export function normalizeRequest(input: Record<string, unknown> | undefined): AdapterRequest {
  const cwd = path.resolve(typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  const harnessRef = typeof input?.harness_ref === "string"
    ? input.harness_ref.trim()
    : typeof input?.agent === "string" && input.agent.trim()
      ? `${input.agent.trim()}@installed`
      : "";
  return {
    harness_ref: harnessRef,
    model: typeof input?.model === "string" ? input.model : "",
    cwd,
    workspace_mode: typeof input?.workspace_mode === "string" ? input.workspace_mode : "shared",
    prompt: typeof input?.prompt === "string" ? input.prompt : "",
    timeout_ms: typeof input?.timeout_ms === "number" ? input.timeout_ms : 0,
    agent_args: Array.isArray(input?.agent_args) ? [...input.agent_args] as string[] : [],
  };
}
