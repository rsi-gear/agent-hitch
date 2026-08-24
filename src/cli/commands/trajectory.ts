import path from "node:path";
import { HitchError, SCHEMA_VERSION, invalidInput, statePaths } from "../../foundation/index.js";
import { loadTrajectoryRef, readTrajectory } from "../../trajectories/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export async function trajectoryCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action !== "inspect") throw invalidInput("trajectory requires inspect");
  const json = takeFlag(args, "--json");
  const runId = args.shift();
  if (!runId) throw invalidInput("trajectory inspect requires a run ID");
  assertNoArgs(args);
  const runDirectory = path.join(statePaths(root).runs, runId);
  const ref = await loadTrajectoryRef(runDirectory);
  if (!ref) {
    throw new HitchError(`run ${runId} has no canonical trajectory`, { code: "trajectory_not_found", exitCode: 3 });
  }
  const { header, events } = await readTrajectory(ref.path);
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, run_id: runId, ref, header, events }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${runId}: ${ref.fidelity} trajectory (${events.length} events)\n`);
  process.stdout.write(`  session: ${ref.session_id}\n`);
  process.stdout.write(`  path: ${ref.path}\n`);
  const assistantMessages = events.filter((event) => event.type === "assistant/message");
  const toolResults = events.filter((event) => event.type === "tool/result");
  process.stdout.write(`  assistant messages: ${assistantMessages.length}, tool results: ${toolResults.length}\n`);
}
