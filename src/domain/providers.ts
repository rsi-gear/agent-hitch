import type { BackendWorkItemV1 } from "./execution-plan.js";
import type { ResourceVectorV1 } from "./resources.js";
import type { ExecutionLeaseV1 } from "./workers.js";

export interface DockerResourceOwnershipV1 {
  root_id: string;
  provider: "local-docker";
  eval_id: string;
  work_id: string;
  lease_id: string;
  lease_epoch: number;
  task_id?: string;
}

export interface ExecutionProviderStatusV1 {
  schema_version: "1";
  provider: string;
  worker_id: string;
  collision_domain_id: string;
  health: "healthy" | "degraded" | "unavailable";
  platforms: string[];
  backends: Array<{ id: string; version: string }>;
  features: {
    docker: boolean;
    buildkit: boolean;
    model_proxy: boolean;
    isolated_same_task_attempts: boolean;
  };
  capacity: {
    total: ResourceVectorV1;
    allocatable: ResourceVectorV1;
    allocated: ResourceVectorV1;
  };
  heartbeat_at: string;
}

export interface AdapterRuntimeRequirementsV1 {
  platforms?: string[];
  node_range?: string;
  network: "required" | "optional" | "forbidden";
  credential_names: string[];
  endpoint_override: "supported" | "unsupported" | "unknown";
  capture: {
    native_events: boolean;
    native_session: boolean;
    model_proxy_compatible: boolean;
  };
}

export interface ProviderPlanInputV1 {
  work: BackendWorkItemV1;
  platform: string;
  adapter_requirements: {
    harness_id: string;
    needs_docker: boolean;
    needs_model_proxy: boolean;
  } & AdapterRuntimeRequirementsV1;
}

export interface ProviderPlanResultV1 {
  supported: boolean;
  reservation: ResourceVectorV1;
  constraints: string[];
}

export interface ProviderExecutionHandleV1 {
  provider: string;
  worker_id: string;
  native_id: string;
}

export interface ProviderOfferResultV1 {
  accepted: boolean;
  handle?: ProviderExecutionHandleV1;
  rejection_code?: string;
}

export interface ProviderRecoveryResultV1 {
  state: "not-started" | "running" | "terminal-uncollected" | "released" | "ambiguous";
  handle?: ProviderExecutionHandleV1;
}

export interface ExecutionProvider {
  readonly id: string;
  inspect(): Promise<ExecutionProviderStatusV1>;
  plan(input: ProviderPlanInputV1): Promise<ProviderPlanResultV1>;
  offer(lease: ExecutionLeaseV1, work: BackendWorkItemV1): Promise<ProviderOfferResultV1>;
  cancel(leaseId: string, epoch: number): Promise<void>;
  recover(lease: ExecutionLeaseV1): Promise<ProviderRecoveryResultV1>;
  release(leaseId: string, epoch: number): Promise<void>;
}
