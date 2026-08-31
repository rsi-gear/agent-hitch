import type { BackendWorkItemV1, EvalId, EvalRequest, ResourceVectorV1, Sha256 } from "../domain/index.js";
import type { ExecutionWorkerIdentity } from "./execution-leases.js";
import type { DockerReaperReportV1 } from "./docker-reaper.js";
import type { EvalRequestInput } from "./request.js";

export type EvalDockerResourceReaper = (input: {
  root: string;
  leaseIds?: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<DockerReaperReportV1>;

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
  executionResourceSource?: "submission-default" | "operator-default";
  executionStrategy?: "legacy-attempt-shards" | "local-task-slots-v1";
  executionWorker?: ExecutionWorkerIdentity;
  workItemAdmission?: WorkItemAdmissionController;
  resumeExisting?: boolean;
  onControlPhase?: (phase: EvalExecutionPhase, work?: EvalWorkStateSnapshot) => Promise<void>;
  onWorkItemState?: (workId: string, leaseId: string, state: "running" | "terminal") => Promise<void>;
  dockerResourceReaper?: EvalDockerResourceReaper;
  environmentBuildMode?: "backend" | "prebuild-preferred" | "prebuild-required";
  environmentImageResolver?: EvalEnvironmentImageResolver;
}

export type EvalEnvironmentImageResolver = (input: {
  benchmarkId: string;
  benchmarkRevision: string;
  taskId: string;
  reference: string;
  platform: string;
  signal?: AbortSignal;
}) => Promise<{
  image_id: Sha256;
  reference: string;
  manifest_digest: Sha256;
  platform: string;
  cache_hit: boolean;
}>;

export type EvalExecutionPhase = "planning" | "preparing" | "running" | "finalizing";

export interface EvalWorkStateSnapshot {
  queuedWorkItems: string[];
  terminalWorkItems: string[];
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
