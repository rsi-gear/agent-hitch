import { readdir } from "node:fs/promises";
import path from "node:path";
import { inspectEvalRuntimeKind } from "../controller-runtime/index.js";
import { HitchError, SCHEMA_VERSION, invalidInput, readJSON, statePaths } from "../foundation/index.js";

export interface ListedEval {
  eval_id: string;
  status: string;
  backend: string | null;
  dataset: string | null;
  harness_ref: string | null;
  primary_reward: number | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function listEvals({ root }: { root: string }): Promise<ListedEval[]> {
  const directory = statePaths(root).evals;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const evals: ListedEval[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("eval_")) continue;
    const result = await readJSON<Record<string, unknown> | null>(path.join(directory, entry.name, "result.json"), null).catch(() => null);
    const request = await readJSON<Record<string, unknown> | null>(path.join(directory, entry.name, "request.json"), null).catch(() => null);
    const control = await readJSON<Record<string, unknown> | null>(path.join(directory, entry.name, "control.json"), null).catch(() => null);
    if (!result && !request) continue;
    evals.push({
      eval_id: entry.name,
      status: (result?.status as string) || (control?.state as string) || "running",
      backend: ((result?.backend as Record<string, unknown>)?.name as string) || (request?.backend as string) || null,
      dataset: (result?.dataset as string) || (request?.dataset as string) || null,
      harness_ref: ((result?.candidate as Record<string, unknown>)?.harness_ref as string) || (request?.harness_ref as string) || null,
      primary_reward: (result?.summary as Record<string, unknown>)?.primary_reward as number | null ?? null,
      started_at: (result?.started_at as string) || (control?.created_at as string) || null,
      completed_at: (result?.completed_at as string) || null,
    });
  }
  return evals.sort((left, right) => String(right.started_at || right.eval_id).localeCompare(String(left.started_at || left.eval_id)));
}

export interface InspectedEval {
  schema_version: string;
  eval_id: string;
  directory: string;
  request: Record<string, unknown> | null;
  resolution: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  execution_plan: Record<string, unknown> | null;
  submission: Record<string, unknown> | null;
  control: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  runtime_storage: "controller-runtime-ref-v1" | "embedded-runtime-v1" | "none";
}

export async function inspectEval(evalId: string, { root }: { root: string }): Promise<InspectedEval> {
  if (typeof evalId !== "string" || !/^eval_[a-f0-9]{32}$/.test(evalId)) throw invalidInput(`invalid eval ID: ${evalId}`);
  const directory = path.join(statePaths(root).evals, evalId);
  const request = await readJSON<Record<string, unknown> | null>(path.join(directory, "request.json"), null);
  if (!request) throw new HitchError(`eval not found: ${evalId}`, { code: "eval_not_found", exitCode: 3 });
  return {
    schema_version: SCHEMA_VERSION,
    eval_id: evalId,
    directory,
    request,
    resolution: await readJSON<Record<string, unknown> | null>(path.join(directory, "resolution.json"), null),
    plan: await readJSON<Record<string, unknown> | null>(path.join(directory, "plan.json"), null),
    execution_plan: await readJSON<Record<string, unknown> | null>(path.join(directory, "execution-plan.json"), null),
    submission: await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null),
    control: await readJSON<Record<string, unknown> | null>(path.join(directory, "control.json"), null),
    progress: await readJSON<Record<string, unknown> | null>(path.join(directory, "progress.json"), null),
    result: await readJSON<Record<string, unknown> | null>(path.join(directory, "result.json"), null),
    runtime_storage: await inspectEvalRuntimeKind(directory),
  };
}
