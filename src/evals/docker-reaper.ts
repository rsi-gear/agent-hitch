import { lstat } from "node:fs/promises";
import path from "node:path";
import type { DockerResourceOwnershipV1, ExecutionLeaseV1 } from "../domain/index.js";
import { hitchRootId, readJSON, runCommand, withFileLock } from "../foundation/index.js";
import { DOCKER_OWNERSHIP_LABELS, validateDockerResourceOwnership } from "./docker-ownership.js";
import { parseExecutionLease } from "./execution-leases.js";

export type ReapableDockerResourceKind = "container" | "network" | "volume";

export interface DockerReaperReportV1 {
  schema_version: "1";
  root_id: string;
  scanned: number;
  deleted: Array<{ kind: ReapableDockerResourceKind; id: string; lease_id: string; lease_epoch: number }>;
  retained: Array<{ kind: ReapableDockerResourceKind; id: string; reason: string }>;
  issues: Array<{ kind: ReapableDockerResourceKind; id?: string; stage: "list" | "inspect" | "validate" | "delete"; message: string }>;
}

export interface DockerReaperOptions {
  root: string;
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  leaseIds?: readonly string[];
  run?: (args: string[]) => Promise<{ stdout: string; stderr?: string }>;
}

interface InspectedResource {
  kind: ReapableDockerResourceKind;
  id: string;
  labels: Record<string, string>;
}

const RESOURCES: Array<{
  kind: ReapableDockerResourceKind;
  list: string[];
  remove: string[];
  format: string;
}> = [
  { kind: "container", list: ["container", "ls", "--all"], remove: ["container", "rm", "--force"], format: "{{.ID}}" },
  { kind: "network", list: ["network", "ls"], remove: ["network", "rm"], format: "{{.ID}}" },
  { kind: "volume", list: ["volume", "ls"], remove: ["volume", "rm"], format: "{{.Name}}" },
];

export async function reapOwnedDockerResources(options: DockerReaperOptions): Promise<DockerReaperReportV1> {
  if (!options.root) throw new TypeError("Docker reaper root is required");
  const rootId = hitchRootId(options.root);
  const selectedLeases = options.leaseIds === undefined ? null : validateLeaseIds(options.leaseIds);
  const command = options.run ?? ((args: string[]) => runCommand(
    options.dockerExecutable || options.env?.HITCH_DOCKER_PATH || "docker",
    args,
    {
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: 10_000,
      failureCode: "docker_reaper_command_failed",
    },
  ));
  const report: DockerReaperReportV1 = { schema_version: "1", root_id: rootId, scanned: 0, deleted: [], retained: [], issues: [] };
  for (const resource of RESOURCES) {
    let ids: string[];
    try {
      const listed = await command([...resource.list, "--filter", `label=${DOCKER_OWNERSHIP_LABELS.rootId}=${rootId}`, "--format", resource.format]);
      ids = parseListedIds(listed.stdout);
    } catch (error) {
      report.issues.push({ kind: resource.kind, stage: "list", message: errorMessage(error) });
      continue;
    }
    for (const id of ids) await inspectAndMaybeDelete(options.root, resource, id, rootId, selectedLeases, command, report);
  }
  return report;
}

async function inspectAndMaybeDelete(
  root: string,
  resource: typeof RESOURCES[number],
  id: string,
  rootId: string,
  selectedLeases: Set<string> | null,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
  report: DockerReaperReportV1,
): Promise<void> {
  report.scanned += 1;
  let inspected: InspectedResource;
  let ownership: DockerResourceOwnershipV1;
  try {
    inspected = await inspectResource(resource.kind, id, command);
    id = inspected.id;
  } catch (error) {
    report.issues.push({ kind: resource.kind, id, stage: "inspect", message: errorMessage(error) });
    return;
  }
  try {
    ownership = ownershipFromLabels(inspected.labels);
    if (ownership.root_id !== rootId) throw new TypeError("root label does not match this Hitch root");
    if (selectedLeases && !selectedLeases.has(ownership.lease_id)) {
      report.retained.push({ kind: resource.kind, id, reason: "lease_not_selected" });
      return;
    }
    const lease = await readOwnedLease(root, ownership);
    assertLeaseAllowsDeletion(lease, ownership);
  } catch (error) {
    report.retained.push({ kind: resource.kind, id, reason: errorMessage(error) });
    return;
  }

  const evalDirectory = path.join(root, "evals", ownership.eval_id);
  try {
    await withFileLock(path.join(evalDirectory, "leases", ".locks"), ownership.lease_id, async () => {
      const current = await inspectResource(resource.kind, id, command);
      const currentOwnership = ownershipFromLabels(current.labels);
      if (JSON.stringify(currentOwnership) !== JSON.stringify(ownership)) throw new TypeError("resource ownership changed after inspection");
      assertLeaseAllowsDeletion(await readOwnedLease(root, ownership), ownership);
      await command([...resource.remove, id]);
    }, { timeoutCode: "docker_reaper_lease_locked", timeoutExitCode: 12 });
    report.deleted.push({ kind: resource.kind, id, lease_id: ownership.lease_id, lease_epoch: ownership.lease_epoch });
  } catch (error) {
    report.issues.push({ kind: resource.kind, id, stage: "delete", message: errorMessage(error) });
  }
}

async function inspectResource(
  kind: ReapableDockerResourceKind,
  id: string,
  command: (args: string[]) => Promise<{ stdout: string; stderr?: string }>,
): Promise<InspectedResource> {
  if (!id || id.length > 4_096 || /[\0\r\n]/.test(id)) throw new TypeError("Docker resource id is invalid");
  const value = JSON.parse((await command([kind, "inspect", id])).stdout) as unknown;
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) throw new TypeError("Docker inspect response is invalid");
  const item = value[0];
  const observedId = kind === "volume" ? item.Name : item.Id;
  if (typeof observedId !== "string" || !observedId || (kind === "volume" ? observedId !== id : observedId !== id && !observedId.startsWith(id))) {
    throw new TypeError("Docker inspect identity does not match listing");
  }
  const rawLabels = kind === "container" && record(item.Config) ? item.Config.Labels : item.Labels;
  if (!record(rawLabels) || Object.values(rawLabels).some((entry) => typeof entry !== "string")) throw new TypeError("Docker ownership labels are missing or invalid");
  return { kind, id: observedId, labels: rawLabels as Record<string, string> };
}

function ownershipFromLabels(labels: Record<string, string>): DockerResourceOwnershipV1 {
  const epochLabel = labels[DOCKER_OWNERSHIP_LABELS.leaseEpoch];
  const epoch = Number(epochLabel);
  if (epochLabel !== String(epoch)) throw new TypeError("Docker resource ownership epoch is not canonical");
  return validateDockerResourceOwnership({
    root_id: labels[DOCKER_OWNERSHIP_LABELS.rootId] || "",
    provider: labels[DOCKER_OWNERSHIP_LABELS.provider] as "local-docker",
    eval_id: labels[DOCKER_OWNERSHIP_LABELS.evalId] || "",
    work_id: labels[DOCKER_OWNERSHIP_LABELS.workId] || "",
    lease_id: labels[DOCKER_OWNERSHIP_LABELS.leaseId] || "",
    lease_epoch: epoch,
    ...(labels[DOCKER_OWNERSHIP_LABELS.taskId] === undefined ? {} : { task_id: labels[DOCKER_OWNERSHIP_LABELS.taskId] }),
  });
}

async function readOwnedLease(root: string, ownership: DockerResourceOwnershipV1): Promise<ExecutionLeaseV1> {
  const file = path.join(root, "evals", ownership.eval_id, "leases", `${ownership.lease_id}.json`);
  if (!(await lstat(file)).isFile()) throw new TypeError("execution lease is not a regular file");
  return parseExecutionLease(await readJSON<unknown>(file));
}

function assertLeaseAllowsDeletion(lease: ExecutionLeaseV1, ownership: DockerResourceOwnershipV1): void {
  if (lease.lease_id !== ownership.lease_id || lease.eval_id !== ownership.eval_id || lease.work_id !== ownership.work_id || lease.provider !== ownership.provider) {
    throw new TypeError("resource labels do not match the persisted lease");
  }
  if (lease.state !== "released" && lease.state !== "expired" && lease.state !== "lost") throw new TypeError(`lease is not terminal or expired: ${lease.state}`);
  if (!(lease.resource_epochs ?? [lease.epoch]).includes(ownership.lease_epoch)) throw new TypeError("resource epoch is not authorized by the persisted lease");
}

function parseListedIds(stdout: string): string[] {
  const values = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (values.some((entry) => entry.length > 4_096 || /[\0\r\n]/.test(entry))) throw new TypeError("Docker list returned an invalid resource id");
  return [...new Set(values)].sort();
}

function validateLeaseIds(values: readonly string[]): Set<string> {
  if (values.some((value) => !/^lease_[a-f0-9]{32}$/.test(value))) throw new TypeError("Docker reaper lease selection is invalid");
  return new Set(values);
}

function errorMessage(error: unknown): string {
  return ((error as Error)?.message || String(error)).slice(0, 1_024);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
