import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutionLeaseV1 } from "../domain/index.js";
import { atomicWriteJSON, hitchRootId, readJSON, runCommand, sha256Bytes, sha256JSON } from "../foundation/index.js";
import { DOCKER_OWNERSHIP_LABELS as LABEL } from "./docker-ownership.js";
import { parseLocalProviderExecutionRecord } from "./local-docker-provider.js";

interface PhaseDockerBinding {
  lease: ExecutionLeaseV1;
  digest: string;
  backendId: string;
  confirmed: boolean;
}

interface PhaseDockerExecution {
  schema_version: "1";
  root_id: string;
  eval_id: string;
  work_id: string;
  lease_id: string;
  lease_epoch: number;
  state: "not-started" | "bound";
  docker_backend_id?: string;
}

/** This marker is durable before any backend launch. A failed preparation can
 * release safely; absence of both this marker and runtime receipts is unknown. */
export async function preparePhaseDockerExecution(input: { root: string; lease: ExecutionLeaseV1 }): Promise<void> {
  const existing = await readControllerBinding(input.root, input.lease);
  if (existing) return; // Never reset a prior bound epoch to not-started.
  await atomicWriteJSON(controllerBindingPath(input.root, input.lease), {
    schema_version: "1", root_id: hitchRootId(input.root), eval_id: input.lease.eval_id,
    work_id: input.lease.work_id, lease_id: input.lease.lease_id, lease_epoch: input.lease.epoch, state: "not-started",
  } satisfies PhaseDockerExecution);
}

/** Called by the backend immediately before spawning Harbor. Its returned env
 * pins the Docker selector for the entire backend process and all children. */
export async function bindPhaseDockerBackend(input: { root: string; lease: ExecutionLeaseV1; env: NodeJS.ProcessEnv }): Promise<NodeJS.ProcessEnv> {
  const binding = await readControllerBinding(input.root, input.lease);
  if (!binding) throw new TypeError("phase execution was not prepared before backend launch");
  const env = await pinPhaseDockerEnvironment(input.env);
  const backendId = await dockerBackendId(env);
  if (binding.state === "bound" && binding.docker_backend_id !== backendId) throw new TypeError("phase execution Docker backend changed");
  await atomicWriteJSON(controllerBindingPath(input.root, input.lease), { ...binding, state: "bound", docker_backend_id: backendId });
  return env;
}

export async function pinPhaseDockerEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.DOCKER_HOST || env.DOCKER_CONTEXT) return { ...env };
  const result = await runCommand(env.HITCH_DOCKER_PATH || "docker", ["context", "show"],
    { env, timeoutMs: 10_000, failureCode: "phase_docker_context_unavailable" });
  const context = result.stdout.trim();
  if (!context || context.length > 256 || /[\s\0]/.test(context)) throw new TypeError("phase Docker context identity is unavailable");
  return { ...env, DOCKER_CONTEXT: context };
}

export async function phaseCleanupEnvironment(bindings: readonly PhaseDockerBinding[], env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  return bindings.some(binding => !binding.confirmed) ? pinPhaseDockerEnvironment(env) : { ...env };
}

/** Read only the two receipt files in immediate trial directories. Never walk
 * artifact trees, whose contents and size belong to the evaluated task. */
export async function readPhaseDockerBindings(input: {
  root: string; leases: readonly ExecutionLeaseV1[]; trialParents: readonly string[]; useCleanupFences?: boolean;
}): Promise<PhaseDockerBinding[]> {
  const leases = new Map(input.leases.map(lease => [lease.lease_id, lease]));
  const receipts = new Map<string, Array<{ path: string; digest: string; backendId: string | null }>>();
  for (const parent of [...new Set(input.trialParents)].sort()) {
    for (const trial of await directories(parent)) for (const role of ["agent", "verifier"]) {
      const file = path.join(parent, trial, `hitch-phase-resources-${role}.json`);
      const stat = await statOrMissing(file);
      if (!stat) continue;
      if (!stat.isFile() || stat.size > 8 * 1024 ** 2) throw new TypeError("phase receipt is not a bounded regular file");
      const content = await readFile(file);
      const receipt = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
      const labels = receipt.ownership as Record<string, unknown> | undefined;
      if (receipt.schema_version !== "1" || receipt.role !== role || !labels || typeof labels !== "object") throw new TypeError("phase receipt identity is invalid");
      const lease = leases.get(String(labels[LABEL.leaseId]));
      if (!lease) throw new TypeError("phase receipt refers to an unknown cleanup lease");
      if (labels[LABEL.rootId] !== hitchRootId(input.root) || labels[LABEL.provider] !== "local-docker"
        || labels[LABEL.evalId] !== lease.eval_id || labels[LABEL.workId] !== lease.work_id
        || !(lease.resource_epochs ?? [lease.epoch]).some(epoch => labels[LABEL.leaseEpoch] === String(epoch))) {
        throw new TypeError("phase receipt ownership does not match its lease");
      }
      const backendId = receipt.docker_backend_id;
      if (backendId === null) {
        // A failure before the first backend binding cannot have created a container.
        if (!Array.isArray(receipt.containers) || receipt.containers.length) throw new TypeError("unbound phase receipt contains resources");
      } else if (!validBackendId(backendId)) throw new TypeError("phase receipt Docker backend identity is invalid");
      const values = receipts.get(lease.lease_id) ?? [];
      values.push({ path: path.relative(input.root, file), digest: sha256Bytes(content), backendId });
      receipts.set(lease.lease_id, values);
    }
  }
  const bindings: PhaseDockerBinding[] = [];
  for (const [leaseId, lease] of leases) {
    const values = receipts.get(leaseId) ?? [];
    const controller = await readControllerBinding(input.root, lease);
    if (!controller && !values.length) throw new TypeError("phase execution Docker binding is missing");
    const ids = [...new Set([...values.flatMap(value => value.backendId === null ? [] : [value.backendId]),
      ...(controller?.state === "bound" ? [controller.docker_backend_id!] : [])])];
    if (controller?.state === "not-started" && (ids.length || await readJSON<unknown>(
      path.join(input.root, "evals", lease.eval_id, "provider", "leases", `${leaseId}.json`), null))) {
      throw new TypeError("phase backend started without a durable Docker binding");
    }
    if (!ids.length) continue;
    if (ids.length !== 1) throw new TypeError("phase lease used more than one Docker backend");
    const digest = sha256JSON({ lease_id: leaseId, eval_id: lease.eval_id, work_id: lease.work_id,
      resource_epochs: lease.resource_epochs ?? [lease.epoch], receipts: values.sort((a, b) => a.path.localeCompare(b.path)),
      ...(controller ? { controller_binding: controller } : {}) });
    const fence = input.useCleanupFences && lease.state === "released"
      ? await readJSON<Record<string, unknown> | null>(cleanupFencePath(input.root, lease), null) : null;
    bindings.push({ lease, digest, backendId: ids[0]!, confirmed: Boolean(fence && fence.schema_version === "1"
      && fence.lease_id === leaseId && fence.binding_digest === digest && fence.docker_backend_id === ids[0]) });
  }
  return bindings;
}

/** An empty listing on a different daemon is not evidence of cleanup. */
export async function confirmPhaseDockerBackend(bindings: readonly PhaseDockerBinding[], env: NodeJS.ProcessEnv): Promise<void> {
  const expected = [...new Set(bindings.filter(binding => !binding.confirmed).map(binding => binding.backendId))];
  if (!expected.length) return;
  if (expected.length !== 1) throw new TypeError("unconfirmed phase resources belong to multiple Docker backends");
  if (await dockerBackendId(env) !== expected[0]) throw new TypeError("phase cleanup Docker backend changed");
}

export async function recordPhaseDockerCleanup(root: string, bindings: readonly PhaseDockerBinding[]): Promise<void> {
  for (const binding of bindings) {
    if (binding.lease.state !== "released") throw new TypeError("phase cleanup requires a released lease");
    if (!binding.confirmed) await atomicWriteJSON(cleanupFencePath(root, binding.lease), {
      schema_version: "1", lease_id: binding.lease.lease_id, binding_digest: binding.digest,
      docker_backend_id: binding.backendId, completed_at: new Date().toISOString(),
    });
  }
}

/** Startup has no in-memory backend path. Recover fixed backend directories
 * from provider records, plus native work/retry/rerun and assessment layouts. */
export async function phaseReceiptTrialParents(root: string, evalId: string, leases: readonly ExecutionLeaseV1[]): Promise<string[]> {
  const evalDirectory = path.join(root, "evals", evalId);
  const parents = new Set<string>();
  for (const lease of leases) {
    const value = await readJSON<unknown>(path.join(evalDirectory, "provider", "leases", `${lease.lease_id}.json`), null);
    if (value === null) continue;
    const record = parseLocalProviderExecutionRecord(value);
    if (record.eval_id !== evalId || record.lease_id !== lease.lease_id || record.work_id !== lease.work_id
      || !(lease.resource_epochs ?? [lease.epoch]).includes(record.lease_epoch)) throw new TypeError("phase provider receipt path ownership changed");
    parents.add(path.join(evalDirectory, record.backend_directory, "job"));
  }
  await workParents(path.join(evalDirectory, "harbor", "work-items"), parents);
  const reruns = path.join(evalDirectory, "reruns");
  for (const rerun of await directories(reruns, /^rerun_[a-f0-9]{32}$/)) {
    await workParents(path.join(reruns, rerun, "harbor", "work-items"), parents);
  }
  const assessments = path.join(evalDirectory, "assessments");
  for (const assessment of await directories(assessments, /^assessment_[a-f0-9]{32}$/)) {
    parents.add(path.join(assessments, assessment, "evidence", "trials"));
  }
  return [...parents];
}

async function workParents(directory: string, parents: Set<string>): Promise<void> {
  for (const work of await directories(directory, /^work_[a-f0-9]{32}$/)) {
    const workDirectory = path.join(directory, work);
    for (const epoch of await directories(workDirectory, /^epoch-[0-9]{6}$/)) parents.add(path.join(workDirectory, epoch, "job"));
    const retries = path.join(workDirectory, "infrastructure-retries");
    for (const retry of await directories(retries, /^retry-[0-9]{4}$/)) {
      const retryDirectory = path.join(retries, retry);
      for (const backend of await directories(retryDirectory, /^(?:harbor|attempt-[0-9]{4})$/)) parents.add(path.join(retryDirectory, backend, "job"));
    }
  }
}

async function directories(directory: string, pattern?: RegExp): Promise<string[]> {
  const stat = await statOrMissing(directory);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new TypeError("phase receipt parent is not a regular directory");
  const entries = await readdir(directory, { withFileTypes: true });
  const selected = entries.filter(entry => !pattern || pattern.test(entry.name));
  if (selected.some(entry => entry.isSymbolicLink())) throw new TypeError("phase receipt directory cannot be a symlink");
  return selected.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

async function statOrMissing(file: string) {
  try { return await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validBackendId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_.-]{8,256}$/.test(value);
}

function cleanupFencePath(root: string, lease: ExecutionLeaseV1): string {
  return path.join(root, "evals", lease.eval_id, "leases", `${lease.lease_id}.phase-cleanup.json`);
}

function controllerBindingPath(root: string, lease: ExecutionLeaseV1): string {
  return path.join(root, "evals", lease.eval_id, "leases", `${lease.lease_id}.docker-binding.json`);
}

async function readControllerBinding(root: string, lease: ExecutionLeaseV1): Promise<PhaseDockerExecution | null> {
  const file = controllerBindingPath(root, lease);
  const stat = await statOrMissing(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 16 * 1024) throw new TypeError("phase Docker binding is not a bounded regular file");
  const value = await readJSON<PhaseDockerExecution>(file);
  if (value.schema_version !== "1" || value.root_id !== hitchRootId(root) || value.eval_id !== lease.eval_id
    || value.work_id !== lease.work_id || value.lease_id !== lease.lease_id || lease.provider !== "local-docker"
    || !(lease.resource_epochs ?? [lease.epoch]).includes(value.lease_epoch)
    || (value.state !== "not-started" && value.state !== "bound")
    || (value.state === "bound" ? !validBackendId(value.docker_backend_id) : value.docker_backend_id !== undefined)) {
    throw new TypeError("phase Docker binding ownership or state is invalid");
  }
  return value;
}

async function dockerBackendId(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(env.HITCH_DOCKER_PATH || "docker", ["info", "--format", "{{.ID}}"],
    { env, timeoutMs: 10_000, failureCode: "phase_docker_backend_unavailable" });
  const observed = result.stdout.trim();
  if (!validBackendId(observed)) throw new TypeError("phase Docker backend identity is unavailable");
  return observed;
}
