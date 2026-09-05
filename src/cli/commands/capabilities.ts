import { SCHEMA_VERSION } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export function capabilitiesCommand(args: string[]): void {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const capabilities = {
    schema_version: SCHEMA_VERSION,
    trajectory_analysis: "1",
    trajectory_events_page: "1",
    verifier_evidence: "1",
  } as const;
  if (json) {
    process.stdout.write(`${JSON.stringify(capabilities)}\n`);
    return;
  }
  process.stdout.write("trajectory_analysis 1\ntrajectory_events_page 1\nverifier_evidence 1\n");
}
