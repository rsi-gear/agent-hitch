import { inspectAgent } from "../../adapters/index.js";
import type { DiscoveredAgent } from "../../adapters/index.js";
import type { ResolvedRevision } from "../../domain/index.js";
import { HitchError, SCHEMA_VERSION, digest } from "../../foundation/index.js";
import type { ParsedHarnessReference } from "../reference.js";

export async function resolveInstalled(reference: ParsedHarnessReference, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  let discovered: DiscoveredAgent;
  try {
    discovered = await inspectAgent(reference.harness_id, { env });
  } catch (error) {
    throw new HitchError(`failed to inspect installed harness: ${reference.harness_id}`, {
      code: "resolution_failed",
      exitCode: 4,
      cause: error,
    });
  }
  if (discovered.status !== "available" || !discovered.executable || !discovered.identity) {
    throw new HitchError(`installed harness not found: ${reference.harness_id}`, {
      code: "revision_not_found",
      exitCode: 3,
    });
  }
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "installed",
    executable_identity: discovered.identity,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "installed" },
    source: {
      type: "installed",
      executable: discovered.executable,
      integrity: discovered.identity,
    },
    revision: {
      type: "installed",
      version: discovered.version || null,
    },
    identity,
    resolved_at: new Date().toISOString(),
  };
}
