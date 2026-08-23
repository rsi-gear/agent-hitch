import type { RevisionSourceDefinition } from "../../adapters/index.js";
import type { ResolvedRevision } from "../../domain/index.js";
import { HitchError, SCHEMA_VERSION, commandExecutable, digest, runCommand } from "../../foundation/index.js";
import type { ParsedHarnessReference } from "../reference.js";

interface NpmViewResult {
  version: string;
  dist?: { integrity?: string; shasum?: string; tarball?: string };
}

export async function resolveVersion(reference: ParsedHarnessReference, source: RevisionSourceDefinition, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  const npm = commandExecutable("npm", env);
  const packages = source.packages || [source.package];
  let result: { stdout: string; stderr: string } | undefined;
  let packageName: string | undefined;
  let notFoundError: unknown;
  for (const candidate of packages) {
    if (!candidate) continue;
    const spec = `${candidate}@${(reference.selector as { value: string }).value}`;
    try {
      result = await runCommand(npm, ["view", spec, "version", "dist", "--json"], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
      packageName = candidate;
      break;
    } catch (error) {
      if (!/E404|not found|No match/i.test((error as Error).message)) throw error;
      notFoundError = error;
    }
  }
  if (!result || !packageName) {
    throw new HitchError(`revision not found: ${reference.canonical}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: notFoundError,
    });
  }
  const spec = `${packageName}@${(reference.selector as { value: string }).value}`;
  let metadata: NpmViewResult;
  try {
    metadata = JSON.parse(result.stdout) as NpmViewResult;
  } catch (error) {
    throw new HitchError(`package registry returned invalid metadata for ${spec}`, {
      code: "resolution_failed",
      exitCode: 4,
      cause: error,
    });
  }
  const expectedVersion = (reference.selector as { value: string }).value;
  if (metadata.version !== expectedVersion) {
    throw new HitchError(`package registry resolved ${spec} as ${metadata.version || "an unknown version"}`, {
      code: "resolution_failed",
      exitCode: 4,
    });
  }
  const integrity = metadata.dist?.integrity || (metadata.dist?.shasum ? `sha1:${metadata.dist.shasum}` : "");
  if (!integrity || !metadata.dist?.tarball) {
    throw new HitchError(`package registry did not provide immutable distribution metadata for ${spec}`, {
      code: "resolution_failed",
      exitCode: 4,
    });
  }
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "npm",
    package: packageName,
    version: metadata.version,
    integrity,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "version", value: expectedVersion },
    source: {
      type: "npm",
      package: packageName,
      tarball: sanitizeUrl(metadata.dist.tarball),
      integrity,
    },
    revision: { type: "version", version: metadata.version },
    identity,
    resolved_at: new Date().toISOString(),
  };
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}
