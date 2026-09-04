import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionEvent, SessionHeaderLine, TrajectoryFidelity, TrajectoryRef } from "../domain/index.js";
import { validateTrajectoryRef } from "../domain/index.js";
import { HitchError, readJSON, sha256JSON } from "../foundation/index.js";
import { IncrementalDshInvariant } from "./dsh-contract.js";
import { parseEventLine, parseHeaderLine } from "./format.js";
import { trajectoryRefPath } from "./store.js";
import { IncrementalSurfaceFold } from "./surface-fold.js";

export interface CanonicalTrajectorySource {
  ref: TrajectoryRef;
  refPath: string;
  refSha256: `sha256:${string}`;
  runId: string;
  runDirectory: string;
  path: string;
  fidelity: Exclude<TrajectoryFidelity, "native">;
  provider?: string;
  expectedSha256?: `sha256:${string}`;
  expectedBytes?: number;
  redactions?: Array<{ rule_id: string; count: number }>;
}

export interface CanonicalTrajectoryScan {
  header: SessionHeaderLine;
  sha256: `sha256:${string}`;
  bytes: number;
  eventCount: number;
  eventTypes: Record<string, number>;
}

/** Resolve one canonical session without reading its contents into memory. */
export async function loadCanonicalTrajectorySource(
  runDirectory: string,
  runId: string,
): Promise<CanonicalTrajectorySource | null> {
  const refPath = trajectoryRefPath(runDirectory);
  let refBefore;
  try {
    refBefore = await lstat(refPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw trajectoryIntegrityError("trajectory ref cannot be inspected", error);
  }
  if (!refBefore.isFile() || refBefore.isSymbolicLink() || refBefore.nlink !== 1) {
    throw trajectoryIntegrityError("trajectory ref is not a private regular file");
  }
  let raw: unknown | null;
  let refAfter;
  try {
    raw = await readJSON<unknown | null>(refPath, null);
    if (!raw) return null;
    refAfter = await lstat(refPath);
  } catch (error) {
    throw trajectoryIntegrityError("trajectory ref cannot be read", error);
  }
  assertUnchangedFile(refBefore, refAfter, "trajectory ref changed while loading");
  const ref = validateTrajectoryRef(raw);
  const refSha256 = sha256JSON(ref);
  if (!/^run_[a-f0-9]{32}$/.test(runId) || !/^run_[a-f0-9]{32}$/.test(ref.run_id)) {
    throw trajectoryIntegrityError("run ID is invalid");
  }
  if (ref.schema_version === "1" && !/^[A-Za-z0-9._:-]{1,256}$/.test(ref.session_id)) {
    throw trajectoryIntegrityError("trajectory session ID is invalid");
  }
  if (ref.schema_version === "2" && ref.provider !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(ref.provider)) {
    throw trajectoryIntegrityError("trajectory provider ID is invalid");
  }
  if (ref.schema_version === "2" && ref.redactions?.some((entry) => !/^[a-z][a-z0-9._-]{0,127}$/.test(entry.rule_id))) {
    throw trajectoryIntegrityError("trajectory redaction rule ID is invalid");
  }
  if (ref.run_id !== runId) {
    throw trajectoryIntegrityError("trajectory ref run ID does not match the requested run");
  }
  if (ref.schema_version === "1") {
    const absolute = containedPath(runDirectory, ref.path);
    return {
      ref,
      refPath,
      refSha256,
      runId,
      runDirectory: path.resolve(runDirectory),
      path: absolute,
      fidelity: ref.fidelity === "native" ? "provider_native" : ref.fidelity,
      ...(ref.sha256 === undefined ? {} : { expectedSha256: ref.sha256 }),
    };
  }
  const canonical = ref.files.find((file) => file.role === "canonical_session");
  if (!canonical) throw trajectoryIntegrityError("trajectory ref has no canonical_session file");
  return {
    ref,
    refPath,
    refSha256,
    runId,
    runDirectory: path.resolve(runDirectory),
    path: containedPath(runDirectory, canonical.path),
    fidelity: ref.fidelity,
    ...(ref.provider === undefined ? {} : { provider: ref.provider }),
    expectedSha256: canonical.sha256,
    expectedBytes: canonical.bytes,
    ...(ref.redactions === undefined ? {} : { redactions: ref.redactions }),
  };
}

/**
 * Scan canonical JSONL once. The callback sees one validated event at a time;
 * raw events are never accumulated by this layer.
 */
export async function scanCanonicalTrajectory(
  source: CanonicalTrajectorySource,
  onEvent: (event: SessionEvent) => void,
): Promise<CanonicalTrajectoryScan> {
  if (source.expectedSha256 === undefined) {
    throw trajectoryIntegrityError("canonical trajectory is not digest-pinned by its trajectory ref");
  }
  const pathSnapshot = await inspectContainedPath(source);
  let handle;
  try {
    handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw trajectoryIntegrityError(`canonical trajectory is not a readable regular file${code ? ` (${code})` : ""}`, error);
  }
  try {
    const before = await handle.stat();
    assertSafeCanonicalFile(before);
    assertSameFile(pathSnapshot.at(-1) as PathIdentity, identityOf(before), "canonical trajectory changed while opening");
    if (source.expectedBytes !== undefined && before.size !== source.expectedBytes) {
      throw trajectoryIntegrityError(`canonical trajectory byte count changed: expected ${source.expectedBytes}, got ${before.size}`);
    }
    const hash = createHash("sha256");
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let header: SessionHeaderLine | undefined;
    let eventCount = 0;
    const eventTypes: Record<string, number> = Object.create(null) as Record<string, number>;
    const invariant = new IncrementalDshInvariant();
    const surface = new IncrementalSurfaceFold();

    const acceptLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, "");
      if (line.length === 0) return;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw trajectoryIntegrityError(`canonical trajectory contains invalid JSON at logical line ${eventCount + 2}`, error);
      }
      if (!header) {
        try {
          header = parseHeaderLine(value);
          if (!/^[A-Za-z0-9._:-]{1,256}$/.test(header.id)) throw new Error("session header id is invalid");
        } catch (error) {
          throw trajectoryIntegrityError(`canonical trajectory header is invalid: ${(error as Error).message}`, error);
        }
        return;
      }
      let event: SessionEvent;
      try {
        event = parseEventLine(value);
      } catch (error) {
        throw trajectoryIntegrityError(`canonical trajectory event ${eventCount} is invalid: ${(error as Error).message}`, error);
      }
      if (event.seq !== eventCount) {
        throw trajectoryIntegrityError(`trajectory seq must be contiguous: expected ${eventCount}, got ${event.seq}`);
      }
      try {
        invariant.accept(event, value);
        surface.accept(event);
      } catch (error) {
        throw trajectoryIntegrityError(`canonical trajectory event ${eventCount} violates the DSH contract: ${(error as Error).message}`, error);
      }
      eventCount += 1;
      eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
      onEvent(event);
    };

    for await (const rawChunk of handle.createReadStream({ autoClose: false })) {
      const chunk = rawChunk as Buffer;
      bytes += chunk.byteLength;
      hash.update(chunk);
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.end();
    if (buffer.length > 0) acceptLine(buffer);
    if (!header) throw trajectoryIntegrityError("canonical trajectory is empty");
    if (header.id !== sourceHeaderId(source)) {
      throw trajectoryIntegrityError("canonical session id does not match trajectory ref");
    }
    const sha256 = `sha256:${hash.digest("hex")}` as const;
    if (source.expectedBytes !== undefined && bytes !== source.expectedBytes) {
      throw trajectoryIntegrityError(`canonical trajectory byte count changed: expected ${source.expectedBytes}, got ${bytes}`);
    }
    if (source.expectedSha256 !== undefined && sha256 !== source.expectedSha256) {
      throw trajectoryIntegrityError(`canonical trajectory digest changed: expected ${source.expectedSha256}, got ${sha256}`);
    }
    const after = await handle.stat();
    assertSafeCanonicalFile(after);
    assertUnchangedFile(before, after);
    const finalPathSnapshot = await inspectContainedPath(source);
    assertSamePathSnapshot(pathSnapshot, finalPathSnapshot);
    assertSameFile(finalPathSnapshot.at(-1) as PathIdentity, identityOf(after), "canonical trajectory path changed during scan");
    await assertTrajectoryRefUnchanged(source);
    return { header, sha256, bytes, eventCount, eventTypes };
  } finally {
    await handle.close();
  }
}

function containedPath(runDirectory: string, declared: string): string {
  const runRoot = path.resolve(runDirectory);
  const absolute = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(runRoot, ...declared.split("/"));
  const relative = path.relative(runRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw trajectoryIntegrityError("canonical trajectory path escapes its run directory");
  }
  return absolute;
}

function sourceHeaderId(source: CanonicalTrajectorySource): string {
  return source.ref.schema_version === "1" ? source.ref.session_id : source.runId;
}

interface PathIdentity {
  dev: number | bigint;
  ino: number | bigint;
  nlink: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  directory: boolean;
}

async function inspectContainedPath(source: CanonicalTrajectorySource): Promise<PathIdentity[]> {
  const relative = path.relative(source.runDirectory, source.path);
  let current = source.runDirectory;
  const result: PathIdentity[] = [];
  try {
    const segments = ["", ...relative.split(path.sep)];
    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) current = path.join(current, segments[index] as string);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw trajectoryIntegrityError("canonical trajectory path contains a symbolic link");
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw trajectoryIntegrityError("canonical trajectory parent is not a directory");
      }
      if (index === segments.length - 1 && !info.isFile()) {
        throw trajectoryIntegrityError("canonical trajectory is not a regular file");
      }
      if (index === segments.length - 1 && info.nlink !== 1) {
        throw trajectoryIntegrityError("canonical trajectory must not be hard-linked");
      }
      result.push(identityOf(info));
    }
    return result;
  } catch (error) {
    if (error instanceof HitchError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw trajectoryIntegrityError(`canonical trajectory path cannot be inspected${code ? ` (${code})` : ""}`, error);
  }
}

function identityOf(info: Awaited<ReturnType<typeof lstat>>): PathIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    directory: info.isDirectory(),
  };
}

function assertSafeCanonicalFile(info: Awaited<ReturnType<typeof lstat>>): void {
  if (!info.isFile()) throw trajectoryIntegrityError("canonical trajectory is not a regular file");
  if (info.nlink !== 1) throw trajectoryIntegrityError("canonical trajectory must not be hard-linked");
}

function assertSamePathSnapshot(before: PathIdentity[], after: PathIdentity[]): void {
  if (before.length !== after.length) throw trajectoryIntegrityError("canonical trajectory path changed during scan");
  before.forEach((entry, index) => {
    const final = after[index] as PathIdentity;
    if (entry.dev !== final.dev || entry.ino !== final.ino || entry.directory !== final.directory) {
      throw trajectoryIntegrityError("canonical trajectory path changed during scan");
    }
    if (!entry.directory && (entry.nlink !== final.nlink || entry.size !== final.size
      || entry.mtimeMs !== final.mtimeMs || entry.ctimeMs !== final.ctimeMs)) {
      throw trajectoryIntegrityError("canonical trajectory changed during scan");
    }
  });
}

function assertSameFile(before: PathIdentity, after: PathIdentity, message: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink || before.directory !== after.directory) {
    throw trajectoryIntegrityError(message);
  }
}

function assertUnchangedFile(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
  message = "canonical trajectory changed during scan",
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw trajectoryIntegrityError(message);
  }
}

async function assertTrajectoryRefUnchanged(source: CanonicalTrajectorySource): Promise<void> {
  try {
    const before = await lstat(source.refPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw trajectoryIntegrityError("trajectory ref is not a private regular file");
    }
    const raw = await readJSON<unknown | null>(source.refPath, null);
    const after = await lstat(source.refPath);
    assertUnchangedFile(before, after, "trajectory ref changed during scan");
    if (!raw || sha256JSON(validateTrajectoryRef(raw)) !== source.refSha256) {
      throw trajectoryIntegrityError("trajectory ref changed during scan");
    }
  } catch (error) {
    if (error instanceof HitchError) throw error;
    throw trajectoryIntegrityError("trajectory ref cannot be revalidated", error);
  }
}

function trajectoryIntegrityError(message: string, cause?: unknown): HitchError {
  return new HitchError(message, { code: "trajectory_integrity_mismatch", exitCode: 3, ...(cause === undefined ? {} : { cause }) });
}
