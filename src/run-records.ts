import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { statePaths } from "./config.js";
import type {
  HarnessIdentityV1,
  ModelIdentityV1,
  ProtocolIdentityV1,
  RunContextV1,
  RunRecordV1,
  RunStatus,
  Sha256,
  TrajectoryRefV2,
} from "./domain/types.js";
import {
  asRecord,
  asSha256,
  asString,
  validateEvalRunParent,
  validateRelativePath,
  validateRunContext,
  validateRunObservation,
  validateTrajectoryRef,
} from "./domain/validate.js";
import { atomicWriteJSON, ensureDir, readJSON } from "./fs.js";
import { readTrajectory, trajectoryRefPath } from "./trajectories/store.js";

const RUN_STATUSES = new Set<RunStatus>([
  "queued", "preparing", "running", "succeeded", "failed", "timed_out", "cancelled",
]);

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256JSON(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`;
}

export function sha256Bytes(value: string | Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function inferModelProvider(modelId: string, harnessId: string): string | undefined {
  const prefix = modelId.includes("/") ? modelId.split("/", 1)[0]?.trim() : "";
  if (prefix) return prefix;
  return ({ codex: "openai", claude: "anthropic", deepseek: "deepseek" } as Record<string, string>)[harnessId];
}

/** Conservative: aliases are unresolved unless the caller/provider says otherwise. */
export function defaultModelIdentity(
  requestedId: string,
  harnessId: string,
  options: { provider?: string; effectiveId?: string; parametersSha256?: Sha256; resolved?: boolean } = {},
): ModelIdentityV1 {
  const model: ModelIdentityV1 = {
    requested_id: requestedId,
    effective_id: options.effectiveId ?? requestedId,
    identity_resolved: options.resolved ?? looksImmutableModelId(options.effectiveId ?? requestedId),
  };
  const provider = options.provider ?? inferModelProvider(requestedId, harnessId);
  if (provider) model.provider = provider;
  if (options.parametersSha256) model.parameters_sha256 = options.parametersSha256;
  return model;
}

export function looksImmutableModelId(modelId: string): boolean {
  if (!modelId) return false;
  return /^sha256:[0-9a-f]{64}$/.test(modelId)
    || /(?:^|[-_.])\d{4}-\d{2}-\d{2}(?:$|[-_.])/.test(modelId)
    || /@(?:snapshot|version|commit):[^@\s]+$/i.test(modelId);
}

export interface RunRecordLoadResult {
  record: RunRecordV1;
  directory: string;
  trajectory_status: "valid" | "missing" | "corrupt";
  verifier_status: "valid" | "missing";
  record_status: "valid" | "corrupt";
  issues: string[];
}

/** Project the persisted manifest into the logical RunRecord V1 schema. */
export function projectRunRecord(manifestValue: unknown): RunRecordV1 {
  const manifest = asRecord(manifestValue, "run manifest");
  const runId = asString(manifest.run_id, "run_id");
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError(`invalid run_id: ${runId}`);
  const status = asString(manifest.status, "run status") as RunStatus;
  if (!RUN_STATUSES.has(status)) throw new TypeError(`invalid run status: ${status}`);
  const context = validateRunContext(manifest.context ?? { kind: "ad_hoc" });
  const harness = projectHarnessIdentity(manifest);
  const model = projectModelIdentity(manifest, harness.harness_id);
  const protocol = projectProtocolIdentity(manifest);
  const record: RunRecordV1 = {
    run_id: runId,
    context,
    status,
    harness,
    model,
    protocol,
    request_ref: validateRelativePath(manifest.request_ref ?? "request.json", "request_ref"),
    resolution_ref: validateRelativePath(manifest.resolution_ref ?? "resolution.json", "resolution_ref"),
    created_at: isoTimestamp(manifest.created_at, "created_at"),
  };
  if (manifest.parent !== undefined) record.parent = validateEvalRunParent(manifest.parent);
  if (manifest.observation !== undefined) record.observation = validateRunObservation(manifest.observation);
  if (manifest.result_ref !== undefined) record.result_ref = validateRelativePath(manifest.result_ref, "result_ref");
  else if (isTerminal(status)) record.result_ref = "result.json";
  if (manifest.trajectory_ref !== undefined) record.trajectory_ref = validateRelativePath(manifest.trajectory_ref, "trajectory_ref");
  if (manifest.completed_at !== undefined) record.completed_at = isoTimestamp(manifest.completed_at, "completed_at");
  return record;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = asString(value, label);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${label} must be an ISO date-time string`);
  return timestamp;
}

function projectHarnessIdentity(manifest: Record<string, unknown>): HarnessIdentityV1 {
  const nested = manifest.harness === undefined ? null : asRecord(manifest.harness, "manifest harness");
  const revisionValue = nested?.revision_identity ?? manifest.revision_identity;
  let revisionIdentity: Sha256 | null = null;
  if (revisionValue !== undefined && revisionValue !== null) revisionIdentity = asSha256(revisionValue, "harness revision_identity");
  const harness: HarnessIdentityV1 = {
    harness_id: asString(nested?.harness_id ?? manifest.harness_id ?? manifest.agent, "harness_id"),
    requested_ref: asString(nested?.requested_ref ?? manifest.requested_harness_ref ?? manifest.canonical_harness_ref, "requested harness ref"),
    revision_identity: revisionIdentity,
  };
  const artifact = nested?.artifact_id ?? manifest.artifact_id;
  if (artifact !== undefined && artifact !== null) harness.artifact_id = asSha256(artifact, "artifact_id");
  const argsDigest = nested?.agent_args_sha256 ?? manifest.agent_args_sha256;
  if (typeof argsDigest === "string" && /^[0-9a-f]{64}$/.test(argsDigest)) {
    harness.agent_args_sha256 = `sha256:${argsDigest}`;
  } else if (argsDigest !== undefined && argsDigest !== null) {
    harness.agent_args_sha256 = asSha256(argsDigest, "agent_args_sha256");
  }
  return harness;
}

function projectModelIdentity(manifest: Record<string, unknown>, harnessId: string): ModelIdentityV1 {
  const nested = manifest.model === undefined ? null : asRecord(manifest.model, "manifest model");
  const requestedId = asString(nested?.requested_id ?? manifest.requested_model ?? "", "requested model id");
  const effectiveId = asString(nested?.effective_id ?? manifest.effective_model ?? requestedId, "effective model id");
  const model: ModelIdentityV1 = { requested_id: requestedId, effective_id: effectiveId };
  const provider = nested?.provider ?? manifest.model_provider ?? inferModelProvider(requestedId, harnessId);
  if (typeof provider === "string" && provider) model.provider = provider;
  const parameters = nested?.parameters_sha256 ?? manifest.parameters_sha256;
  if (parameters !== undefined && parameters !== null) model.parameters_sha256 = asSha256(parameters, "parameters_sha256");
  const resolved = nested?.identity_resolved ?? manifest.model_identity_resolved;
  model.identity_resolved = resolved === true;
  return model;
}

function projectProtocolIdentity(manifest: Record<string, unknown>): ProtocolIdentityV1 {
  const nested = manifest.protocol === undefined ? null : asRecord(manifest.protocol, "manifest protocol");
  const timeout = Number(nested?.timeout_ms ?? manifest.timeout_ms);
  if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError("protocol timeout_ms must be non-negative");
  const protocol: ProtocolIdentityV1 = {
    timeout_ms: timeout,
    workspace_mode: asString(nested?.workspace_mode ?? manifest.workspace_mode, "protocol workspace_mode"),
  };
  for (const [field, label] of [
    ["initial_workspace_digest", "initial_workspace_digest"],
    ["environment_identity", "environment_identity"],
    ["tool_policy_sha256", "tool_policy_sha256"],
  ] as const) {
    const value = nested?.[field] ?? manifest[field];
    if (value !== undefined && value !== null) protocol[field] = asSha256(value, label);
  }
  return protocol;
}

export async function loadRunRecord(
  runDirectory: string,
  { verifyTrajectory = true }: { verifyTrajectory?: boolean } = {},
): Promise<RunRecordLoadResult> {
  const manifestPath = path.join(runDirectory, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new TypeError("run manifest must be a regular file");
  const manifest = await readJSON(manifestPath);
  const record = projectRunRecord(manifest);
  const issues: string[] = [];
  const recordStatus = await verifyCoreRecordFiles(runDirectory, record, issues);
  const trajectoryStatus = verifyTrajectory
    ? await verifyRunTrajectory(runDirectory, record, issues)
    : record.trajectory_ref ? "valid" : "missing";
  const verifierStatus = await verifyVerifierResult(runDirectory, record, issues);
  if (isTerminal(record.status) && record.context.kind === "benchmark_task" && !record.observation) {
    issues.push("terminal benchmark run has no observation");
  }
  return {
    record,
    directory: runDirectory,
    trajectory_status: trajectoryStatus,
    verifier_status: verifierStatus,
    record_status: recordStatus,
    issues,
  };
}

async function verifyCoreRecordFiles(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "corrupt"> {
  const refs = [record.request_ref, record.resolution_ref, ...(isTerminal(record.status) && record.result_ref ? [record.result_ref] : [])];
  if (isTerminal(record.status) && !record.result_ref) {
    issues.push("terminal run has no result_ref");
    return "corrupt";
  }
  let valid = true;
  for (const ref of refs) {
    const target = path.resolve(runDirectory, ...ref.split("/"));
    if (!isWithin(runDirectory, target)) {
      issues.push(`run record ref escapes run directory: ${ref}`);
      valid = false;
      continue;
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
      const value = await readJSON(target);
      if (ref === record.result_ref) {
        const result = asRecord(value, "run result");
        if (result.run_id !== record.run_id || result.status !== record.status) {
          throw new Error("result identity or status does not match manifest");
        }
      }
    } catch (error) {
      issues.push(`run record file is missing or invalid (${ref}): ${(error as Error).message}`);
      valid = false;
    }
  }
  return valid ? "valid" : "corrupt";
}

async function verifyVerifierResult(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "missing"> {
  const ref = record.observation?.verifier_result_ref;
  if (!ref) return "missing";
  const target = path.resolve(runDirectory, ...ref.split("/"));
  if (!isWithin(runDirectory, target)) {
    issues.push(`verifier result escapes run directory: ${ref}`);
    return "missing";
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
    await readJSON(target);
    return "valid";
  } catch (error) {
    issues.push(`verifier result is missing or invalid: ${(error as Error).message}`);
    return "missing";
  }
}

export function isTerminal(status: RunStatus): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled"].includes(status);
}

async function verifyRunTrajectory(
  runDirectory: string,
  record: RunRecordV1,
  issues: string[],
): Promise<"valid" | "missing" | "corrupt"> {
  const refFile = record.trajectory_ref
    ? path.join(runDirectory, ...record.trajectory_ref.split("/"))
    : trajectoryRefPath(runDirectory);
  let raw: unknown;
  try {
    if ((await lstat(refFile)).isSymbolicLink()) throw new Error("trajectory ref is a symbolic link");
    raw = await readJSON(refFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    issues.push(`trajectory ref is unreadable: ${(error as Error).message}`);
    return "corrupt";
  }
  let ref;
  try {
    ref = validateTrajectoryRef(raw);
  } catch (error) {
    issues.push(`trajectory ref is invalid: ${(error as Error).message}`);
    return "corrupt";
  }
  if (ref.run_id !== record.run_id) {
    issues.push(`trajectory run_id mismatch: ${ref.run_id}`);
    return "corrupt";
  }
  if (ref.schema_version === "1") {
    try {
      const legacyTarget = path.isAbsolute(ref.path) ? ref.path : path.resolve(runDirectory, ref.path);
      if ((await lstat(legacyTarget)).isSymbolicLink()) throw new Error("legacy trajectory is a symbolic link");
      if (ref.sha256) {
        const digest = sha256Bytes(await readFile(legacyTarget));
        if (digest !== ref.sha256) throw new Error(`expected ${ref.sha256}, got ${digest}`);
      }
      await readTrajectory(legacyTarget);
      return "valid";
    } catch (error) {
      issues.push(`legacy trajectory checksum failed: ${(error as Error).message}`);
      return "corrupt";
    }
  }
  for (const file of ref.files) {
    const target = path.resolve(runDirectory, ...file.path.split("/"));
    if (!isWithin(runDirectory, target)) {
      issues.push(`trajectory file escapes run directory: ${file.path}`);
      return "corrupt";
    }
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${file.path}`);
      if (!info.isFile() || info.size !== file.bytes) throw new Error(`size mismatch for ${file.path}`);
      const digest = sha256Bytes(await readFile(target));
      if (digest !== file.sha256) throw new Error(`checksum mismatch for ${file.path}`);
      if (file.role === "canonical_session") await readTrajectory(target);
      else if (file.media_type === "application/x-ndjson") await validateJSONLines(target);
    } catch (error) {
      issues.push(`trajectory file verification failed: ${(error as Error).message}`);
      return "corrupt";
    }
  }
  return "valid";
}

async function validateJSONLines(file: string): Promise<void> {
  const content = await readFile(file, "utf8");
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { JSON.parse(line); } catch (error) {
      throw new Error(`invalid JSONL at ${path.basename(file)}:${index + 1}: ${(error as Error).message}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface RunQuery {
  run_id?: string;
  context_kind?: RunContextV1["kind"];
  benchmark_id?: string;
  benchmark_revision?: string;
  task_id?: string;
  task_digest?: string;
  seed_task_id?: string;
  seed_task_digest?: string;
  iteration_id?: string;
  harness_id?: string;
  revision_identity?: string;
  model_provider?: string;
  requested_model?: string;
  effective_model?: string;
  eval_id?: string;
  status?: RunStatus | RunStatus[];
  created_from?: string;
  created_to?: string;
}

export async function queryRuns({ root, query = {}, verifyTrajectory = false }: {
  root: string;
  query?: RunQuery;
  verifyTrajectory?: boolean;
}): Promise<RunRecordLoadResult[]> {
  const runsRoot = statePaths(root).runs;
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: RunRecordLoadResult[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
    try {
      const loaded = await loadRunRecord(path.join(runsRoot, entry.name), { verifyTrajectory });
      if (matchesQuery(loaded.record, query)) records.push(loaded);
    } catch {
      // A corrupt manifest is not a query result; rebuild remains best effort.
    }
  }
  return records;
}

function matchesQuery(record: RunRecordV1, query: RunQuery): boolean {
  if (query.run_id !== undefined && record.run_id !== query.run_id) return false;
  if (query.context_kind !== undefined && record.context.kind !== query.context_kind) return false;
  if (query.harness_id !== undefined && record.harness.harness_id !== query.harness_id) return false;
  if (query.revision_identity !== undefined && record.harness.revision_identity !== query.revision_identity) return false;
  if (query.model_provider !== undefined && record.model.provider !== query.model_provider) return false;
  if (query.requested_model !== undefined && record.model.requested_id !== query.requested_model) return false;
  if (query.effective_model !== undefined && record.model.effective_id !== query.effective_model) return false;
  if (query.eval_id !== undefined && record.parent?.eval_id !== query.eval_id) return false;
  const statuses = query.status === undefined ? null : Array.isArray(query.status) ? query.status : [query.status];
  if (statuses && !statuses.includes(record.status)) return false;
  if (query.created_from !== undefined && record.created_at < query.created_from) return false;
  if (query.created_to !== undefined && record.created_at > query.created_to) return false;
  if (record.context.kind === "benchmark_task") {
    if (query.benchmark_id !== undefined && record.context.benchmark_id !== query.benchmark_id) return false;
    if (query.benchmark_revision !== undefined && record.context.benchmark_revision !== query.benchmark_revision) return false;
    if (query.task_id !== undefined && record.context.task_id !== query.task_id) return false;
    if (query.task_digest !== undefined && record.context.task_digest !== query.task_digest) return false;
  } else if ([query.benchmark_id, query.benchmark_revision, query.task_id, query.task_digest].some((value) => value !== undefined)) {
    return false;
  }
  if (record.context.kind === "seed_task") {
    if (query.seed_task_id !== undefined && record.context.seed_task_id !== query.seed_task_id) return false;
    if (query.seed_task_digest !== undefined && record.context.seed_task_digest !== query.seed_task_digest) return false;
    if (query.iteration_id !== undefined && record.context.iteration_id !== query.iteration_id) return false;
  } else if ([query.seed_task_id, query.seed_task_digest, query.iteration_id].some((value) => value !== undefined)) {
    return false;
  }
  return true;
}

export interface RebuiltRunIndex {
  schema_version: "1";
  generated_at: string;
  runs: Array<Record<string, unknown>>;
}

export async function rebuildRunIndexes({ root }: { root: string }): Promise<RebuiltRunIndex> {
  const records = await queryRuns({ root });
  const index: RebuiltRunIndex = {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    runs: records.map(({ record }) => ({
      run_id: record.run_id,
      context: record.context,
      harness_id: record.harness.harness_id,
      revision_identity: record.harness.revision_identity,
      model_provider: record.model.provider ?? null,
      requested_model: record.model.requested_id,
      effective_model: record.model.effective_id,
      eval_id: record.parent?.eval_id ?? null,
      status: record.status,
      created_at: record.created_at,
      completed_at: record.completed_at ?? null,
    })),
  };
  const directory = await ensureDir(statePaths(root).indexes);
  await atomicWriteJSON(path.join(directory, "runs.v1.json"), index);
  return index;
}

export type ComparisonDimension = "model" | "harness";

export interface ComparisonExclusion {
  run_id: string;
  reasons: string[];
}

export interface ComparisonGroup {
  identity: HarnessIdentityV1 | ModelIdentityV1;
  run_ids: string[];
  valid_observations: number;
  rewards: { count: number; mean: number | null; min: number | null; max: number | null };
  agent_failures: number;
  invalid_run_ids: string[];
}

export interface StrictComparisonResult {
  schema_version: "1";
  dimension: ComparisonDimension;
  strict: boolean;
  reference_run_id: string | null;
  groups: ComparisonGroup[];
  excluded: ComparisonExclusion[];
  unresolved_identities: Array<{ run_id: string; identity: "model" | "harness" }>;
}

export function compareRunRecords(
  loadedRecords: RunRecordLoadResult[],
  { dimension, referenceRunId }: { dimension: ComparisonDimension; referenceRunId?: string },
): StrictComparisonResult {
  const candidateReference = referenceRunId
    ? loadedRecords.find(({ record }) => record.run_id === referenceRunId)
    : loadedRecords.find(({ record }) => record.context.kind === "benchmark_task");
  const reference = candidateReference?.record;
  const excluded: ComparisonExclusion[] = [];
  const unresolved: Array<{ run_id: string; identity: "model" | "harness" }> = [];
  const groups = new Map<string, ComparisonGroup>();

  for (const loaded of loadedRecords) {
    const record = loaded.record;
    const reasons: string[] = [];
    if (record.context.kind !== "benchmark_task") reasons.push("not_benchmark_task");
    if (!reference || reference.context.kind !== "benchmark_task") {
      if (!reasons.includes("not_benchmark_task")) reasons.push("benchmark_reference_missing");
    } else if (record.context.kind === "benchmark_task") {
      reasons.push(...comparisonIdentityMismatches(reference, record, dimension));
    }
    if (record.harness.revision_identity === null) {
      reasons.push("harness_identity_unresolved");
      unresolved.push({ run_id: record.run_id, identity: "harness" });
    }
    if (record.model.identity_resolved !== true || !record.model.provider || !record.model.effective_id) {
      reasons.push("model_identity_unresolved");
      unresolved.push({ run_id: record.run_id, identity: "model" });
    }
    if (loaded.trajectory_status !== "valid") reasons.push("trajectory_missing_or_corrupt");
    if (loaded.record_status !== "valid") reasons.push("infrastructure_failure");
    if (record.observation?.status === "invalid") reasons.push(record.observation.invalid_reason || "infrastructure_failure");
    else if (record.context.kind === "benchmark_task" && !record.observation) reasons.push("verifier_result_missing");
    else if (record.context.kind === "benchmark_task" && loaded.verifier_status !== "valid") reasons.push("verifier_result_missing");
    if (record.status === "cancelled" && !reasons.includes("cancelled")) reasons.push("cancelled");

    const identityReasons = reasons.filter((reason) => isIdentityExclusion(reason));
    const canGroup = identityReasons.length === 0 && reference !== undefined && record.context.kind === "benchmark_task";
    if (canGroup) {
      const identity = dimension === "model" ? record.model : record.harness;
      const key = canonicalJSON(identity);
      let group = groups.get(key);
      if (!group) {
        group = {
          identity,
          run_ids: [],
          valid_observations: 0,
          rewards: { count: 0, mean: null, min: null, max: null },
          agent_failures: 0,
          invalid_run_ids: [],
        };
        groups.set(key, group);
      }
      if (record.status !== "succeeded") group.agent_failures += 1;
      if (
        record.observation?.status === "valid"
        && loaded.trajectory_status === "valid"
        && loaded.verifier_status === "valid"
        && loaded.record_status === "valid"
      ) {
        group.run_ids.push(record.run_id);
        group.valid_observations += 1;
        addReward(group, record.observation.reward as number);
      } else {
        group.invalid_run_ids.push(record.run_id);
      }
    }
    if (reasons.length > 0) excluded.push({ run_id: record.run_id, reasons: [...new Set(reasons)] });
  }

  const resultGroups = [...groups.values()].sort((left, right) => canonicalJSON(left.identity).localeCompare(canonicalJSON(right.identity)));
  const hasUnresolvedVariable = unresolved.some(({ identity }) => identity === dimension);
  return {
    schema_version: "1",
    dimension,
    strict: Boolean(reference) && resultGroups.length >= 2 && !hasUnresolvedVariable,
    reference_run_id: reference?.run_id ?? null,
    groups: resultGroups,
    excluded,
    unresolved_identities: unresolved,
  };
}

function comparisonIdentityMismatches(reference: RunRecordV1, record: RunRecordV1, dimension: ComparisonDimension): string[] {
  const left = reference.context;
  const right = record.context;
  if (left.kind !== "benchmark_task" || right.kind !== "benchmark_task") return [];
  const reasons: string[] = [];
  if (left.benchmark_id !== right.benchmark_id || left.benchmark_revision !== right.benchmark_revision || left.task_id !== right.task_id) {
    reasons.push("benchmark_revision_mismatch");
  }
  if (left.task_digest !== right.task_digest) reasons.push("task_digest_mismatch");
  if (left.verifier_identity !== right.verifier_identity) reasons.push("verifier_identity_mismatch");
  if (canonicalJSON(reference.protocol) !== canonicalJSON(record.protocol)) reasons.push("protocol_identity_mismatch");
  if (dimension === "model" && canonicalJSON(reference.harness) !== canonicalJSON(record.harness)) reasons.push("harness_identity_mismatch");
  if (dimension === "harness" && canonicalJSON(reference.model) !== canonicalJSON(record.model)) reasons.push("model_identity_mismatch");
  return reasons;
}

function isIdentityExclusion(reason: string): boolean {
  return [
    "not_benchmark_task", "benchmark_reference_missing", "benchmark_revision_mismatch",
    "task_digest_mismatch", "verifier_identity_mismatch", "protocol_identity_mismatch",
    "harness_identity_mismatch", "model_identity_mismatch", "harness_identity_unresolved",
    "model_identity_unresolved",
  ].includes(reason);
}

function addReward(group: ComparisonGroup, reward: number): void {
  const previousCount = group.rewards.count;
  const previousTotal = (group.rewards.mean ?? 0) * previousCount;
  group.rewards.count += 1;
  group.rewards.mean = (previousTotal + reward) / group.rewards.count;
  group.rewards.min = group.rewards.min === null ? reward : Math.min(group.rewards.min, reward);
  group.rewards.max = group.rewards.max === null ? reward : Math.max(group.rewards.max, reward);
}

export async function compareRuns({ root, dimension, query = {}, referenceRunId }: {
  root: string;
  dimension: ComparisonDimension;
  query?: RunQuery;
  referenceRunId?: string;
}): Promise<StrictComparisonResult> {
  return compareRunRecords(await queryRuns({ root, query, verifyTrajectory: true }), {
    dimension,
    ...(referenceRunId ? { referenceRunId } : {}),
  });
}

export function benchmarkVerifierIdentity(benchmarkId: string, benchmarkRevision: string): Sha256 {
  return sha256JSON({ backend: "harbor", benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision, verifier: "dataset" });
}

export function benchmarkTaskDigest(benchmarkId: string, benchmarkRevision: string, taskId: string): Sha256 {
  return sha256JSON({ benchmark_id: benchmarkId, benchmark_revision: benchmarkRevision, task_id: taskId });
}

export function trajectoryRefV2(value: TrajectoryRefV2): TrajectoryRefV2 {
  return value;
}
