export interface ControllerRuntimeObservationV2 {
  schema_version: "2";
  package_version: string;
  node_version: string;
  runtime_id: string;
  source: { kind: "git-checkout"; commit: string; dirty: boolean } | { kind: "unavailable"; commit: null; dirty: null };
}

/** A startup snapshot plus a fresh disk observation; not loaded-module attestation. */
export interface ResidentRuntimeObservationV2 {
  schema_version: "2";
  startup: ControllerRuntimeObservationV2;
  current: ControllerRuntimeObservationV2;
  unchanged: boolean;
}

export type ExecutableObservationV2 =
  | { status: "available"; version: string; executable_digest: string }
  | { status: "unavailable"; version: null; executable_digest: null };

export interface HarborEnvironmentObservationV2 {
  schema_version: "2";
  host_platform: string;
  harbor: ExecutableObservationV2;
  docker: (ExecutableObservationV2 & { status: "available"; engine_id: string; os: string; architecture: string })
    | { status: "unavailable"; version: null; executable_digest: null; engine_id: null; os: null; architecture: null };
  buildx: { status: "available"; version: string } | { status: "unavailable"; version: null };
  sandbox: { status: "unverified" };
}

export interface ExecutionObservationSourceV2 {
  initialize(): Promise<void>;
  observeRuntime(): Promise<ResidentRuntimeObservationV2>;
  observe(signal?: AbortSignal): Promise<{ runtime: ResidentRuntimeObservationV2; environment: HarborEnvironmentObservationV2 }>;
}

export interface RemoteExecutionObservationChallengeV2 {
  schema_version: "2";
  request_id: string;
  nonce: string;
  daemon_instance_id: string;
  worker_id: string;
  generation: number;
  provider: string;
  collision_domain_id: string;
  expires_at: string;
}

export interface RemoteExecutionObservationReceiptV2 {
  schema_version: "2";
  challenge: RemoteExecutionObservationChallengeV2;
  runtime: ResidentRuntimeObservationV2;
  environment: HarborEnvironmentObservationV2;
  environment_digest: string;
}
