import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateEvalRunParent, validateRunContext, validateTrajectoryRef } from "../domain/index.js";
import type { ResultBundleIndexV1 } from "../domain/index.js";
import { readJSON, sha256JSON } from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";
import { loadRunRecord } from "./records.js";

interface PhaseBundleIdentity {
  run_id: string;
  context: unknown;
  parent: unknown;
  revision_identity: string | null;
}

/** Host inspection after retirement; the original bundle remains immutable. */
export async function inspectSealedPhaseRunBundle(input: { sourceDirectory: string; expected: PhaseBundleIdentity }) {
  const context = validateRunContext(input.expected.context);
  const parent = validateEvalRunParent(input.expected.parent);
  if (context.kind !== "benchmark_phase" || !/^run_[a-f0-9]{32}$/.test(input.expected.run_id)
    || (input.expected.revision_identity !== null && !/^sha256:[a-f0-9]{64}$/.test(input.expected.revision_identity))) {
    throw new TypeError("sealed phase inspection requires its prepared identity");
  }
  if (!(await lstat(input.sourceDirectory)).isDirectory()) throw new TypeError("phase source must be a real directory");
  const directory = await realpath(input.sourceDirectory);
  const index = await verifyResultBundleIndex(directory);
  const loaded = await loadRunRecord(directory, { verifyTrajectory: true });
  const request = await readJSON<Record<string, unknown>>(path.join(directory, "request.json"));
  const result = await readJSON<Record<string, unknown>>(path.join(directory, "result.json"));
  const record = loaded.record;
  if (index.run_id !== input.expected.run_id || record.run_id !== input.expected.run_id || result.run_id !== input.expected.run_id
    || loaded.record_status !== "valid" || loaded.trajectory_status !== "valid"
    || !isDeepStrictEqual(record.context, context) || !isDeepStrictEqual(request.context, context)
    || !isDeepStrictEqual(record.parent, parent) || !isDeepStrictEqual(request.parent, parent)
    || record.harness.revision_identity !== input.expected.revision_identity || record.observation !== undefined
    || !["succeeded", "failed", "timed_out", "cancelled"].includes(record.status)) {
    throw new TypeError("sealed phase bundle does not match its prepared identity");
  }
  const trajectory = validateTrajectoryRef(await readJSON(path.join(directory, record.trajectory_ref!)));
  const started = Date.parse(String(result.started_at)), completed = Date.parse(String(result.completed_at));
  if (!trajectory.provider_session_id || !Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new TypeError("sealed phase has no native session or execution interval");
  }
  return { run_id: record.run_id, process_status: record.status, bundle_digest: index.bundle_digest,
    bundle_index_digest: sha256JSON(index), provider_session_id: trajectory.provider_session_id,
    harness: record.harness, model: record.model, started_at: result.started_at, completed_at: result.completed_at };
}

/** Copy an already sealed phase verbatim. Never grade, repair, reseal or overwrite. */
export async function copySealedPhaseRunBundle(input: {
  sourceDirectory: string;
  destinationDirectory: string;
  expected: PhaseBundleIdentity;
}): Promise<ResultBundleIndexV1> {
  const context = validateRunContext(input.expected.context);
  const parent = validateEvalRunParent(input.expected.parent);
  if (context.kind !== "benchmark_phase" || !/^run_[a-f0-9]{32}$/.test(input.expected.run_id)) {
    throw new TypeError("sealed phase export requires an assigned phase identity");
  }
  if (!(await lstat(input.sourceDirectory)).isDirectory()) throw new TypeError("phase source must be a real directory");
  const source = await realpath(input.sourceDirectory);
  const requestedDestination = path.resolve(input.destinationDirectory);
  const destination = path.join(await realpath(path.dirname(requestedDestination)), path.basename(requestedDestination));
  if (source === destination || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) {
    throw new TypeError("phase source and destination must be disjoint");
  }
  const originalBytes = await readFile(path.join(source, "bundle.index.json"));
  const original = await verifyResultBundleIndex(source);
  await inspectSealedPhaseRunBundle({ sourceDirectory: source, expected: input.expected });
  const manifest = await readJSON<Record<string, unknown>>(path.join(source, "manifest.json"));
  const request = await readJSON<Record<string, unknown>>(path.join(source, "request.json"));
  const result = await readJSON<Record<string, unknown>>(path.join(source, "result.json"));
  if (original.run_id !== input.expected.run_id || result.run_id !== input.expected.run_id
    || !isDeepStrictEqual(manifest.context, context) || !isDeepStrictEqual(request.context, context)
    || !isDeepStrictEqual(manifest.parent, parent) || !isDeepStrictEqual(request.parent, parent)
    || manifest.observation !== undefined) {
    throw new TypeError("sealed phase bundle does not match its prepared identity");
  }
  // mkdir without recursive is the no-overwrite gate. Failed copies remain for
  // diagnosis; the caller must never publish them as a completed phase export.
  await mkdir(destination, { mode: 0o700 });
  for (const relative of [...original.files.map(file => file.path), "bundle.index.json"]) {
    const target = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, ...relative.split("/")), target, constants.COPYFILE_EXCL);
  }
  const copied = await verifyResultBundleIndex(destination);
  const sourceAfter = await verifyResultBundleIndex(source);
  if (!isDeepStrictEqual(copied, original) || !isDeepStrictEqual(sourceAfter, original)
    || !originalBytes.equals(await readFile(path.join(destination, "bundle.index.json")))
    || !originalBytes.equals(await readFile(path.join(source, "bundle.index.json")))) {
    throw new TypeError("sealed phase bundle changed during transfer");
  }
  return copied;
}
