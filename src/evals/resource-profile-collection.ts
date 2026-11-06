import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ResourceProfileIdentityV1, Sha256 } from "../domain/index.js";
import { readJSON, sha256Bytes } from "../foundation/index.js";
import { verifyResultBundleIndex } from "../runs/index.js";
import { readExecutionLeases } from "./execution-leases.js";
import { readEvalRetryState, resolveRetryWork } from "./retry-state.js";
import { candidateRestartWorkItem } from "./physical-work-plan.js";
import { parseEvalExecutionPlan } from "./execution-plan.js";
import { phaseReceiptTrialParents } from "./phase-docker-backend.js";
import { loadResourceProfileIdentityManifest } from "./resource-profile-bindings.js";
import { makeResourceProfile, resourceProfileTrialFromExecution, type ResourceProfileTrialV1 } from "./resource-profile-evidence.js";
import { validateEvalId } from "./request.js";
import { resourceProfileExecutionBindings } from "./resource-profile-execution.js";

/** Collect only frozen control/run evidence. Never inspect today's task tree to
 * reconstruct identities missing from a historical execution plan. */
export async function collectEvalResourceProfile(input: { root: string; evalId: string; taskId: string }) {
  const evalId = validateEvalId(input.evalId), directory = path.join(input.root, "evals", evalId);
  const plan = parseEvalExecutionPlan(await readJSON(path.join(directory, "execution-plan.json")));
  if (plan.eval_id !== evalId || !plan.work_items.some(work => work.task_ids.includes(input.taskId))) throw new TypeError("resource profile task is absent from the frozen eval");
  let identity: ResourceProfileIdentityV1 | null = null;
  let identityDigest: Sha256 | undefined;
  const blocked: string[] = [];
  if (plan.resource_profiling?.identity_manifest_digest) {
    const manifest = await loadResourceProfileIdentityManifest(directory, plan.resource_profiling.identity_manifest_digest);
    const task = manifest.tasks.find(task => task.task_id === input.taskId);
    identity = task?.identity ?? null; identityDigest = task?.identity_digest;
    blocked.push(...task?.blocked_reasons ?? ["frozen_task_identity_unavailable"]);
  } else blocked.push("historical_plan_has_no_profile_identity");
  const runIds = new Set<string>();
  const visit = (value: unknown, inheritedTask?: string): void => {
    if (Array.isArray(value)) { value.forEach(entry => visit(entry, inheritedTask)); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const slot = typeof record.slot_id === "string" ? plan.slots.find(slot => slot.slot_id === record.slot_id) : undefined;
    const task = typeof record.task_id === "string" ? record.task_id : slot?.task_id ?? inheritedTask;
    for (const key of ["run_id", "trigger_run_id"]) if (task === input.taskId && typeof record[key] === "string" && /^run_[a-f0-9]{32}$/.test(record[key])) runIds.add(record[key]);
    Object.values(record).forEach(entry => visit(entry, task));
  };
  for (const name of ["progress.json", "result.json", "retry-state.json"]) visit(await boundedJSON(path.join(directory, name)));
  const rerunIds = await childDirectories(path.join(directory, "reruns"), /^rerun_[a-f0-9]{32}$/);
  for (const name of rerunIds) {
    for (const file of ["result.json", "progress.json"]) visit(await boundedJSON(path.join(directory, "reruns", name, file)));
  }
  const sources = new Map<string, { trusted: boolean; reason?: string }>();
  for (const runId of runIds) {
    const runDirectory = path.join(input.root, "runs", runId);
    const trusted = await verifyResultBundleIndex(runDirectory).then(() => true, () => false);
    sources.set(path.join(runDirectory, "execution.json"), { trusted, ...(trusted ? {} : { reason: "run_bundle_unsealed_or_changed" }) });
  }
  const leases = await readExecutionLeases(directory);
  const retries = await readEvalRetryState(directory, evalId);
  const candidateWorks = rerunIds.flatMap(rerun => plan.work_items.map(work => candidateRestartWorkItem(work, rerun)));
  const bindings = await resourceProfileExecutionBindings({ directory, plan, taskId: input.taskId, identity, rerunIds,
    assessmentIds: await childDirectories(path.join(directory, "assessments"), /^assessment_[a-f0-9]{32}$/), readJSON: boundedJSON });
  const identityIssue = (workId: string): string | undefined => bindings.has(workId) ? bindings.get(workId)
    : resolveRetryWork(plan, retries, workId)?.item.task_ids.includes(input.taskId) ? undefined : "physical_profile_identity_unavailable";
  for (const parent of await phaseReceiptTrialParents(input.root, evalId, leases.filter(lease => lease.provider === "local-docker"))) {
    sources.set(path.join(path.dirname(parent), "execution.json"), { trusted: true });
  }
  const trials = new Map<string, ResourceProfileTrialV1>();
  for (const [file, provenance] of sources) {
    const content = await boundedFile(file); if (!content) continue;
    const value = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    if (value.task_id !== input.taskId) continue;
    if (value.eval_id !== evalId) throw new TypeError("profile evidence belongs to another eval");
    const issue = identityIssue(String(value.work_id));
    const trial = resourceProfileTrialFromExecution({ evidence: value,
      source: { path: path.relative(input.root, file), digest: sha256Bytes(content), trust: provenance.trusted ? "frozen-eval-evidence" : "operator-import" },
      ...(identityDigest && !issue ? { identityDigest } : {}) });
    if (issue) trial.blocked_reasons.push(issue);
    if (provenance.reason) trial.blocked_reasons.push(provenance.reason);
    const prior = trials.get(trial.sample_id);
    trials.set(trial.sample_id, prior ? mergeProfileObservations(prior, trial) : trial);
  }
  for (const lease of leases) {
    const work = plan.work_items.find(work => work.work_id === lease.work_id)
      ?? resolveRetryWork(plan, retries, lease.work_id)?.item ?? candidateWorks.find(work => work.work_id === lease.work_id);
    if (!work && !trials.has(`${lease.lease_id}:${lease.epoch}`)) blocked.push(`unattributed_physical_execution:${lease.lease_id}`);
    if (!work?.task_ids.includes(input.taskId) || trials.has(`${lease.lease_id}:${lease.epoch}`)) continue;
    const issue = identityIssue(lease.work_id);
    trials.set(`${lease.lease_id}:${lease.epoch}`, { sample_id: `${lease.lease_id}:${lease.epoch}`, task_id: input.taskId,
      ...(identityDigest && !issue ? { identity_digest: identityDigest } : {}), source: { path: `evals/${evalId}/leases/${lease.lease_id}.json`,
        digest: sha256Bytes((await boundedFile(path.join(directory, "leases", `${lease.lease_id}.json`)))!), trust: "frozen-eval-evidence" },
      input_case: { id: input.taskId, kind: "unspecified" }, lifecycle: { complete: false, covered_phases: [] }, roles: [],
      blocked_reasons: ["execution_evidence_missing", "complete_lifecycle_not_proven", ...(issue ? [issue] : [])] });
  }
  if (!trials.size) blocked.push("no_execution_evidence");
  return makeResourceProfile({ identity, trials: [...trials.values()], blockedReasons: blocked });
}

export function mergeProfileObservations(first: ResourceProfileTrialV1, second: ResourceProfileTrialV1): ResourceProfileTrialV1 {
  if (first.sample_id !== second.sample_id || first.identity_digest !== second.identity_digest || first.task_id !== second.task_id) throw new TypeError("cannot merge unrelated profile observations");
  const roles = new Map(first.roles.map(role => [role.container_id, role]));
  for (const role of second.roles) {
    const prior = roles.get(role.container_id);
    const peaks = [prior?.memory_peak_bytes, role.memory_peak_bytes].filter((value): value is number => value !== undefined);
    const maximumSource = prior?.memory_peak_bytes !== undefined && (role.memory_peak_bytes === undefined || prior.memory_peak_bytes > role.memory_peak_bytes) ? prior : role;
    roles.set(role.container_id, { ...prior, ...role, peak_kind: maximumSource.peak_kind, peak_semantics: maximumSource.peak_semantics,
      ...(peaks.length ? { memory_peak_bytes: Math.max(...peaks) } : {}),
      ...(prior?.oom_killed ? { oom_killed: true } : {}), ...(prior?.exit_code ? { exit_code: prior.exit_code } : {}) });
  }
  const observations = [first.memory_observation, second.memory_observation].filter(value => value !== undefined);
  const groupPeaks = new Map<string, NonNullable<ResourceProfileTrialV1["memory_observation"]>["group_peaks"][number]>();
  for (const observation of observations) for (const peak of observation.group_peaks) {
    const key = JSON.stringify([peak.group_id, peak.phase_id, peak.semantics, peak.approximate, peak.complete]), prior = groupPeaks.get(key);
    if (!prior || (peak.memory_bytes ?? -1) > (prior.memory_bytes ?? -1)) groupPeaks.set(key, peak);
  }
  return { ...second, roles: [...roles.values()], ...(observations.length ? { memory_observation: { ...observations.at(-1)!, group_peaks: [...groupPeaks.values()] } } : {}), additional_sources: [...first.additional_sources ?? [], first.source, ...second.additional_sources ?? []],
    blocked_reasons: [...new Set([...first.blocked_reasons, ...second.blocked_reasons])] };
}

async function boundedFile(file: string): Promise<Buffer | null> {
  const stat = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 32 * 1024 ** 2) throw new TypeError("resource profile source must be a bounded regular file");
  return readFile(file);
}
async function boundedJSON(file: string): Promise<unknown> { const content = await boundedFile(file); return content ? JSON.parse(content.toString("utf8")) : null; }
async function childDirectories(directory: string, pattern: RegExp): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }))
    .filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name);
}
