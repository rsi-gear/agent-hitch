import path from "node:path";
import { loadRunRecord, queryRuns, rebuildRunIndexes } from "../../runs/index.js";
import { SCHEMA_VERSION, invalidInput, statePaths } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";
import { takeRunQuery } from "./compare.js";

export async function runsCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "inspect") {
    const json = takeFlag(args, "--json");
    const runId = args.shift();
    if (!runId || !/^run_[a-f0-9]{32}$/.test(runId)) throw invalidInput("runs inspect requires a valid run ID");
    assertNoArgs(args);
    const loaded = await loadRunRecord(path.join(statePaths(root).runs, runId), { verifyTrajectory: true });
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, ...loaded }, null, 2)}\n`);
    else process.stdout.write(`${runId}: ${loaded.record.status} (${loaded.record.context.kind})\n  trajectory: ${loaded.trajectory_status}\n`);
    return;
  }
  if (action === "list") {
    const json = takeFlag(args, "--json");
    const query = takeRunQuery(args);
    assertNoArgs(args);
    const records = await queryRuns({ root, query });
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, runs: records.map(({ record }) => record) }, null, 2)}\n`);
    else for (const { record } of records) process.stdout.write(`${record.run_id}  ${record.status.padEnd(9)}  ${record.context.kind}  ${record.harness.harness_id}  ${record.model.effective_id || "-"}\n`);
    return;
  }
  if (action === "rebuild-index") {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const index = await rebuildRunIndexes({ root });
    if (json) process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
    else process.stdout.write(`Indexed ${index.runs.length} runs\n`);
    return;
  }
  throw invalidInput("runs requires list, inspect, or rebuild-index");
}
