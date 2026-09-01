import type { BackendWorkItemV1, EnvironmentImageManifestV1, EvalExecutionPlanV1, EvalId, EvalRequest, EvalTrialRefV1, InteractionCaptureRefV1, ModelCapturePlanV1, ModelProxyRouteV1, ResolvedRevision, ResourceVectorV1, Sha256 } from "../domain/index.js";
import type { HarborBackendResult, HarborPreparedArtifactUse } from "../backends/index.js";
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
  modelCapturePlan?: ModelCapturePlanV1;
  workItemAdmission?: WorkItemAdmissionController;
  resumeExisting?: boolean;
  onControlPhase?: (phase: EvalExecutionPhase, work?: EvalWorkStateSnapshot) => Promise<void>;
  onWorkItemState?: (workId: string, leaseId: string, state: "running" | "terminal") => Promise<void>;
  dockerResourceReaper?: EvalDockerResourceReaper;
  environmentBuildMode?: "backend" | "prebuild-preferred" | "prebuild-required";
  environmentImageResolver?: EvalEnvironmentImageResolver;
  environmentImageBuilder?: EvalEnvironmentImageBuilder;
  environmentImageManifestLoader?: EvalEnvironmentImageManifestLoader;
  remoteWorkExecutor?: EvalRemoteWorkExecutor;
}

export type EvalEnvironmentImageManifestLoader = (imageId: Sha256) => Promise<EnvironmentImageManifestV1>;

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

export type EvalEnvironmentImageBuilder = (input: {
  benchmarkId: string;
  benchmarkRevision: string;
  taskId: string;
  contextDirectory: string;
  dockerfile: string;
  platform: string;
  signal?: AbortSignal;
}) => Promise<{
  image_id: Sha256;
  requested_reference: string;
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

export interface EvalRemoteWorkExecutionResult {
  leaseId: string;
  refs: EvalTrialRefV1[];
  run: HarborBackendResult;
}

export type EvalRemoteWorkExecutor = (input: {
  evalId: EvalId;
  evalDirectory: string;
  root: string;
  request: EvalRequest;
  plan: EvalExecutionPlanV1;
  workItem: BackendWorkItemV1;
  resolvedRevision: ResolvedRevision;
  preparedArtifact: HarborPreparedArtifactUse;
  runtimeId: string;
  environmentImages?: import("./trial-environment-evidence.js").TrialEnvironmentImagesV1;
  modelCapturePlan?: ModelCapturePlanV1;
  signal?: AbortSignal;
  emit(event: Record<string, unknown>): void;
  publish(ref: EvalTrialRefV1): Promise<void>;
  onLeaseState(leaseId: string, state: "running" | "terminal"): Promise<void>;
}) => Promise<EvalRemoteWorkExecutionResult>;

export interface EvalInteractionCaptureExporter {
  route: ModelProxyRouteV1;
  plan: ModelCapturePlanV1;
  finalizeRun(runId: string, destinationRunDirectory: string): Promise<InteractionCaptureRefV1>;
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
