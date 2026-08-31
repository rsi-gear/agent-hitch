import path from "node:path";
import { deriveTrainingDataCandidate, loadRunRecord, queryRuns, rebuildRunIndexes } from "../../runs/index.js";
import { SCHEMA_VERSION, invalidInput, statePaths } from "../../foundation/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";
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
  if (action === "candidate") {
    const json = takeFlag(args, "--json");
    const captureRequired = takeFlag(args, "--capture-required");
    const contextLicense = takeOption(args, "--context-license") ?? "unknown";
    const redactionPolicy = takeOption(args, "--redaction-policy") ?? "hitch-provider-redaction-v1";
    const runId = args.shift();
    if (!runId || !/^run_[a-f0-9]{32}$/.test(runId)) throw invalidInput("runs candidate requires a valid run ID");
    if (!new Set(["allowed", "denied", "unknown"]).has(contextLicense)) throw invalidInput("--context-license must be allowed, denied, or unknown");
    assertNoArgs(args);
    const derived = await deriveTrainingDataCandidate({
      root,
      runId,
      policy: { contextLicense: contextLicense as "allowed" | "denied" | "unknown", captureRequired, redactionPolicy },
    });
    if (json) process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`);
    else process.stdout.write(`${derived.candidate.candidate_id}  ${derived.candidate.eligibility}  ${derived.path}\n`);
    return;
  }
  throw invalidInput("runs requires list, inspect, rebuild-index, or candidate");
}
