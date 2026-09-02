import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { RemoteWorkArtifactRefV1, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, ensureDir, readJSON, statePaths, withFileLock } from "../foundation/index.js";

const WORKER_ID = /^worker_[a-z0-9][a-z0-9_-]{0,62}$/;
const LEASE_ID = /^lease_[a-f0-9]{32}$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface RemoteWorkerArtifactRecordV1 {
  schema_version: "1";
  worker_id: string;
  lease_id: string;
  epoch: number;
  digest: Sha256;
  size: number;
  completed_at: string;
}

export class RemoteWorkerArtifactStore {
  private readonly directory: string;
  private readonly locks: string;
  private readonly maxArtifactBytes: number;

  constructor(input: { root: string; maxArtifactBytes?: number }) {
    const maximum = input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!input.root || !Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError("remote worker artifact store configuration is invalid");
    const paths = statePaths(input.root);
    this.directory = paths.workerStaging;
    this.locks = paths.workerProtocolLocks;
    this.maxArtifactBytes = maximum;
  }

  async initialize(): Promise<void> {
    await Promise.all([ensureDir(this.directory), ensureDir(this.locks)]);
  }

  async upload(input: {
    workerId: string;
    leaseId: string;
    epoch: number;
    digest: string;
    expectedSize: number;
    body: AsyncIterable<Uint8Array>;
  }): Promise<RemoteWorkerArtifactRecordV1> {
    const identity = validateIdentity(input);
    if (identity.expectedSize > this.maxArtifactBytes) throw artifactError("remote worker artifact exceeds the configured size limit");
    return withFileLock(this.locks, `artifact-${identity.leaseId}-${identity.hex}`, async () => {
      const existing = await this.read(identity.workerId, identity.leaseId, identity.digest);
      if (existing) {
        if (existing.epoch !== identity.epoch || existing.size !== identity.expectedSize) throw conflict("remote worker artifact identity is already bound to different evidence");
        await this.verify(identity.workerId, identity.leaseId, { kind: "diagnostic", digest: identity.digest, size: identity.expectedSize }, identity.epoch);
        return existing;
      }
      const target = this.blobPath(identity.workerId, identity.leaseId, identity.hex);
      await ensureDir(path.dirname(target));
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const value of input.body) {
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (size > identity.expectedSize || size > this.maxArtifactBytes) throw artifactError("remote worker artifact body exceeds its declared size");
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
      }
      await handle.close();
      const actual = `sha256:${hash.digest("hex")}` as Sha256;
      if (size !== identity.expectedSize || actual !== identity.digest) {
        await rm(temporary, { force: true });
        throw artifactError("remote worker artifact size or digest does not match its declaration");
      }
      try {
        await rename(temporary, target);
        const record: RemoteWorkerArtifactRecordV1 = {
          schema_version: "1", worker_id: identity.workerId, lease_id: identity.leaseId,
          epoch: identity.epoch, digest: identity.digest, size, completed_at: new Date().toISOString(),
        };
        await atomicWriteJSON(this.recordPath(identity.workerId, identity.leaseId, identity.hex), record);
        return record;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }, { timeoutCode: "worker_artifact_locked", timeoutExitCode: 12 });
  }

  async verify(workerId: string, leaseId: string, ref: RemoteWorkArtifactRefV1, epoch: number): Promise<RemoteWorkerArtifactRecordV1> {
    const identity = validateIdentity({ workerId, leaseId, digest: ref.digest, epoch, expectedSize: ref.size });
    const record = await this.read(workerId, leaseId, identity.digest);
    if (!record || record.epoch !== epoch || record.size !== ref.size) throw artifactMissing("remote worker terminal receipt references an artifact that was not staged for this lease");
    const file = this.blobPath(workerId, leaseId, identity.hex);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== ref.size) throw artifactMissing("remote worker staged artifact is not an owned regular file");
    const content = await readFile(file);
    if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== ref.digest) throw artifactMissing("remote worker staged artifact failed digest verification");
    return record;
  }

  pathFor(workerId: string, leaseId: string, digest: Sha256): string {
    const identity = validateIdentity({ workerId, leaseId, digest, epoch: 1, expectedSize: 0 });
    return this.blobPath(workerId, leaseId, identity.hex);
  }

  private async read(workerId: string, leaseId: string, digest: Sha256): Promise<RemoteWorkerArtifactRecordV1 | null> {
    const match = digest.match(DIGEST);
    if (!match) throw artifactError("remote worker artifact digest is invalid");
    const value = await readJSON<unknown | null>(this.recordPath(workerId, leaseId, match[1] as string), null);
    return value === null ? null : parseRecord(value);
  }

  private blobPath(workerId: string, leaseId: string, hex: string): string {
    return path.join(this.directory, workerId, leaseId, "sha256", `${hex}.blob`);
  }

  private recordPath(workerId: string, leaseId: string, hex: string): string {
    return path.join(this.directory, workerId, leaseId, "sha256", `${hex}.json`);
  }
}

function validateIdentity(input: { workerId: string; leaseId: string; digest: string; epoch: number; expectedSize: number }) {
  const match = input.digest.match(DIGEST);
  if (!WORKER_ID.test(input.workerId) || !LEASE_ID.test(input.leaseId) || !match
    || !Number.isSafeInteger(input.epoch) || input.epoch < 1
    || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0) throw artifactError("remote worker artifact identity is invalid");
  return { ...input, digest: input.digest as Sha256, hex: match[1] as string };
}

function parseRecord(value: unknown): RemoteWorkerArtifactRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw artifactError("remote worker artifact record is invalid");
  const record = value as Record<string, unknown>;
  const keys = ["schema_version", "worker_id", "lease_id", "epoch", "digest", "size", "completed_at"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || record.schema_version !== "1"
    || typeof record.completed_at !== "string" || !Number.isFinite(Date.parse(record.completed_at))) throw artifactError("remote worker artifact record is invalid");
  validateIdentity({ workerId: String(record.worker_id), leaseId: String(record.lease_id), digest: String(record.digest), epoch: Number(record.epoch), expectedSize: Number(record.size) });
  return record as unknown as RemoteWorkerArtifactRecordV1;
}

function artifactError(message: string): HitchError { return new HitchError(message, { code: "worker_artifact_invalid", exitCode: 2 }); }
function artifactMissing(message: string): HitchError { return new HitchError(message, { code: "worker_artifact_missing", exitCode: 10 }); }
function conflict(message: string): HitchError { return new HitchError(message, { code: "worker_artifact_conflict", exitCode: 12 }); }
