import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalId, EvalRequest, ResourceVectorV1, Sha256, TaskResourceRequirementV1, TrialSlotV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseTaskResourceRequirements, reservationForTasks } from "./execution-plan-resources.js";

export const DEFAULT_EVAL_TRIAL_RESOURCES: ResourceVectorV1 = {
  cpu_millis: 1_000,
  memory_bytes: 1024 * 1024 * 1024,
  container_slots: 1,
  build_slots: 0,
};

export interface BuildEvalExecutionPlanOptions {
  evalId: EvalId;
  request: EvalRequest;
  candidate: {
    revisionIdentity: string;
    artifactId: string;
  };
  tasks: readonly string[] | null;
  maxParallelism: number;
  trialResources?: ResourceVectorV1;
  taskResources?: readonly TaskResourceRequirementV1[];
  provider?: string;
  createdAt?: string;
  workItemMode?: "attempt-shards" | "task-slots";
}

export function buildEvalExecutionPlan(options: BuildEvalExecutionPlanOptions): EvalExecutionPlanV1 {
  const resources = parseResourceVector(options.trialResources || DEFAULT_EVAL_TRIAL_RESOURCES, "default trial resources");
  if (!isSha256(options.candidate.revisionIdentity) || !isSha256(options.candidate.artifactId)) {
    throw new TypeError("execution plan candidate identity is invalid");
  }
  if (!Number.isSafeInteger(options.maxParallelism) || options.maxParallelism < 1 || options.maxParallelism > options.request.max_concurrent) {
    throw new TypeError("execution plan max parallelism is invalid");
  }
  const provider = options.provider || "local-docker";
  if (!provider) throw new TypeError("execution plan provider is invalid");
  const tasks = options.tasks === null ? null : canonicalTasks(options.tasks);
  const taskResources = tasks === null ? undefined : parseTaskResourceRequirements(options.taskResources, tasks);
  const candidateIdentity = sha256JSON({
    harness_revision_identity: options.candidate.revisionIdentity,
    artifact_id: options.candidate.artifactId,
    requested_model: options.request.model,
    agent_args_sha256: sha256JSON(options.request.agent_args),
    protocol: {
      timeout_ms: options.request.timeout_ms,
      setup_timeout_ms: options.request.setup_timeout_ms,
    },
  });
  const slots = tasks === null ? [] : buildSlots(options.evalId, tasks, options.request.attempts, candidateIdentity);
  const workItems = tasks === null
    ? [opaqueWorkItem(options.evalId, options.maxParallelism, resources, provider)]
    : options.workItemMode === "task-slots"
      ? buildTaskWorkItems(options.evalId, slots, resources, provider, taskResources)
      : buildAttemptWorkItems(options.evalId, tasks, slots, options.request.attempts, options.maxParallelism, resources, provider, taskResources);
  return parseEvalExecutionPlan({
    schema_version: "1",
    planner: "hitch-local-v1",
    eval_id: options.evalId,
    membership: tasks === null ? "opaque" : "known",
    candidate_identity: candidateIdentity,
    benchmark: {
      id: options.request.benchmark_id,
      revision: options.request.benchmark_revision,
      verifier_identity: sha256JSON({
        backend: "harbor",
        benchmark_id: options.request.benchmark_id,
        benchmark_revision: options.request.benchmark_revision,
        verifier: "dataset",
      }),
    },
    provider,
    max_parallelism: options.maxParallelism,
    default_trial_resources: resources,
    ...(taskResources ? { task_resources: taskResources } : {}),
    slots,
    work_items: workItems,
    retry_policy: {
      infrastructure_retries: options.request.infrastructure_retries,
      infrastructure_retry_backoff_ms: options.request.infrastructure_retry_backoff_ms,
      verifier_execution: "same-trial-verifier-only",
      candidate_rerun_on_verifier_failure: false,
    },
    created_at: options.createdAt || new Date().toISOString(),
  });
}

export function parseEvalExecutionPlan(value: unknown): EvalExecutionPlanV1 {
  if (!isRecord(value)) throw new TypeError("eval execution plan must be an object");
  const plan = value;
  assertOnlyKeys(plan, [
    "schema_version", "planner", "eval_id", "membership", "candidate_identity", "benchmark", "provider",
    "max_parallelism", "default_trial_resources", "task_resources", "slots", "work_items", "retry_policy", "created_at",
  ], "eval execution plan");
  if (plan.schema_version !== "1" || plan.planner !== "hitch-local-v1" || !isEvalId(plan.eval_id)
    || (plan.membership !== "known" && plan.membership !== "opaque")
    || !isSha256(plan.candidate_identity) || typeof plan.provider !== "string" || !plan.provider
    || !Number.isSafeInteger(plan.max_parallelism) || (plan.max_parallelism as number) < 1
    || typeof plan.created_at !== "string" || !Number.isFinite(Date.parse(plan.created_at))) {
    throw new TypeError("eval execution plan identity is invalid");
  }
  const benchmark = parseBenchmark(plan.benchmark);
  const resources = parseResourceVector(plan.default_trial_resources, "execution plan default trial resources");
  if (!Array.isArray(plan.slots) || !Array.isArray(plan.work_items)) throw new TypeError("eval execution plan work graph is invalid");
  const slots = plan.slots.map((slot, index) => parseSlot(slot, plan.eval_id as string, plan.candidate_identity as Sha256, index));
  const taskResources = parseTaskResourceRequirements(plan.task_resources, slots.map((slot) => slot.task_id).filter((task, index, all) => all.indexOf(task) === index));
  const workItems = plan.work_items.map((item, index) => parseWorkItem(
    item,
    plan.eval_id as string,
    plan.provider as string,
    plan.max_parallelism as number,
    index,
  ));
  assertPlanGraph(plan.membership as "known" | "opaque", slots, workItems, resources, taskResources);
  const retry = parseRetryPolicy(plan.retry_policy);
  return {
    schema_version: "1",
    planner: "hitch-local-v1",
    eval_id: plan.eval_id as string,
    membership: plan.membership as "known" | "opaque",
    candidate_identity: plan.candidate_identity as Sha256,
    benchmark,
    provider: plan.provider,
    max_parallelism: plan.max_parallelism as number,
    default_trial_resources: resources,
    ...(taskResources ? { task_resources: taskResources } : {}),
    slots,
    work_items: workItems,
    retry_policy: retry,
    created_at: plan.created_at,
  };
}

function buildSlots(evalId: EvalId, tasks: string[], attempts: number, candidateIdentity: Sha256): TrialSlotV1[] {
  const slots: TrialSlotV1[] = [];
  for (const taskId of tasks) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const identity = { eval_id: evalId, task_id: taskId, attempt, candidate_identity: candidateIdentity };
      slots.push({
        schema_version: "1",
        slot_id: `slot_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`,
        eval_id: evalId,
        task_id: taskId,
        attempt,
        candidate_identity: candidateIdentity,
        state: "pending",
        physical_execution: 1,
      });
    }
  }
  return slots;
}

function buildAttemptWorkItems(
  evalId: EvalId,
  tasks: string[],
  slots: TrialSlotV1[],
  attempts: number,
  maxParallelism: number,
  resources: ResourceVectorV1,
  provider: string,
  taskResources?: readonly TaskResourceRequirementV1[],
): BackendWorkItemV1[] {
  const items: BackendWorkItemV1[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const selected = slots.filter((slot) => slot.attempt === attempt).map((slot) => slot.slot_id);
    const requestedParallelism = Math.min(maxParallelism, selected.length);
    const identity = { eval_id: evalId, backend: "harbor", logical_attempt: attempt, slots: selected };
    items.push({
      schema_version: "1",
      work_id: `work_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`,
      eval_id: evalId,
      backend: "harbor",
      logical_attempt: attempt,
      task_ids: [...tasks],
      slots: selected,
      opaque_membership: false,
      requested_parallelism: requestedParallelism,
      reservation: reservationForTasks(tasks, requestedParallelism, resources, taskResources),
      provider,
    });
  }
  return items;
}

function buildTaskWorkItems(evalId: EvalId, slots: TrialSlotV1[], resources: ResourceVectorV1, provider: string, taskResources?: readonly TaskResourceRequirementV1[]): BackendWorkItemV1[] {
  return slots.map((slot) => {
    const identity = { eval_id: evalId, backend: "harbor", logical_attempt: slot.attempt, slots: [slot.slot_id] };
    return {
      schema_version: "1",
      work_id: `work_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`,
      eval_id: evalId,
      backend: "harbor",
      logical_attempt: slot.attempt,
      task_ids: [slot.task_id],
      slots: [slot.slot_id],
      opaque_membership: false,
      requested_parallelism: 1,
      reservation: reservationForTasks([slot.task_id], 1, resources, taskResources),
      provider,
    };
  });
}

function opaqueWorkItem(evalId: EvalId, maxParallelism: number, resources: ResourceVectorV1, provider: string): BackendWorkItemV1 {
  const identity = { eval_id: evalId, backend: "harbor", membership: "opaque" };
  return {
    schema_version: "1",
    work_id: `work_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`,
    eval_id: evalId,
    backend: "harbor",
    logical_attempt: null,
    task_ids: [],
    slots: [],
    opaque_membership: true,
    requested_parallelism: maxParallelism,
    reservation: scaleResources(resources, maxParallelism),
    provider,
  };
}

function parseSlot(value: unknown, evalId: string, candidateIdentity: Sha256, index: number): TrialSlotV1 {
  if (!isRecord(value)) throw new TypeError(`eval execution plan slot ${index} is invalid`);
  assertOnlyKeys(value, [
    "schema_version", "slot_id", "eval_id", "task_id", "task_digest", "attempt", "candidate_identity",
    "state", "physical_execution", "authoritative_run_id", "invalid_reason",
  ], `eval execution plan slot ${index}`);
  if (value.schema_version !== "1" || typeof value.slot_id !== "string" || !/^slot_[a-f0-9]{32}$/.test(value.slot_id)
    || value.eval_id !== evalId || typeof value.task_id !== "string" || !value.task_id
    || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || value.candidate_identity !== candidateIdentity
    || value.state !== "pending" || value.physical_execution !== 1) {
    throw new TypeError(`eval execution plan slot ${index} is invalid`);
  }
  if (value.task_digest !== undefined && !isSha256(value.task_digest)) throw new TypeError(`eval execution plan slot ${index} task digest is invalid`);
  if (value.authoritative_run_id !== undefined || value.invalid_reason !== undefined) throw new TypeError(`pending execution plan slot ${index} is already settled`);
  const identity = { eval_id: evalId, task_id: value.task_id, attempt: value.attempt, candidate_identity: candidateIdentity };
  const expected = `slot_${sha256JSON(identity).slice("sha256:".length, "sha256:".length + 32)}`;
  if (value.slot_id !== expected) throw new TypeError(`eval execution plan slot ${index} identity does not match`);
  return value as unknown as TrialSlotV1;
}

function parseWorkItem(value: unknown, evalId: string, provider: string, maxParallelism: number, index: number): BackendWorkItemV1 {
  if (!isRecord(value)) throw new TypeError(`eval execution plan work item ${index} is invalid`);
  assertOnlyKeys(value, [
    "schema_version", "work_id", "eval_id", "backend", "logical_attempt", "task_ids", "slots",
    "opaque_membership", "requested_parallelism", "reservation", "provider",
  ], `eval execution plan work item ${index}`);
  if (value.schema_version !== "1" || typeof value.work_id !== "string" || !/^work_[a-f0-9]{32}$/.test(value.work_id)
    || value.eval_id !== evalId || value.backend !== "harbor"
    || (value.logical_attempt !== null && (!Number.isSafeInteger(value.logical_attempt) || (value.logical_attempt as number) < 1))
    || !Array.isArray(value.task_ids) || value.task_ids.some((task) => typeof task !== "string" || !task)
    || !Array.isArray(value.slots) || value.slots.some((slot) => typeof slot !== "string" || !/^slot_[a-f0-9]{32}$/.test(slot))
    || typeof value.opaque_membership !== "boolean" || !Number.isSafeInteger(value.requested_parallelism) || (value.requested_parallelism as number) < 1
    || (value.requested_parallelism as number) > maxParallelism || value.provider !== provider) {
    throw new TypeError(`eval execution plan work item ${index} is invalid`);
  }
  if (new Set(value.task_ids).size !== value.task_ids.length || new Set(value.slots).size !== value.slots.length) {
    throw new TypeError(`eval execution plan work item ${index} members are duplicated`);
  }
  return { ...value, reservation: parseResourceVector(value.reservation, `eval execution plan work item ${index} reservation`) } as BackendWorkItemV1;
}

function assertPlanGraph(membership: "known" | "opaque", slots: TrialSlotV1[], workItems: BackendWorkItemV1[], resources: ResourceVectorV1, taskResources?: readonly TaskResourceRequirementV1[]): void {
  if (new Set(slots.map((slot) => slot.slot_id)).size !== slots.length || new Set(workItems.map((item) => item.work_id)).size !== workItems.length) {
    throw new TypeError("eval execution plan identities are duplicated");
  }
  if (membership === "opaque") {
    const item = workItems[0];
    if (slots.length !== 0 || workItems.length !== 1 || item?.opaque_membership !== true || item.logical_attempt !== null
      || item.slots.length !== 0 || item.task_ids.length !== 0 || item.work_id !== opaqueWorkId(item.eval_id)
      || taskResources !== undefined
      || JSON.stringify(item.reservation) !== JSON.stringify(scaleResources(resources, item.requested_parallelism))) {
      throw new TypeError("opaque execution plan shape is invalid");
    }
    return;
  }
  if (slots.length === 0 || workItems.length === 0 || workItems.some((item) => item.opaque_membership)) throw new TypeError("known execution plan shape is invalid");
  const planned = new Set(slots.map((slot) => slot.slot_id));
  const assigned = workItems.flatMap((item) => item.slots);
  if (new Set(assigned).size !== assigned.length || assigned.length !== planned.size || assigned.some((slot) => !planned.has(slot))) {
    throw new TypeError("eval execution plan slots are not assigned exactly once");
  }
  const byId = new Map(slots.map((slot) => [slot.slot_id, slot]));
  for (const item of workItems) {
    const members = item.slots.map((slotId) => byId.get(slotId) as TrialSlotV1);
    const taskIds = [...new Set(members.map((slot) => slot.task_id))].sort(compareBytes);
    if (item.logical_attempt === null || members.some((slot) => slot.attempt !== item.logical_attempt)
      || JSON.stringify(item.task_ids) !== JSON.stringify(taskIds)
      || item.requested_parallelism > item.slots.length
      || JSON.stringify(item.reservation) !== JSON.stringify(reservationForTasks(item.task_ids, item.requested_parallelism, resources, taskResources))) {
      throw new TypeError(`eval execution plan work item does not match its slots: ${item.work_id}`);
    }
    const expected = workItemId(item.eval_id, item.logical_attempt, item.slots);
    if (item.work_id !== expected) throw new TypeError(`eval execution plan work item identity does not match: ${item.work_id}`);
  }
}

function parseBenchmark(value: unknown): EvalExecutionPlanV1["benchmark"] {
  if (!isRecord(value)) throw new TypeError("eval execution plan benchmark is invalid");
  assertOnlyKeys(value, ["id", "revision", "verifier_identity"], "eval execution plan benchmark");
  if (typeof value.id !== "string" || !value.id || typeof value.revision !== "string" || !value.revision || !isSha256(value.verifier_identity)) {
    throw new TypeError("eval execution plan benchmark is invalid");
  }
  return { id: value.id, revision: value.revision, verifier_identity: value.verifier_identity };
}

function parseRetryPolicy(value: unknown): EvalExecutionPlanV1["retry_policy"] {
  if (!isRecord(value)) throw new TypeError("eval execution plan retry policy is invalid");
  assertOnlyKeys(value, [
    "infrastructure_retries", "infrastructure_retry_backoff_ms", "verifier_execution", "candidate_rerun_on_verifier_failure",
  ], "eval execution plan retry policy");
  if (!Number.isSafeInteger(value.infrastructure_retries) || (value.infrastructure_retries as number) < 0
    || typeof value.infrastructure_retry_backoff_ms !== "number" || !Number.isFinite(value.infrastructure_retry_backoff_ms) || value.infrastructure_retry_backoff_ms < 0
    || value.verifier_execution !== "same-trial-verifier-only" || value.candidate_rerun_on_verifier_failure !== false) {
    throw new TypeError("eval execution plan retry policy is invalid");
  }
  return value as unknown as EvalExecutionPlanV1["retry_policy"];
}

function canonicalTasks(tasks: readonly string[]): string[] {
  if (tasks.length === 0 || tasks.some((task) => typeof task !== "string" || !task) || new Set(tasks).size !== tasks.length) {
    throw new TypeError("execution plan tasks must be a non-empty unique list");
  }
  return [...tasks].sort(compareBytes);
}

function parseResourceVector(value: unknown, label: string): ResourceVectorV1 {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const fields = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
  if (Object.keys(value).some((key) => !fields.includes(key as typeof fields[number]))) throw new TypeError(`${label} has unknown fields`);
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new TypeError(`${label} ${field} is invalid`);
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as ResourceVectorV1;
}

function scaleResources(resources: ResourceVectorV1, count: number): ResourceVectorV1 {
  const scaled = Object.fromEntries(Object.entries(resources).map(([name, value]) => [name, value * count])) as unknown as ResourceVectorV1;
  return parseResourceVector(scaled, "scaled work item reservation");
}

function isEvalId(value: unknown): value is string {
  return typeof value === "string" && /^eval_[a-f0-9]{32}$/.test(value);
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function workItemId(evalId: string, logicalAttempt: number, slots: string[]): string {
  return `work_${sha256JSON({ eval_id: evalId, backend: "harbor", logical_attempt: logicalAttempt, slots }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function opaqueWorkId(evalId: string): string {
  return `work_${sha256JSON({ eval_id: evalId, backend: "harbor", membership: "opaque" }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
