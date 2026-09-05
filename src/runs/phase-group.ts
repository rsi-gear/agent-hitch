import { link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkPhaseGroupV1, BenchmarkPhaseGroupRefV1 } from "../domain/index.js";
import { validateTrajectoryRef } from "../domain/index.js";
import { ensureDir, readJSON, sha256Bytes, sha256JSON, statePaths } from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";
import { loadRunRecord } from "./records.js";

export async function inspectBenchmarkPhaseGroup(input: { root: string; runIds: readonly string[] }): Promise<BenchmarkPhaseGroupV1> {
  if (!input.runIds.length || input.runIds.length > 10_000 || new Set(input.runIds).size !== input.runIds.length
    || input.runIds.some(id => !/^run_[a-f0-9]{32}$/.test(id))) throw new TypeError("invalid phase run membership");
  let group: BenchmarkPhaseGroupV1 | undefined;
  let previousCompleted = -Infinity;
  const sessions = new Set<string>();
  for (const [offset, id] of input.runIds.entries()) {
    const directory = path.join(statePaths(input.root).runs, id);
    const bundle = await verifyResultBundleIndex(directory);
    const loaded = await loadRunRecord(directory, { verifyTrajectory: true });
    const { record } = loaded;
    const context = record.context;
    if (record.run_id !== id || context.kind !== "benchmark_phase" || !record.parent || context.phase_index !== offset + 1
      || loaded.record_status !== "valid" || loaded.trajectory_status !== "valid"
      || !["succeeded", "failed", "timed_out", "cancelled"].includes(record.status)) throw new TypeError("incomplete or non-contiguous phase run evidence");
    if (!/^eval_[a-f0-9]{32}$/.test(record.parent.eval_id)) throw new TypeError("invalid phase eval identity");
    const identity = {
      schema_version: "1" as const, kind: "benchmark-phase-group" as const, scope: "candidate-evidence-only" as const,
      run_group_id: context.run_group_id, eval_id: record.parent.eval_id, trial_id: record.parent.trial_id, attempt: record.parent.attempt,
      benchmark_id: context.benchmark_id, benchmark_revision: context.benchmark_revision, task_id: context.task_id, task_digest: context.task_digest,
      verifier_identity: context.verifier_identity, harness: record.harness, model: record.model,
    };
    if (!group) group = { ...identity, phases: [] };
    else {
      const { phases: _phases, ...expected } = group;
      if (sha256JSON(identity) !== sha256JSON(expected)) throw new TypeError("phase run group or candidate identity changed");
    }
    const result = await readJSON<Record<string, unknown>>(path.join(directory, record.result_ref!));
    const started = Date.parse(String(result.started_at));
    const completed = Date.parse(String(result.completed_at));
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || started < previousCompleted) {
      throw new TypeError("phase processes have missing or overlapping execution intervals");
    }
    previousCompleted = completed;
    const trajectory = validateTrajectoryRef(await readJSON(path.join(directory, record.trajectory_ref!)));
    const session = trajectory.provider_session_id;
    if (typeof session !== "string" || !session || sessions.has(session)) throw new TypeError("phase native session identity is missing or reused");
    sessions.add(session);
    group.phases.push({ phase_index: context.phase_index, run_id: id, process_status: record.status, provider_session_id: session,
      bundle_digest: bundle.bundle_digest, bundle_index_digest: sha256JSON(bundle) });
  }
  return group!;
}

export async function sealBenchmarkPhaseGroup(input: { root: string; runIds: readonly string[] }): Promise<BenchmarkPhaseGroupRefV1> {
  const identity = await inspectBenchmarkPhaseGroup(input);
  const directory = await ensureDir(groupDirectory(input.root, identity.eval_id, identity.run_group_id));
  const target = path.join(directory, "group.json");
  const staging = await mkdtemp(path.join(directory, ".seal-"));
  try {
    const candidate = path.join(staging, "group.json");
    await writeFile(candidate, `${JSON.stringify({ ...identity, created_at: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Linking atomically publishes a complete file without replacing any
    // existing group, including a concurrently published immutable record.
    try { await link(candidate, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const raw = await readGroupFile(target);
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    const { created_at: createdAt, ...saved } = value;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || sha256JSON(saved) !== sha256JSON(identity)) {
      throw new TypeError("phase group is already sealed with different evidence");
    }
    return { run_group_id: identity.run_group_id, digest: sha256Bytes(raw) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function readBenchmarkPhaseGroup(input: {
  root: string; evalId: string; reference: BenchmarkPhaseGroupRefV1;
}): Promise<BenchmarkPhaseGroupV1 & { created_at: string }> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.reference.digest)) throw new TypeError("invalid phase group digest");
  const raw = await readGroupFile(path.join(groupDirectory(input.root, input.evalId, input.reference.run_group_id), "group.json"));
  if (sha256Bytes(raw) !== input.reference.digest) throw new TypeError("phase group digest mismatch");
  const value = JSON.parse(raw.toString()) as Record<string, unknown>;
  if (!Array.isArray(value.phases) || value.phases.some(p => !p || typeof p !== "object" || typeof (p as { run_id?: unknown }).run_id !== "string")) {
    throw new TypeError("invalid phase group membership");
  }
  const actual = await inspectBenchmarkPhaseGroup({ root: input.root, runIds: value.phases.map(p => (p as { run_id: string }).run_id) });
  const { created_at: createdAt, ...identity } = value;
  if (actual.eval_id !== input.evalId || actual.run_group_id !== input.reference.run_group_id || typeof createdAt !== "string"
    || !Number.isFinite(Date.parse(createdAt)) || sha256JSON(identity) !== sha256JSON(actual)) throw new TypeError("phase group evidence changed");
  return { ...actual, created_at: createdAt };
}

function groupDirectory(root: string, evalId: string, groupId: string): string {
  if (!/^eval_[a-f0-9]{32}$/.test(evalId) || !/^run_group_[a-f0-9]{32}$/.test(groupId)) throw new TypeError("invalid phase group storage identity");
  return path.join(statePaths(root).evals, evalId, "run-groups", groupId);
}

async function readGroupFile(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new TypeError("invalid phase group file");
  return readFile(file);
}
