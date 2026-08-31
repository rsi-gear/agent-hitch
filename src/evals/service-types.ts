import type { BackendWorkItemV1, EvalId, EvalRequest, ResourceVectorV1 } from "../domain/index.js";
import type { ExecutionWorkerIdentity } from "./execution-leases.js";
import type { EvalRequestInput } from "./request.js";

export interface RunEvalOptions {
  evalId?: EvalId;
  request: EvalRequestInput;
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
  trialBundleGraceMs?: number;
  precreated?: boolean;
  normalizedRequest?: EvalRequest;
  maxConcurrentOverride?: number;
  executionResources?: ResourceVectorV1;
  executionStrategy?: "legacy-attempt-shards" | "local-task-slots-v1";
  executionWorker?: ExecutionWorkerIdentity;
  workItemAdmission?: WorkItemAdmissionController;
}

export interface WorkItemAdmissionPermit {
  allocationId: string;
  collisionKeys: string[];
  release(): void;
}

export interface WorkItemAdmissionController {
  acquire(input: {
    evalId: EvalId;
    workItem: BackendWorkItemV1;
    maxParallelism: number;
    signal?: AbortSignal;
  }): Promise<WorkItemAdmissionPermit>;
}

export interface EvalResult extends Record<string, unknown> {
  schema_version: string;
  eval_id: EvalId;
  status: string;
  exit_code: number;
  error?: { code: string; message: string };
  started_at: string;
  completed_at: string;
}
