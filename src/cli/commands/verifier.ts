import { invalidInput } from "../../foundation/index.js";
import { loadVerifierEvidence } from "../../runs/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export async function verifierCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action !== "inspect") throw invalidInput("verifier requires inspect");
  const json = takeFlag(args, "--json");
  const runId = args.shift();
  if (!runId || !/^run_[a-f0-9]{32}$/.test(runId)) {
    throw invalidInput("verifier inspect requires a valid run ID");
  }
  assertNoArgs(args);
  const evidence = await loadVerifierEvidence(root, runId);
  if (json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${runId}: verifier ${evidence.verifier.status}\n`);
  if (evidence.observation) {
    const reward = evidence.observation.reward === undefined ? "" : `, reward ${evidence.observation.reward}`;
    process.stdout.write(`  observation: ${evidence.observation.status}${reward}\n`);
  }
  const diagnostics = evidence.verifier.diagnostics;
  if (diagnostics) {
    const artifacts = [
      ...(diagnostics.ctrf ? [diagnostics.ctrf] : []),
      ...(diagnostics.stdout ?? []),
      ...(diagnostics.stderr ?? []),
    ];
    process.stdout.write(`  diagnostics: ${artifacts.map((artifact) => artifact.name).join(", ") || "structured only"}\n`);
  }
  for (const issue of evidence.verifier.issues ?? []) process.stdout.write(`  issue: ${issue}\n`);
}
