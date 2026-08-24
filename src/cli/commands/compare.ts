export async function compareCommand(args: string[], root: string): Promise<void> {
  const dimension = args.shift();
  if (dimension !== "model" && dimension !== "harness") throw invalidInput("compare requires model or harness");
  const json = takeFlag(args, "--json");
  const referenceRunId = takeOption(args, "--reference-run");
  const query = takeRunQuery(args);
  assertNoArgs(args);
  const comparison = await compareRuns({
    root,
    dimension: dimension as ComparisonDimension,
    query,
    ...(referenceRunId ? { referenceRunId } : {}),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Strict ${dimension} comparison: ${comparison.strict ? "yes" : "no"}\n`);
  for (const group of comparison.groups) {
    process.stdout.write(`  ${JSON.stringify(group.identity)}  valid=${group.valid_observations}  mean=${group.rewards.mean ?? "-"}  failures=${group.agent_failures}\n`);
  }
  if (comparison.excluded.length) process.stdout.write(`  excluded: ${comparison.excluded.length}\n`);
}

export function takeRunQuery(args: string[]): RunQuery {
  const query: RunQuery = {};
  const assign = (field: keyof RunQuery, option: string): void => {
    const value = takeOption(args, option);
    if (value !== undefined) (query as Record<string, unknown>)[field] = value;
  };
  assign("context_kind", "--context-kind");
  assign("benchmark_id", "--benchmark");
  assign("benchmark_revision", "--benchmark-revision");
  assign("task_id", "--task");
  assign("task_digest", "--task-digest");
  assign("seed_task_id", "--seed-task");
  assign("seed_task_digest", "--seed-digest");
  assign("iteration_id", "--iteration");
  assign("harness_id", "--harness");
  assign("revision_identity", "--harness-revision");
  assign("model_provider", "--provider");
  assign("requested_model", "--requested-model");
  assign("effective_model", "--effective-model");
  assign("eval_id", "--eval");
  assign("status", "--status");
  assign("created_from", "--from");
  assign("created_to", "--to");
  return query;
}
import { compareRuns } from "../../runs/index.js";
import type { ComparisonDimension, RunQuery } from "../../runs/index.js";
import { invalidInput } from "../../foundation/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";
