import path from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import type { DockerResourceOwnershipV1, EvalExecutionPlanV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { dockerOwnershipLabelMap } from "./docker-ownership.js";
import { componentId, EGRESS_SERVICE, VERIFIER_EGRESS_COMPONENT } from "./phase-resources.js";

type EnvironmentRole = "agent" | "verifier" | "shared";
interface FrozenObservationTopology {
  components: Array<{ component_id: string; service: string; environment_role: EnvironmentRole;
    role: "main" | "verifier" | "task-sidecar" | "provider-sidecar"; phase_ids: string[]; replicas: number }>;
}

/** Host-generated input from the frozen plan; never inferred from container names. */
export function agentEnvironmentRoleForTask(plan: EvalExecutionPlanV1, taskId: string): "agent" | "shared" | undefined {
  const lifecycle = plan.task_resources?.find(entry => entry.task_id === taskId)?.lifecycle;
  return lifecycle ? lifecycle.verifier_inputs === "shared" ? "shared" : "agent" : undefined;
}

export function frozenDockerObservation(
  plan: EvalExecutionPlanV1, taskId: string, ownership: DockerResourceOwnershipV1,
  location: { trialParent: string } | { trialDirectory: string },
): { topology?: FrozenObservationTopology; resolvePhase?: (group: EnvironmentRole) => Promise<string | undefined> } {
  const requirement = plan.task_resources?.find(entry => entry.task_id === taskId);
  if (!requirement?.lifecycle) return {};
  const { lifecycle } = requirement;
  const shared = lifecycle.verifier_inputs === "shared";
  const topology: FrozenObservationTopology = { components: requirement.components.map(component => {
    const verifier = component.role === "verifier" || component.name === VERIFIER_EGRESS_COMPONENT;
    return { component_id: componentId(component), role: component.role, replicas: component.replicas,
      service: component.role === "verifier" ? "main" : component.name === VERIFIER_EGRESS_COMPONENT ? EGRESS_SERVICE : component.name,
      environment_role: shared ? "shared" : verifier ? "verifier" : "agent",
      phase_ids: lifecycle.phases.filter(phase => phase.live_components.includes(componentId(component))).map(phase => phase.id) };
  }) };
  const labels = dockerOwnershipLabelMap(ownership), planDigest = sha256JSON(plan);
  return { topology, resolvePhase: async group => {
    try {
      const directories = "trialDirectory" in location ? [location.trialDirectory] : await trialDirectories(location.trialParent);
      const phases: Array<string | undefined> = [];
      for (const directory of directories) {
        const observation = await receipt(path.join(directory, `hitch-environment-observation-${group}.json`));
        if (!observation || observation.schema_version !== "1" || observation.environment_role !== group
          || !sameOwnership(observation.ownership, labels)) continue;
        if (group === "shared") { phases.push(observation.phase === "shared" ? "shared" : undefined); continue; }
        const proof = await receipt(path.join(directory, `hitch-phase-resources-${group}.json`));
        if (!proof || proof.schema_version !== "1" || proof.role !== group || proof.failure !== null
          || !sameOwnership(proof.ownership, labels) || !isRecord(proof.contract)
          || proof.contract.plan_digest !== planDigest || proof.contract.task_id !== taskId
          || !Array.isArray(proof.events) || observation.phase === null) { phases.push(undefined); continue; }
        const last = [...proof.events].reverse().find(event => isRecord(event)
          && ["environment.started", "main.stopped-confirmed", "environment.stopped-confirmed"].includes(String(event.event)));
        const phase = !isRecord(last) ? undefined : last.event === "environment.started" ? group
          : group === "agent" && last.event === "main.stopped-confirmed" ? "artifact-collection" : undefined;
        phases.push(phase && observation.phase === phase ? phase : undefined);
      }
      // Ambiguous/missing/stopped evidence is unknown, not a guessed phase.
      return phases.length === 1 && lifecycle.phases.some(phase => phase.id === phases[0]) ? phases[0] : undefined;
    } catch { return undefined; }
  } };
}

async function trialDirectories(parent: string): Promise<string[]> {
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  if (entries.length > 128) return [];
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(parent, entry.name));
}
async function receipt(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parent = await lstat(path.dirname(file)), info = await lstat(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sameOwnership(value: unknown, labels: Record<string, string>): boolean {
  return isRecord(value) && Object.keys(value).length === Object.keys(labels).length
    && Object.entries(labels).every(([key, expected]) => value[key] === expected);
}
