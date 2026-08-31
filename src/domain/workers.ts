import type { ResourceVectorV1 } from "./resources.js";

export type ExecutionLeaseStateV1 =
  | "offered"
  | "accepted"
  | "running"
  | "releasing"
  | "released"
  | "expired"
  | "lost";

export interface ExecutionLeaseV1 {
  schema_version: "1";
  lease_id: string;
  work_id: string;
  eval_id: string;
  worker_id: string;
  provider: string;
  collision_domain_id: string;
  parent_allocation_id?: string;
  reservation: ResourceVectorV1;
  state: ExecutionLeaseStateV1;
  epoch: number;
  /** Epochs under which this lease's provider was authorized to create resources. */
  resource_epochs?: number[];
  issued_at: string;
  accepted_at?: string;
  heartbeat_at?: string;
  expires_at: string;
  terminal_at?: string;
}

export interface WorkerCapacityV1 {
  total: ResourceVectorV1;
  reserved_for_system: ResourceVectorV1;
  allocatable: ResourceVectorV1;
  allocated: ResourceVectorV1;
}

export interface ExecutionWorkerV1 {
  schema_version: "1";
  worker_id: string;
  provider: string;
  status: "ready" | "draining" | "offline";
  collision_domain_id: string;
  capabilities: {
    backends: string[];
    platforms: string[];
    task_membership: Array<"known" | "opaque">;
    isolated_same_task_attempts: boolean;
    remote: boolean;
  };
  capacity: WorkerCapacityV1;
}

export interface RemoteWorkerRegistrationV1 {
  schema_version: "1";
  worker_id: string;
  provider: string;
  collision_domain_id: string;
  platforms: string[];
  backends: Array<{ id: string; version: string }>;
  features: {
    docker: boolean;
    buildkit: boolean;
    model_proxy: boolean;
    isolated_same_task_attempts: boolean;
  };
  task_membership: Array<"known" | "opaque">;
  capacity: Omit<WorkerCapacityV1, "allocated">;
}

export interface RemoteWorkerHeartbeatV1 {
  schema_version: "1";
  generation: number;
  health: "healthy" | "degraded" | "unavailable";
  allocated: ResourceVectorV1;
  active_leases: Array<{ lease_id: string; epoch: number }>;
  sent_at: string;
}

export interface RemoteWorkerPublicRecordV1 {
  schema_version: "1";
  generation: number;
  worker: ExecutionWorkerV1;
  provider_status: import("./providers.js").ExecutionProviderStatusV1;
  active_leases: Array<{ lease_id: string; epoch: number }>;
  registered_at: string;
  heartbeat_at: string;
  revoked_at?: string;
}
