import type { DockerResourceOwnershipV1, ExecutionLeaseV1 } from "../domain/index.js";
import { hitchRootId } from "../foundation/index.js";

export const DOCKER_OWNERSHIP_LABELS = {
  rootId: "io.hitch.root-id",
  provider: "io.hitch.provider",
  evalId: "io.hitch.eval-id",
  workId: "io.hitch.work-id",
  leaseId: "io.hitch.lease-id",
  leaseEpoch: "io.hitch.lease-epoch",
  taskId: "io.hitch.task-id",
} as const;

export function dockerResourceOwnership(root: string, lease: ExecutionLeaseV1, taskId?: string): DockerResourceOwnershipV1 {
  if (lease.provider !== "local-docker") throw new TypeError("Docker ownership requires a local-docker lease");
  if (taskId !== undefined && (!taskId || taskId.length > 4_096 || /[\0\r\n]/.test(taskId))) {
    throw new TypeError("Docker ownership task id is invalid");
  }
  return {
    root_id: hitchRootId(root),
    provider: "local-docker",
    eval_id: lease.eval_id,
    work_id: lease.work_id,
    lease_id: lease.lease_id,
    lease_epoch: lease.epoch,
    ...(taskId === undefined ? {} : { task_id: taskId }),
  };
}

export function dockerOwnershipLabelMap(ownership: DockerResourceOwnershipV1): Record<string, string> {
  validateDockerResourceOwnership(ownership);
  return {
    [DOCKER_OWNERSHIP_LABELS.rootId]: ownership.root_id,
    [DOCKER_OWNERSHIP_LABELS.provider]: ownership.provider,
    [DOCKER_OWNERSHIP_LABELS.evalId]: ownership.eval_id,
    [DOCKER_OWNERSHIP_LABELS.workId]: ownership.work_id,
    [DOCKER_OWNERSHIP_LABELS.leaseId]: ownership.lease_id,
    [DOCKER_OWNERSHIP_LABELS.leaseEpoch]: String(ownership.lease_epoch),
    ...(ownership.task_id === undefined ? {} : { [DOCKER_OWNERSHIP_LABELS.taskId]: ownership.task_id }),
  };
}

export function validateDockerResourceOwnership(value: DockerResourceOwnershipV1): DockerResourceOwnershipV1 {
  if (!/^[a-f0-9]{24}$/.test(value.root_id) || value.provider !== "local-docker"
    || !/^eval_[a-f0-9]{32}$/.test(value.eval_id) || !/^work_[a-f0-9]{32}$/.test(value.work_id)
    || !/^lease_[a-f0-9]{32}$/.test(value.lease_id) || !Number.isSafeInteger(value.lease_epoch) || value.lease_epoch < 1
    || (value.task_id !== undefined && (!value.task_id || value.task_id.length > 4_096 || /[\0\r\n]/.test(value.task_id)))) {
    throw new TypeError("Docker resource ownership is invalid");
  }
  return value;
}
