import type { BackendWorkItemV1, EnvironmentImageFallbackV1, EnvironmentImageUseV1, EvalExecutionPlanV1, EvalId, EvalRequest, ModelCapturePlanV1, ResourceVectorV1, Sha256, TaskResourceRequirementV1, TrialSlotV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { artifactPinFields, opaqueWorkId, parseArtifactAssignments, parseRuntimeContract, workItemId } from "./execution-plan-artifacts.js";
import type { EvalArtifactAssignmentInputV1, ParsedArtifactAssignment } from "./execution-plan-artifacts.js";
import { imagesForTasks, parseEnvironmentImageFallbacks, parseEnvironmentImageUses } from "./execution-plan-images.js";
import { parseTaskResourceRequirements, reservationForTasks } from "./execution-plan-resources.js";

export type { EvalArtifactAssignmentInputV1 } from "./execution-plan-artifacts.js";

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
    artifactAssignments?: readonly EvalArtifactAssignmentInputV1[];
  };
  tasks: readonly string[] | null;
  maxParallelism: number;
  trialResources?: ResourceVectorV1;
  taskResources?: readonly TaskResourceRequirementV1[];
  environmentImages?: readonly EnvironmentImageUseV1[];
  environmentImageFallbacks?: readonly EnvironmentImageFallbackV1[];
  provider?: string;
  modelCapture?: ModelCapturePlanV1 | null;
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
  const modelCapture = options.modelCapture === null ? undefined : parseModelCapturePlan(options.modelCapture ?? {
    requested_mode: "native",
    effective_mode: "native",
    required: false,
  });
  const tasks = options.tasks === null ? null : canonicalTasks(options.tasks);
  const artifactAssignments = parseArtifactAssignments(options.candidate.artifactAssignments, tasks, options.candidate.artifactId);
  const taskResources = tasks === null ? undefined : parseTaskResourceRequirements(options.taskResources, tasks);
  const environmentImages = tasks === null ? [] : parseEnvironmentImageUses(options.environmentImages ?? [], tasks, "execution plan environment images");
  const imageFallbacks = tasks === null ? [] : parseEnvironmentImageFallbacks(options.environmentImageFallbacks ?? [], tasks);
  const candidateIdentity = sha256JSON({
    harness_revision_identity: options.candidate.revisionIdentity,
    artifact_assignments: artifactAssignments.length > 0
      ? artifactAssignments.map((entry) => ({ task_ids: entry.taskIds, artifact_id: entry.artifactId, runtime_contract: entry.runtimeContract }))
      : [{ task_ids: tasks ?? [], artifact_id: options.candidate.artifactId }],
    requested_model: options.request.model,
    agent_args_sha256: sha256JSON(options.request.agent_args),
    protocol: {
      timeout_ms: options.request.timeout_ms,
      setup_timeout_ms: options.request.setup_timeout_ms,
    },
  });
  const slots = tasks === null ? [] : buildSlots(options.evalId, tasks, options.request.attempts, candidateIdentity);
  const workItems = tasks === null
    ? [opaqueWorkItem(options.evalId, options.maxParallelism, resources, provider, artifactAssignments[0])]
    : options.workItemMode === "task-slots"
      ? buildTaskWorkItems(options.evalId, slots, resources, provider, taskResources, environmentImages, artifactAssignments)
      : buildAttemptWorkItems(options.evalId, tasks, slots, options.request.attempts, options.maxParallelism, resources, provider, taskResources, environmentImages, artifactAssignments);
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
    ...(modelCapture ? { model_capture: modelCapture } : {}),
    max_parallelism: options.maxParallelism,
    default_trial_resources: resources,
    ...(taskResources ? { task_resources: taskResources } : {}),
    ...(imageFallbacks.length > 0 ? { image_fallbacks: imageFallbacks } : {}),
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
    "schema_version", "planner", "eval_id", "membership", "candidate_identity", "benchmark", "provider", "model_capture",
    "max_parallelism", "default_trial_resources", "task_resources", "image_fallbacks", "slots", "work_items", "retry_policy", "created_at",
  ], "eval execution plan");
  if (plan.schema_version !== "1" || plan.planner !== "hitch-local-v1" || !isEvalId(plan.eval_id)
    || (plan.membership !== "known" && plan.membership !== "opaque")
    || !isSha256(plan.candidate_identity) || typeof plan.provider !== "string" || !plan.provider
    || !Number.isSafeInteger(plan.max_parallelism) || (plan.max_parallelism as number) < 1
    || typeof plan.created_at !== "string" || !Number.isFinite(Date.parse(plan.created_at))) {
    throw new TypeError("eval execution plan identity is invalid");
  }
  const benchmark = parseBenchmark(plan.benchmark);
  const modelCapture = plan.model_capture === undefined ? undefined : parseModelCapturePlan(plan.model_capture);
  const resources = parseResourceVector(plan.default_trial_resources, "execution plan default trial resources");
  if (!Array.isArray(plan.slots) || !Array.isArray(plan.work_items)) throw new TypeError("eval execution plan work graph is invalid");
  const slots = plan.slots.map((slot, index) => parseSlot(slot, plan.eval_id as string, plan.candidate_identity as Sha256, index));
  const taskResources = parseTaskResourceRequirements(plan.task_resources, slots.map((slot) => slot.task_id).filter((task, index, all) => all.indexOf(task) === index));
  const taskIds = slots.map((slot) => slot.task_id).filter((task, index, all) => all.indexOf(task) === index);
  const imageFallbacks = parseEnvironmentImageFallbacks(plan.image_fallbacks ?? [], taskIds);
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
    ...(modelCapture ? { model_capture: modelCapture } : {}),
    max_parallelism: plan.max_parallelism as number,
    default_trial_resources: resources,
    ...(taskResources ? { task_resources: taskResources } : {}),
    ...(imageFallbacks.length > 0 ? { image_fallbacks: imageFallbacks } : {}),
    slots,
    work_items: workItems,
    retry_policy: retry,
    created_at: plan.created_at,
  };
}

function parseModelCapturePlan(value: unknown): ModelCapturePlanV1 {
  if (!isRecord(value)) throw new TypeError("execution plan model capture must be an object");
  assertOnlyKeys(value, ["requested_mode", "effective_mode", "required", "topology", "degraded_reason"], "execution plan model capture");
  const modes = new Set(["off", "native", "proxy", "hybrid"]);
  if (!modes.has(value.requested_mode as string) || !modes.has(value.effective_mode as string)
    || typeof value.required !== "boolean"
    || value.topology !== undefined && value.topology !== "host-side" && value.topology !== "in-sandbox"
    || value.degraded_reason !== undefined && (typeof value.degraded_reason !== "string" || !value.degraded_reason)) {
    throw new TypeError("execution plan model capture is invalid");
  }
  if ((value.effective_mode === "proxy" || value.effective_mode === "hybrid") !== (value.topology !== undefined)) {
    throw new TypeError("execution plan model capture topology is invalid");
  }
  if ((value.requested_mode !== value.effective_mode) !== (value.degraded_reason !== undefined)) {
    throw new TypeError("execution plan model capture degradation evidence is invalid");
  }
  if (value.required === true && value.requested_mode !== value.effective_mode) {
    throw new TypeError("required model capture cannot be degraded");
  }
  return {
    requested_mode: value.requested_mode as ModelCapturePlanV1["requested_mode"],
    effective_mode: value.effective_mode as ModelCapturePlanV1["effective_mode"],
    required: value.required,
    ...(value.topology === undefined ? {} : { topology: value.topology }),
    ...(value.degraded_reason === undefined ? {} : { degraded_reason: value.degraded_reason }),
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
  environmentImages: readonly EnvironmentImageUseV1[] = [],
  artifactAssignments: readonly ParsedArtifactAssignment[] = [],
): BackendWorkItemV1[] {
  const items: BackendWorkItemV1[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const groups = artifactAssignments.length > 0
      ? artifactAssignments
      : [{ taskIds: [...tasks] }];
    for (const group of groups) {
      const groupTasks = tasks.filter((task) => group.taskIds.includes(task));
      if (groupTasks.length === 0) continue;
      const selected = slots.filter((slot) => slot.attempt === attempt && groupTasks.includes(slot.task_id)).map((slot) => slot.slot_id);
      const imageRefs = imagesForTasks(environmentImages, groupTasks);
      const requestedParallelism = Math.min(maxParallelism, selected.length);
      const artifactPin = artifactPinFields(group);
      items.push({
        schema_version: "1",
        work_id: workItemId(evalId, attempt, selected, imageRefs, artifactPin),
        eval_id: evalId,
        backend: "harbor",
        logical_attempt: attempt,
        task_ids: [...groupTasks],
        slots: selected,
        opaque_membership: false,
        requested_parallelism: requestedParallelism,
        reservation: reservationForTasks(groupTasks, requestedParallelism, resources, taskResources),
        provider,
        ...(imageRefs.length > 0 ? { image_refs: imageRefs } : {}),
        ...artifactPin,
      });
    }
  }
  return items;
}

function buildTaskWorkItems(evalId: EvalId, slots: TrialSlotV1[], resources: ResourceVectorV1, provider: string, taskResources?: readonly TaskResourceRequirementV1[], environmentImages: readonly EnvironmentImageUseV1[] = [], artifactAssignments: readonly ParsedArtifactAssignment[] = []): BackendWorkItemV1[] {
  return slots.map((slot) => {
    const imageRefs = imagesForTasks(environmentImages, [slot.task_id]);
    const assignment = artifactAssignments.find((entry) => entry.taskIds.includes(slot.task_id));
    const artifactPin = artifactPinFields(assignment);
    return {
      schema_version: "1",
      work_id: workItemId(evalId, slot.attempt, [slot.slot_id], imageRefs, artifactPin),
      eval_id: evalId,
      backend: "harbor",
      logical_attempt: slot.attempt,
      task_ids: [slot.task_id],
      slots: [slot.slot_id],
      opaque_membership: false,
      requested_parallelism: 1,
      reservation: reservationForTasks([slot.task_id], 1, resources, taskResources),
      provider,
      ...(imageRefs.length > 0 ? { image_refs: imageRefs } : {}),
      ...artifactPin,
    };
  });
}

function opaqueWorkItem(evalId: EvalId, maxParallelism: number, resources: ResourceVectorV1, provider: string, assignment?: ParsedArtifactAssignment): BackendWorkItemV1 {
  const artifactPin = artifactPinFields(assignment);
  const identity = { eval_id: evalId, backend: "harbor", membership: "opaque", ...artifactPin };
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
    ...artifactPin,
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
    "image_refs", "artifact_id", "runtime_contract",
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
  const imageRefs = parseEnvironmentImageUses(value.image_refs ?? [], value.task_ids as string[], `eval execution plan work item ${index} image refs`);
  const artifactId = value.artifact_id === undefined ? undefined : isSha256(value.artifact_id) ? value.artifact_id : (() => { throw new TypeError(`eval execution plan work item ${index} artifact id is invalid`); })();
  const runtimeContract = value.runtime_contract === undefined ? undefined : parseRuntimeContract(value.runtime_contract, `eval execution plan work item ${index}`);
  if ((artifactId === undefined) !== (runtimeContract === undefined)) throw new TypeError(`eval execution plan work item ${index} artifact contract is incomplete`);
  return {
    ...value,
    reservation: parseResourceVector(value.reservation, `eval execution plan work item ${index} reservation`),
    ...(imageRefs.length > 0 ? { image_refs: imageRefs } : {}),
    ...(artifactId ? { artifact_id: artifactId } : {}),
    ...(runtimeContract ? { runtime_contract: runtimeContract } : {}),
  } as BackendWorkItemV1;
}

function assertPlanGraph(membership: "known" | "opaque", slots: TrialSlotV1[], workItems: BackendWorkItemV1[], resources: ResourceVectorV1, taskResources?: readonly TaskResourceRequirementV1[]): void {
  if (new Set(slots.map((slot) => slot.slot_id)).size !== slots.length || new Set(workItems.map((item) => item.work_id)).size !== workItems.length) {
    throw new TypeError("eval execution plan identities are duplicated");
  }
  if (membership === "opaque") {
    const item = workItems[0];
    if (slots.length !== 0 || workItems.length !== 1 || item?.opaque_membership !== true || item.logical_attempt !== null
      || item.slots.length !== 0 || item.task_ids.length !== 0 || item.work_id !== opaqueWorkId(item.eval_id, artifactPinFields(item.artifact_id && item.runtime_contract ? { taskIds: [], artifactId: item.artifact_id, runtimeContract: item.runtime_contract } : undefined))
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
    const expected = workItemId(item.eval_id, item.logical_attempt, item.slots, item.image_refs ?? [], {
      ...(item.artifact_id ? { artifact_id: item.artifact_id } : {}),
      ...(item.runtime_contract ? { runtime_contract: item.runtime_contract } : {}),
    });
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
  const required = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
  const allowed = [...required, "gpu_count", "ephemeral_disk_bytes"] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as typeof allowed[number]))) throw new TypeError(`${label} has unknown fields`);
  for (const field of required) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) throw new TypeError(`${label} ${field} is invalid`);
  }
  if (value.gpu_count !== undefined && (!Number.isSafeInteger(value.gpu_count) || (value.gpu_count as number) < 0)) throw new TypeError(`${label} gpu_count is invalid`);
  if (value.ephemeral_disk_bytes !== undefined && (!Number.isSafeInteger(value.ephemeral_disk_bytes) || (value.ephemeral_disk_bytes as number) < 0)) throw new TypeError(`${label} ephemeral_disk_bytes is invalid`);
  return {
    ...Object.fromEntries(required.map((field) => [field, value[field]])),
    ...(value.gpu_count === undefined ? {} : { gpu_count: value.gpu_count }),
    ...(value.ephemeral_disk_bytes === undefined ? {} : { ephemeral_disk_bytes: value.ephemeral_disk_bytes }),
  } as unknown as ResourceVectorV1;
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

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`${label} has unknown field: ${unexpected}`);
}
