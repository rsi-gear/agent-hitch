import { prepareHarness } from "../../artifacts/index.js";
import { resolveHarness } from "../../revisions/index.js";
import { SCHEMA_VERSION, invalidInput } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";
import { loadInternalLocalGitSource, takeInternalLocalGitFlags } from "./run.js";

export async function prepareCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const internalFlags = takeInternalLocalGitFlags(args);
  const reference = args.shift();
  if (!reference) throw invalidInput("prepare requires a harness reference");
  assertNoArgs(args);
  const internal = internalFlags ? await loadInternalLocalGitSource(internalFlags, reference) : null;
  const resolved = internal?.resolution || await resolveHarness(reference, { root });
  const artifact = await prepareHarness(resolved, { root, ...(internal ? { verifiedLocalGitSource: internal.source } : {}) });
  if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, resolved_revision: resolved, artifact }, null, 2)}\n`);
  else process.stdout.write(`${artifact.cache_hit ? "Cached" : "Prepared"} ${resolved.canonical_ref} as ${artifact.artifact_id}\n`);
}
