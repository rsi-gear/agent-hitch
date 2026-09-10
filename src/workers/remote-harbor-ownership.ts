import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import type { RemoteWorkOfferV1, RemoteWorkerExecutionOwnership, RemoteWorkerExecutionAdmissionV2, RemoteWorkerCleanupObservation, RemoteWorkerHostIdentityV1 } from "../domain/index.js";
import { parseRemoteExecutionAdmission, parseRemoteExecutionOwnership, remoteExecutionBindingDigest } from "../control-plane/index.js";
import { atomicWriteJSON, captureProcessIdentity, delay, ensureDir, HitchError, hitchRootId, inspectProcessIdentity,
  readJSON, runCommand, sha256JSON, statePaths, validateProcessIdentity, withFileLock } from "../foundation/index.js";
import type { ProcessIdentityV1 } from "../foundation/index.js";
import { DOCKER_OWNERSHIP_LABELS, parseExecutionLease, parseRemoteWorkerHostIdentity, reapOwnedDockerResources, releaseExecutionLease } from "../evals/index.js";
import { observeRemoteWorkerHost } from "./remote-worker-host.js";

export interface RemoteHarborOwnershipOptions { root: string; env?: NodeJS.ProcessEnv; dockerExecutable?: string }
interface ExecutionOwner {
  schema_version: "1" | "2";
  binding_digest: string;
  root: string;
  root_id: string;
  boot_digest: string;
  docker_engine_id: string;
  owner: ProcessIdentityV1;
  phase: "prepared" | "executing" | "settled" | "cleaning" | "released";
  process?: ProcessIdentityV1;
  host_identity?: RemoteWorkerHostIdentityV1;
}

/** Written before HTTP acceptance. No backend may start without this record. */
export async function prepareRemoteHarborOffer(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1): Promise<RemoteWorkerExecutionOwnership> {
  return locked(options, offer, async file => {
    const old = await readOwner(file, offer, false);
    if (old) {
      await assertEnvironment(options, old);
      await assertOwner(old);
      if (old.phase !== "prepared") throw ambiguous("remote work has already started; it cannot execute twice");
      return publicOwnership(old, offer);
    }
    const owner = await captureProcessIdentity(process.pid);
    if (!owner) throw ambiguous("worker process identity is unavailable");
    const root = await realpath(await ensureDir(options.root));
    const host = await observeRemoteWorkerHost();
    const record: ExecutionOwner = { schema_version: "2", binding_digest: binding(offer), root, root_id: hitchRootId(options.root),
      host_identity: host, boot_digest: sha256JSON(host), docker_engine_id: await engineId(options), owner, phase: "prepared" };
    // Lease and journal precede acceptance; a missing journal is never a release proof.
    const now = new Date().toISOString();
    await atomicWriteJSON(leaseFile(options, offer), { ...offer.lease, state: "running",
      accepted_at: offer.lease.accepted_at ?? now, heartbeat_at: now, resource_epochs: offer.lease.resource_epochs ?? [offer.lease.epoch] });
    await atomicWriteJSON(file, record);
    return publicOwnership(record, offer);
  });
}

export async function beginRemoteHarborOffer(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1): Promise<void> {
  await mutateOwned(options, offer, record => {
    if (record.phase !== "prepared") throw ambiguous("remote work has already started; it cannot execute twice");
    return { ...record, phase: "executing" };
  });
}

export async function settleRemoteHarborOffer(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1): Promise<void> {
  await mutateOwned(options, offer, record => {
    if (record.phase !== "executing") throw ambiguous("remote work settlement has no active execution");
    return { ...record, phase: "settled" };
  });
}

export function remoteHarborProcessHooks(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1, authorize?: (identity: ProcessIdentityV1) => Promise<void>) {
  return {
    recoverableProcess: true,
    onProcessStarted: async (pid: number) => {
      // The supervisor waits for this durable write before launching Harbor.
      const identity = await captureProcessIdentity(pid);
      if (!identity) throw ambiguous("Harbor supervisor process identity is unavailable");
      await mutateOwned(options, offer, record => {
        if (record.phase !== "executing" || record.process) throw ambiguous("remote work already has a Harbor supervisor");
        return { ...record, process: identity };
      });
      await authorize?.(identity);
    },
  };
}

/** Cleanup only, including after SIGKILL. Never adopts or repeats candidate execution. */
export async function cleanRemoteHarborOffer(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1): Promise<void> {
  await cleanOwnedExecution(options, offer);
}

export async function cleanPreviousRemoteHarborGeneration(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1,
  admission: RemoteWorkerExecutionAdmissionV2): Promise<RemoteWorkerCleanupObservation> {
  return (await cleanOwnedExecution(options, offer, parseRemoteExecutionAdmission(admission, offer)))!;
}

async function cleanOwnedExecution(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1,
  admission?: RemoteWorkerExecutionAdmissionV2): Promise<RemoteWorkerCleanupObservation | undefined> {
  return locked(options, offer, async file => {
    let record = (await readOwner(file, offer))!;
    const host = await assertEnvironment(options, record, true);
    const reboot = host !== undefined && host.boot_id !== record.host_identity!.boot_id;
    if (admission) {
      if (sha256JSON(publicOwnership(record, offer)) !== admission.ownership_digest) throw ambiguous("local ownership differs from the authenticated original execution");
      if (sha256JSON(record.process ?? null) !== sha256JSON(admission.execution_process)) {
        // An unacknowledged supervisor may exist before authorization. It has
        // no authority to execute, and its unproven PID must never be signalled.
        if (admission.execution_process || !record.process || !reboot && (!["terminal", "identity-mismatch"].includes(await inspectProcessIdentity(record.process))
          || (await processGroup(record.process.pid)).length)) throw ambiguous("local supervisor differs from its authenticated launch");
      }
    }
    if (record.phase === "released" && !admission && !reboot) return;
    const owner = reboot ? "previous-boot" : await inspectProcessIdentity(record.owner);
    if (owner === "unavailable" || owner === "running" && (admission || !(record.owner.pid === process.pid && ["prepared", "settled", "cleaning"].includes(record.phase)))) {
      throw ambiguous("original worker is still running or cannot be identified");
    }
    record = { ...record, phase: "cleaning" };
    await atomicWriteJSON(file, record);
    if (!reboot && record.process && (!admission || admission.execution_process)) await stopOwnedProcessGroup(record.process);
    const lease = parseExecutionLease(await readJSON(leaseFile(options, offer)));
    if (leaseIdentity(lease) !== leaseIdentity(offer.lease)) throw ambiguous("local lease ownership differs from the original offer");
    await releaseExecutionLease({ evalDirectory: path.join(statePaths(options.root).evals, offer.lease.eval_id),
      leaseId: offer.lease.lease_id, expectedEpoch: offer.lease.epoch });
    const report = await reapOwnedDockerResources({ ...options, leaseIds: [offer.lease.lease_id] });
    if (report.issues.length || report.retained.some(item => item.reason !== "lease_not_selected")) throw ambiguous("remote Harbor Docker cleanup is incomplete");
    // Successful rm alone is insufficient. Observe all three resource classes again.
    for (const kind of ["container", "network", "volume"]) {
      const args = [kind, "ls", ...(kind === "container" ? ["--all"] : []),
        "--filter", `label=${DOCKER_OWNERSHIP_LABELS.rootId}=${hitchRootId(options.root)}`,
        "--filter", `label=${DOCKER_OWNERSHIP_LABELS.leaseId}=${offer.lease.lease_id}`,
        "--format", kind === "volume" ? "{{.Name}}" : "{{.ID}}"];
      if ((await docker(options, args)).stdout.trim()) throw ambiguous("owned Docker resources remain after cleanup");
    }
    const finalHost = await assertEnvironment(options, record, true);
    if (sha256JSON(finalHost ?? null) !== sha256JSON(host ?? null)) throw ambiguous("worker host or boot changed during cleanup");
    if (!reboot && record.process && (await processGroup(record.process.pid)).length) throw ambiguous("Harbor process group is still active");
    await atomicWriteJSON(file, { ...record, phase: "released" });
    if (admission) {
      const ownership = publicOwnership(record, offer);
      if (reboot) {
        if (ownership.schema_version !== "3" || !host) throw ambiguous("original host identity is unavailable");
        return { ownership, execution_process: admission.execution_process, host_identity: host, worker_status: "previous-boot", docker_resources_empty: true };
      }
      const workerStatus = await inspectProcessIdentity(record.owner);
      if (workerStatus !== "terminal" && workerStatus !== "identity-mismatch") throw ambiguous("original worker is still active or unobservable");
      return { ownership, execution_process: admission.execution_process,
        worker_status: workerStatus, process_group_empty: true, docker_resources_empty: true };
    }
  });
}

async function stopOwnedProcessGroup(identity: ProcessIdentityV1): Promise<void> {
  const status = await inspectProcessIdentity(identity);
  if (status === "unavailable") throw ambiguous("Harbor process identity is unavailable");
  if (status === "running") {
    const members = await processGroup(identity.pid);
    if (!members.includes(identity.pid)) throw ambiguous("Harbor supervisor no longer owns its process group");
    // Re-read identity immediately before signalling; a recycled PID grants no authority.
    if (await inspectProcessIdentity(identity) !== "running") throw ambiguous("Harbor supervisor changed during cleanup");
    try { process.kill(-identity.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  // If the leader exited, do not signal an unproven group or guess descendant PIDs.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await processGroup(identity.pid)).length) return;
    await delay(50);
  }
  throw ambiguous("Harbor process group has not stopped; resources remain reserved");
}

async function processGroup(group: number): Promise<number[]> {
  const output = await runCommand("/bin/ps", ["-axo", "pid=,pgid=,stat="], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 5_000 });
  if (!output.stdout.trim()) throw ambiguous("process group observation is empty");
  return output.stdout.trim().split(/\r?\n/).filter(Boolean).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) throw ambiguous("process group observation is invalid");
    return Number(fields[1]) === group && !/^[ZX]/.test(fields[2]!) ? [Number(fields[0])] : [];
  });
}

async function bootDigest(): Promise<string> {
  let boot: string;
  if (process.platform === "linux") boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  else if (process.platform === "darwin") boot = (await runCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 5_000 })).stdout.trim();
  else throw ambiguous("worker recovery requires an observable POSIX host boot identity");
  if (!boot) throw ambiguous("host boot identity is unavailable");
  return sha256JSON({ host: hostname(), platform: process.platform, boot });
}

async function assertEnvironment(options: RemoteHarborOwnershipOptions, record: ExecutionOwner, allowReboot = false): Promise<RemoteWorkerHostIdentityV1 | undefined> {
  if (record.root !== await realpath(options.root) || record.root_id !== hitchRootId(options.root)
    || record.docker_engine_id !== await engineId(options)) throw ambiguous("worker root, host boot or Docker engine differs from the execution owner");
  if (record.schema_version === "1") {
    if (record.boot_digest !== await bootDigest()) throw ambiguous("legacy ownership cannot identify its host across a boot change");
    return;
  }
  const host = await observeRemoteWorkerHost(), original = record.host_identity!;
  if (host.platform !== original.platform || host.host_id !== original.host_id || !allowReboot && host.boot_id !== original.boot_id) {
    throw ambiguous("worker root, host boot or Docker engine differs from the execution owner");
  }
  return host;
}
async function engineId(options: RemoteHarborOwnershipOptions): Promise<string> {
  const info = JSON.parse((await docker(options, ["info", "--format", "{{json .}}"])).stdout) as { ID?: unknown };
  if (typeof info.ID !== "string" || !info.ID || info.ID.length > 256 || /[\s\x00-\x1f]/.test(info.ID)) throw ambiguous("Docker engine identity is unavailable");
  return info.ID;
}
function docker(options: RemoteHarborOwnershipOptions, args: string[]) {
  const env = options.env ?? process.env;
  return runCommand(options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker", args, { env, timeoutMs: 10_000 });
}
async function assertOwner(record: ExecutionOwner): Promise<void> {
  if (record.owner.pid !== process.pid || await inspectProcessIdentity(record.owner) !== "running") throw ambiguous("execution belongs to a different worker process");
}
async function mutateOwned(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1, mutate: (record: ExecutionOwner) => ExecutionOwner): Promise<void> {
  await locked(options, offer, async file => {
    const record = (await readOwner(file, offer))!;
    await assertEnvironment(options, record);
    await assertOwner(record);
    await atomicWriteJSON(file, mutate(record));
  });
}
function locked<T>(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1, action: (file: string) => Promise<T>): Promise<T> {
  const directory = path.join(statePaths(options.root).evals, offer.lease.eval_id, "remote-work", offer.work.work_id,
    `epoch-${String(offer.lease.epoch).padStart(6, "0")}`);
  return withFileLock(path.join(directory, ".locks"), "execution-owner", () => action(path.join(directory, "worker-execution.json")));
}
function leaseFile(options: RemoteHarborOwnershipOptions, offer: RemoteWorkOfferV1): string {
  return path.join(statePaths(options.root).evals, offer.lease.eval_id, "leases", `${offer.lease.lease_id}.json`);
}
function leaseIdentity(lease: RemoteWorkOfferV1["lease"]): string {
  const { lease_id, eval_id, work_id, worker_id, provider, collision_domain_id, epoch, reservation } = lease;
  return sha256JSON({ lease_id, eval_id, work_id, worker_id, provider, collision_domain_id, epoch, reservation, resource_epochs: lease.resource_epochs ?? [epoch] });
}
function binding(offer: RemoteWorkOfferV1): string {
  return remoteExecutionBindingDigest(offer);
}
function publicOwnership(record: ExecutionOwner, offer: RemoteWorkOfferV1): RemoteWorkerExecutionOwnership {
  return parseRemoteExecutionOwnership({ schema_version: record.schema_version === "2" ? "3" : "2", binding_digest: record.binding_digest, root_id: record.root_id,
    root_digest: sha256JSON({ root: record.root, root_id: record.root_id }), boot_digest: record.boot_digest,
    ...(record.schema_version === "2" ? { host_identity: record.host_identity } : {}),
    docker_engine_id: record.docker_engine_id, worker_process: record.owner }, offer);
}
async function readOwner(file: string, offer: RemoteWorkOfferV1, required = true): Promise<ExecutionOwner | null> {
  const record = await readJSON<ExecutionOwner | null>(file, null);
  if (!record) { if (required) throw ambiguous("worker execution ownership record is missing; cleanup cannot be acknowledged"); return null; }
  if (record.schema_version !== "1" && record.schema_version !== "2" || record.binding_digest !== binding(offer)
    || Object.keys(record).some(key => !["schema_version", "binding_digest", "root", "root_id", "boot_digest", "docker_engine_id", "owner", "phase", "process", ...(record.schema_version === "2" ? ["host_identity"] : [])].includes(key))
    || !/^[a-f0-9]{24}$/.test(record.root_id)
    || !path.isAbsolute(record.root) || !/^sha256:[a-f0-9]{64}$/.test(record.boot_digest)
    || typeof record.docker_engine_id !== "string" || !record.docker_engine_id
    || !["prepared", "executing", "settled", "cleaning", "released"].includes(record.phase)) throw ambiguous("worker execution ownership record differs from its offer");
  validateProcessIdentity(record.owner);
  if (record.process) validateProcessIdentity(record.process);
  if (record.schema_version === "2" && sha256JSON(parseRemoteWorkerHostIdentity(record.host_identity)) !== record.boot_digest) {
    throw ambiguous("worker host identity differs from the original execution record");
  }
  return record;
}
function ambiguous(message: string): HitchError { return new HitchError(message, { code: "remote_worker_cleanup_ambiguous", exitCode: 12 }); }
