import type { RerunSelector } from "./rerun-slots.js";
import type { ResourceVectorV1 } from "../domain/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";

export const EVAL_RERUN_TYPES = [
  "candidate-restart",
  "candidate-resume",
  "trajectory-replay",
  "verifier-only",
  "collect-only",
] as const;

export type EvalRerunType = typeof EVAL_RERUN_TYPES[number];

export interface EvalRerunSemanticsV1 {
  candidate_action: "restart" | "resume" | "replay" | "none";
  conversation_source: "original-instruction" | "native-session" | "canonical-trajectory" | "none";
  sandbox_source: "clean" | "checkpoint" | "retained" | "none";
  candidate_executes: boolean;
}

export interface RerunEvalOptions {
  evalId: string;
  selector: RerunSelector;
  root: string;
  rerunId?: string;
  rerunType?: EvalRerunType;
  maxConcurrentOverride?: number;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  trialBundleGraceMs?: number;
  executionResources?: ResourceVectorV1;
}

export interface EvalRerunResult {
  schema_version: "1";
  kind: "eval-rerun";
  rerun_id: string;
  rerun_type: EvalRerunType;
  semantics: EvalRerunSemanticsV1;
  eval_id: string;
  status: "completed";
  selected_tasks: string[];
  repaired_tasks: string[];
  remaining_invalid_tasks: string[];
  selected_trials: Array<{ task_id: string; attempt: number }>;
  repaired_trials: Array<{ task_id: string; attempt: number }>;
  remaining_invalid_trials: Array<{ task_id: string; attempt: number }>;
  eval_status: "succeeded" | "failed";
  started_at: string;
  completed_at: string;
}

export function parseEvalRerunType(value: unknown): EvalRerunType {
  if (typeof value !== "string" || !EVAL_RERUN_TYPES.includes(value as EvalRerunType)) {
    throw invalidInput(`eval rerun --type must be one of: ${EVAL_RERUN_TYPES.join(", ")}`);
  }
  return value as EvalRerunType;
}

export function evalRerunSemantics(type: EvalRerunType): EvalRerunSemanticsV1 {
  switch (type) {
    case "candidate-restart":
      return { candidate_action: "restart", conversation_source: "original-instruction", sandbox_source: "clean", candidate_executes: true };
    case "candidate-resume":
      return { candidate_action: "resume", conversation_source: "native-session", sandbox_source: "checkpoint", candidate_executes: true };
    case "trajectory-replay":
      return { candidate_action: "replay", conversation_source: "canonical-trajectory", sandbox_source: "checkpoint", candidate_executes: true };
    case "verifier-only":
      return { candidate_action: "none", conversation_source: "none", sandbox_source: "retained", candidate_executes: false };
    case "collect-only":
      return { candidate_action: "none", conversation_source: "none", sandbox_source: "none", candidate_executes: false };
  }
}

export function assertEvalRerunTypeSupported(type: EvalRerunType): void {
  if (type === "candidate-restart") return;
  const unavailable: Record<Exclude<EvalRerunType, "candidate-restart">, { code: string; message: string }> = {
    "candidate-resume": {
      code: "eval_candidate_resume_unavailable",
      message: "candidate-resume requires both a restorable sandbox checkpoint and adapter-native session resume; the current Harbor execution does not retain both",
    },
    "trajectory-replay": {
      code: "eval_trajectory_replay_unavailable",
      message: "trajectory-replay requires a verified trajectory, a restorable sandbox checkpoint, and explicit adapter replay support; trajectory evidence alone cannot restore tool or process state",
    },
    "verifier-only": {
      code: "eval_verifier_only_rerun_unavailable",
      message: "verifier-only requires the original retained sandbox; current verifier retries run only while that sandbox is live",
    },
    "collect-only": {
      code: "eval_collect_only_unavailable",
      message: "collect-only recovery is not exposed as a rerun operation yet",
    },
  };
  const failure = unavailable[type];
  throw new HitchError(failure.message, { code: failure.code, exitCode: 2 });
}
