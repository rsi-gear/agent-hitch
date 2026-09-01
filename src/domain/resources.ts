export interface ResourceVectorV1 {
  cpu_millis: number;
  memory_bytes: number;
  container_slots: number;
  build_slots: number;
  /** Whole GPU devices. Omitted is the V1-compatible representation of zero. */
  gpu_count?: number;
}

export interface ResourceAllocationV1 {
  allocation_id: string;
  owner_id: string;
  kind: "run" | "eval" | "build";
  resources: ResourceVectorV1;
  acquired_at: string;
}
