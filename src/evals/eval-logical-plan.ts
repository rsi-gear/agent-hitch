import path from "node:path";
import type { EvalProgressV1, EvalRequest, ModelCapturePlanV1 } from "../domain/index.js";
import { SCHEMA_VERSION, atomicWriteJSON, readJSON } from "../foundation/index.js";
import { writeEvalProgress } from "./progress.js";

export interface EvalLogicalPlanV1 extends Record<string, unknown> {
  schema_version: "1";
  kind: "eval-logical-plan";
  eval_id: string;
  backend: "harbor";
  candidate: Record<string, unknown>;
  dataset: string;
  benchmark_id: string;
  benchmark_revision: string;
  attempts: number;
  attempt_execution: "harbor-attempt-shards-v1" | "harbor-task-slots-v1";
  max_concurrent: number;
  model_capture?: ModelCapturePlanV1;
  tasks?: string[];
  controller_runtime: { runtime_id: string; manifest_digest: string };
  created_at: string;
}

/** Persist the reproducible, artifact-independent part of an eval before setup work begins. */
export async function writeEvalPlanningCheckpoint(
  evalDirectory: string,
  plan: EvalLogicalPlanV1,
  progress: EvalProgressV1,
): Promise<void> {
  await Promise.all([
    atomicWriteJSON(path.join(evalDirectory, "logical-plan.json"), plan),
    writeEvalProgress(evalDirectory, progress),
  ]);
}

export function materializeEvalPlan(
  logical: EvalLogicalPlanV1,
  modelCapture: ModelCapturePlanV1 | undefined,
  artifactFields: Record<string, unknown>,
): Record<string, unknown> {
  const { kind: _kind, model_capture: _modelCapture, ...base } = logical;
  return {
    ...base,
    ...(modelCapture ? { model_capture: modelCapture } : {}),
    ...artifactFields,
  };
}

/** Read only the restart inputs that cannot be reconstructed from request.json. */
export async function readEvalLogicalPlan(
  evalDirectory: string,
  evalId: string,
  request: EvalRequest,
): Promise<EvalLogicalPlanV1 | null> {
  const value = await readJSON<unknown | null>(path.join(evalDirectory, "logical-plan.json"), null);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval logical plan must be an object");
  const plan = value as Record<string, unknown>;
  if (plan.schema_version !== SCHEMA_VERSION || plan.kind !== "eval-logical-plan" || plan.eval_id !== evalId
    || plan.dataset !== request.dataset || plan.benchmark_id !== request.benchmark_id
    || plan.benchmark_revision !== request.benchmark_revision) {
    throw new TypeError("eval logical plan identity is invalid");
  }
  if (plan.model_capture !== undefined) parseModelCapturePlan(plan.model_capture);
  return plan as unknown as EvalLogicalPlanV1;
}

export function logicalPlanModelCapture(plan: EvalLogicalPlanV1 | null): ModelCapturePlanV1 | undefined {
  return plan?.model_capture === undefined ? undefined : parseModelCapturePlan(plan.model_capture);
}

function parseModelCapturePlan(value: unknown): ModelCapturePlanV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("eval logical model capture plan is invalid");
  const plan = value as Record<string, unknown>;
  const modes = new Set(["off", "native", "proxy", "hybrid"]);
  if (!modes.has(String(plan.requested_mode)) || !modes.has(String(plan.effective_mode)) || typeof plan.required !== "boolean"
    || plan.topology !== undefined && plan.topology !== "host-side" && plan.topology !== "in-sandbox"
    || plan.degraded_reason !== undefined && typeof plan.degraded_reason !== "string") {
    throw new TypeError("eval logical model capture plan is invalid");
  }
  return plan as unknown as ModelCapturePlanV1;
}
