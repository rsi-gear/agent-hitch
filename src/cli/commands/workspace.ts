import type { RunId } from "../../domain/index.js";
import { HitchError, invalidInput } from "../../foundation/index.js";
import { inspectWorkspace, removeWorkspace } from "../../workspaces/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export async function workspaceCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  const runId = args.shift();
  if (!runId) throw invalidInput("workspace requires a run ID");
  if (action === "inspect") {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const workspace = await inspectWorkspace({ root, runId: runId as RunId });
    if (!workspace) throw new HitchError(`workspace record not found: ${runId}`, { code: "workspace_not_found", exitCode: 3 });
    if (json) process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
    else process.stdout.write(`${runId}: ${workspace.mode} ${workspace.status}\n  source: ${workspace.source_workspace}\n  execution: ${workspace.execution_workspace}\n  retained: ${workspace.retained ? "yes" : "no"}${workspace.changed === undefined || workspace.changed === null ? "" : `\n  changed: ${workspace.changed ? "yes" : "no"}`}\n`);
    return;
  }
  if (action === "path") {
    assertNoArgs(args);
    const workspace = await inspectWorkspace({ root, runId: runId as RunId });
    if (!workspace) throw new HitchError(`workspace record not found: ${runId}`, { code: "workspace_not_found", exitCode: 3 });
    if (!workspace.retained) throw new HitchError(`run ${runId} has no retained workspace`, { code: "workspace_not_retained", exitCode: 3 });
    process.stdout.write(`${workspace.execution_workspace}\n`);
    return;
  }
  if (action === "remove") {
    const force = takeFlag(args, "--force");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const workspace = await removeWorkspace({ root, runId: runId as RunId, force });
    if (json) process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
    else process.stdout.write(`Removed workspace for ${runId}\n`);
    return;
  }
  throw invalidInput("workspace requires inspect, path, or remove");
}
