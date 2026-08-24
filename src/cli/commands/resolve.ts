import { resolveHarness } from "../../revisions/index.js";
import { invalidInput } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";
import { revisionLabel } from "../output.js";

export async function resolveCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const reference = args.shift();
  if (!reference) throw invalidInput("resolve requires a harness reference");
  assertNoArgs(args);
  const resolved = await resolveHarness(reference, { root });
  if (json) process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  else process.stdout.write(`${resolved.canonical_ref} -> ${revisionLabel(resolved)} (${resolved.identity})\n`);
}
