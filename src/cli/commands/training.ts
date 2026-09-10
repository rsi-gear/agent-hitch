import { invalidInput } from "../../foundation/index.js";
import { registerTrainingEndpoint, readTrainingRegistration } from "../../model-access/index.js";
import { loadTrainingEvidence } from "../../runs/index.js";
import { assertNoArgs, takeOption, takeFlag } from "../arguments.js";
import { observeControllerRuntime } from "../../controller-runtime/index.js";

export async function trainingCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "runtime") {
    takeFlag(args, "--json"); assertNoArgs(args);
    process.stdout.write(`${JSON.stringify(await observeControllerRuntime())}\n`);
    return;
  }
  if (action === "evidence") {
    const runId = args.shift(); takeFlag(args, "--json"); assertNoArgs(args);
    if (!runId) throw invalidInput("training evidence requires a run ID");
    process.stdout.write(`${JSON.stringify(await loadTrainingEvidence(root, runId))}\n`);
    return;
  }
  if (action !== "register") throw invalidInput("training requires runtime, evidence RUN, or register --file PATH (or --file - for stdin)");
  const file = takeOption(args, "--file"); assertNoArgs(args);
  if (!file) throw invalidInput("training register requires --file");
  const binding = await registerTrainingEndpoint(root, await readTrainingRegistration(file));
  process.stdout.write(`${JSON.stringify({ schema_version: "1", binding })}\n`);
}
