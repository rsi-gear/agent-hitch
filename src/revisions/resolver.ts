import { getAdapter } from "../adapters/index.js";
import { HitchError, statePaths } from "../foundation/index.js";
import type { ResolvedRevision } from "../domain/index.js";
export type { ResolvedRevision } from "../domain/index.js";
import { parseHarnessReference } from "./reference.js";
import type { ParsedHarnessReference } from "./reference.js";
import { resolveInstalled } from "./sources/installed.js";
import { resolveVersion } from "./sources/npm.js";
import { resolveCommit } from "./sources/git.js";

export async function resolveHarness(
  referenceValue: string | ParsedHarnessReference,
  { root, env = process.env }: { root?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedRevision> {
  const reference = typeof referenceValue === "string" ? parseHarnessReference(referenceValue) : referenceValue;
  const adapter = getAdapter(reference.harness_id);
  if (reference.selector.type === "installed") return resolveInstalled(reference, env);

  const source = adapter.revision_sources?.[reference.selector.type];
  if (!source) {
    throw new HitchError(`${reference.harness_id} does not support ${reference.selector.type} revisions`, {
      code: "revision_selector_unsupported",
      exitCode: 10,
    });
  }
  if (!root) throw new HitchError("a Hitch state root is required to resolve managed revisions");
  if (reference.selector.type === "version") return resolveVersion(reference, source, env);
  return resolveCommit(reference, source, statePaths(root), env);
}
