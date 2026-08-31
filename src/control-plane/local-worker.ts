import type { ExecutionProviderStatusV1, ExecutionWorkerV1 } from "../domain/index.js";
import { zeroResources } from "./resources.js";
import type { ResourceLedger } from "./resources.js";

export function localWorkerSnapshot(input: {
  workerId: string;
  provider: string;
  collisionDomainId: string;
  accepting: boolean;
  resources: ResourceLedger;
}): ExecutionWorkerV1 {
  const resources = input.resources.snapshot();
  return {
    schema_version: "1",
    worker_id: input.workerId,
    provider: input.provider,
    status: input.accepting ? "ready" : "draining",
    collision_domain_id: input.collisionDomainId,
    capabilities: {
      backends: ["harbor"],
      platforms: [`${process.platform}-${process.arch}`],
      task_membership: ["known", "opaque"],
      isolated_same_task_attempts: false,
      remote: false,
    },
    capacity: {
      total: resources.capacity,
      reserved_for_system: zeroResources(),
      allocatable: resources.capacity,
      allocated: resources.allocated,
    },
  };
}

export function localProviderStatusSnapshot(input: {
  workerId: string;
  provider: string;
  collisionDomainId: string;
  accepting: boolean;
  resources: ResourceLedger;
}): ExecutionProviderStatusV1 {
  const resources = input.resources.snapshot();
  return {
    schema_version: "1",
    provider: input.provider,
    worker_id: input.workerId,
    collision_domain_id: input.collisionDomainId,
    health: input.accepting ? "healthy" : "degraded",
    platforms: [`${process.platform}-${process.arch}`],
    backends: [{ id: "harbor", version: "unknown" }],
    features: {
      docker: true,
      buildkit: true,
      model_proxy: false,
      isolated_same_task_attempts: false,
    },
    capacity: {
      total: resources.capacity,
      allocatable: resources.capacity,
      allocated: resources.allocated,
    },
    heartbeat_at: new Date().toISOString(),
  };
}
