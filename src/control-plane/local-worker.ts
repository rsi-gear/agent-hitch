import type { ExecutionWorkerV1 } from "../domain/index.js";
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
