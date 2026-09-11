import type { Sha256 } from "./ids.js";

export interface RemoteWorkerProcessIdentityV2 {
  pid: number;
  start_identity: Sha256;
  observed_at: string;
}

/** Public, non-secret identity captured by the executor before acceptance. */
export interface RemoteWorkerExecutionOwnershipV2 {
  schema_version: "2";
  binding_digest: Sha256;
  root_id: string;
  root_digest: Sha256;
  boot_digest: Sha256;
  docker_engine_id: string;
  worker_process: RemoteWorkerProcessIdentityV2;
}

/** Stable host identity and boot identity are separately observed and never carry raw machine IDs. */
export interface RemoteWorkerHostIdentityV1 {
  schema_version: "1";
  platform: "linux" | "darwin";
  host_id: Sha256;
  boot_id: Sha256;
}

export interface RemoteWorkerExecutionOwnershipV3 extends Omit<RemoteWorkerExecutionOwnershipV2, "schema_version"> {
  schema_version: "3";
  host_identity: RemoteWorkerHostIdentityV1;
}
export type RemoteWorkerExecutionOwnership = RemoteWorkerExecutionOwnershipV2 | RemoteWorkerExecutionOwnershipV3;

/** Controller-owned evidence, authenticated by the original worker generation. */
export interface RemoteWorkerExecutionAdmissionV2 {
  schema_version: "2";
  offer_id: string;
  worker_id: string;
  generation: number;
  lease_id: string;
  execution_epoch: number;
  accepted_at: string;
  ownership: RemoteWorkerExecutionOwnership;
  ownership_digest: Sha256;
  execution_process: RemoteWorkerProcessIdentityV2 | null;
}

export interface RemoteWorkerCleanupChallengeV2 {
  schema_version: "2";
  cleanup_id: string;
  nonce: string;
  worker_id: string;
  generation: number;
  issued_at: string;
  expires_at: string;
  admission: RemoteWorkerExecutionAdmissionV2;
}

export interface RemoteWorkerCleanupObservationV2 {
  ownership: RemoteWorkerExecutionOwnership;
  execution_process: RemoteWorkerProcessIdentityV2 | null;
  worker_status: "terminal" | "identity-mismatch";
  process_group_empty: true;
  docker_resources_empty: true;
}

export interface RemoteWorkerCleanupReceiptV2 {
  schema_version: "2";
  challenge: RemoteWorkerCleanupChallengeV2;
  observed_at: string;
  observation: RemoteWorkerCleanupObservationV2;
}

/** A prior boot ended the original processes; current PIDs are not evidence about them. */
export interface RemoteWorkerRebootCleanupObservationV3 {
  ownership: RemoteWorkerExecutionOwnershipV3;
  execution_process: RemoteWorkerProcessIdentityV2 | null;
  host_identity: RemoteWorkerHostIdentityV1;
  worker_status: "previous-boot";
  docker_resources_empty: true;
}
export type RemoteWorkerCleanupObservation = RemoteWorkerCleanupObservationV2 | RemoteWorkerRebootCleanupObservationV3;

export interface RemoteWorkerCleanupReceiptV3 extends Omit<RemoteWorkerCleanupReceiptV2, "schema_version" | "observation"> {
  schema_version: "3";
  observation: RemoteWorkerRebootCleanupObservationV3;
}
export type RemoteWorkerCleanupReceipt = RemoteWorkerCleanupReceiptV2 | RemoteWorkerCleanupReceiptV3;

export interface RemoteWorkerGenerationReleaseV3 {
  schema_version: "3";
  offer_id: string;
  worker_generation: number;
  cleanup_generation: number;
  cleanup_id: string;
  admission_digest: Sha256;
  execution_epoch: number;
  receipt_digest: Sha256;
  released_at: string;
}
