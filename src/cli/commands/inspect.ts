import { inspectAgent } from "../../adapters/index.js";
import { listPreparedArtifacts } from "../../artifacts/index.js";
import { SCHEMA_VERSION, invalidInput } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export async function inspectCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const id = args.shift();
  if (!id) throw invalidInput("inspect requires a harness name");
  assertNoArgs(args);
  const harness = {
    ...await inspectAgent(id),
    prepared_artifacts: await listPreparedArtifacts(id, { root }),
  };
  if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, harness }, null, 2)}\n`);
  else process.stdout.write(`${harness.display_name}: ${harness.status}${harness.executable ? `\n  executable: ${harness.executable}\n  version: ${harness.version || "unknown"}` : ""}\n  prepared artifacts: ${harness.prepared_artifacts.length}\n`);
}
