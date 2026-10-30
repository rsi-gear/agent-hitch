import type { ResourceVectorV1, TaskResourceComponentV1, TaskResourceLifecycleV2, TaskResourceRequirementV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";

export const PHASE_CAPABILITY = "phase-exclusive-teardown-v1" as const;
export const PHASE_BACKEND_CONTRACT = "harbor-native-docker-single-step-v1" as const;
export const EGRESS_SERVICE = "harbor-docker-egress-control-sidecar";
export const VERIFIER_EGRESS_COMPONENT = `verifier:${EGRESS_SERVICE}`;
const DIMENSIONS = ["cpu_millis", "memory_bytes", "container_slots"] as const;

export function componentId(component: TaskResourceComponentV1): string {
  return `${component.role}:${component.name}`;
}

export function sumResourceComponents(components: readonly TaskResourceComponentV1[]): ResourceVectorV1 {
  const total: ResourceVectorV1 = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
  for (const component of components) for (const key of Object.keys(component.resources) as Array<keyof ResourceVectorV1>) {
    total[key] = (total[key] ?? 0) + (component.resources[key] ?? 0);
  }
  if (Object.values(total).some(value => !Number.isSafeInteger(value) || value < 0)) throw new TypeError("resource component sum is unrepresentable");
  return total;
}

/** The P0 graph is deliberately closed. An unrecognized graph cannot assert its
 * own mutual exclusion and thereby manufacture a smaller reservation. */
export function phaseLifecycle(
  components: readonly TaskResourceComponentV1[],
  separate: boolean,
  artifacts: TaskResourceLifecycleV2["artifacts"],
): TaskResourceLifecycleV2 {
  const agent = components.filter(c => c.role !== "verifier" && !(c.role === "provider-sidecar" && c.name === VERIFIER_EGRESS_COMPONENT));
  const verifier = components.filter(c => c.role === "verifier" || (c.role === "provider-sidecar" && c.name === VERIFIER_EGRESS_COMPONENT));
  const collection = agent.filter(c => c.role !== "main");
  const phase = (id: string, live: readonly TaskResourceComponentV1[]) => ({
    id, live_components: live.map(componentId), demand: sumResourceComponents(live),
  });
  return {
    capability_identity: PHASE_CAPABILITY,
    backend_contract: PHASE_BACKEND_CONTRACT,
    verifier_inputs: separate ? "artifacts-only" : "shared",
    retained_services: [],
    artifacts,
    phases: separate ? [phase("agent", agent), phase("artifact-collection", collection), phase("verifier", verifier)] : [phase("shared", agent)],
    transitions: separate ? [
      { from: "agent", to: "artifact-collection", requires_stop: agent.filter(c => c.role === "main").map(componentId) },
      { from: "artifact-collection", to: "verifier", requires_stop: agent.map(componentId) },
    ] : [],
  };
}

export function phaseReservation(components: readonly TaskResourceComponentV1[], lifecycle: TaskResourceLifecycleV2): ResourceVectorV1 {
  // Disk and GPU retain the conservative sum. Only these three dimensions have
  // certified phase-exclusive reuse in P0.
  const reservation = sumResourceComponents(components);
  for (const dimension of DIMENSIONS) reservation[dimension] = Math.max(...lifecycle.phases.map(phase => phase.demand[dimension]));
  return reservation;
}

export function validatePhaseRequirement(requirement: TaskResourceRequirementV1): void {
  const lifecycle = requirement.lifecycle;
  if (requirement.resource_model !== "phase-envelope-v1" || !lifecycle || !Array.isArray(requirement.declared_limits)
    || lifecycle.capability_identity !== PHASE_CAPABILITY || lifecycle.backend_contract !== PHASE_BACKEND_CONTRACT
    || !["shared", "artifacts-only"].includes(lifecycle.verifier_inputs)
    || !Array.isArray(lifecycle.artifacts) || !Array.isArray(lifecycle.retained_services) || lifecycle.retained_services.length) {
    throw new TypeError("phase resource lifecycle is unsupported or incomplete");
  }
  const { components, main_limits: main } = requirement;
  const separate = lifecycle.verifier_inputs === "artifacts-only";
  if (components.filter(c => c.role === "verifier").length !== Number(separate)
    || components.some(c => (c.role === "main" && c.name !== "main") || (c.role === "verifier" && c.name !== "verifier")
      || (c.role !== "task-sidecar" && c.replicas !== 1)
      || (c.role === "task-sidecar" && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(c.name) || c.name === "main" || c.name === EGRESS_SERVICE))
      || c.fields.cpu_millis.value < 1 || c.fields.memory_bytes.value < 1
      || (c.role === "provider-sidecar" && c.name !== EGRESS_SERVICE && c.name !== VERIFIER_EGRESS_COMPONENT)
      || (!separate && c.name === VERIFIER_EGRESS_COMPONENT))) throw new TypeError("phase resource components do not match the supported topology");
  if (components.some(c => (c.resources.gpu_count ?? 0) > 0)) throw new TypeError("phase GPU execution is not certified");
  const providerComponents = components.filter(c => c.role === "provider-sidecar");
  if (providerComponents.some(c => sha256JSON(c.fields) !== sha256JSON(providerComponents[0]!.fields))) throw new TypeError("phase provider limits differ from the shared execution overlay");
  if (main.cpu_millis % 1_000 !== 0 || main.memory_bytes % (1024 * 1024) !== 0) throw new TypeError("phase main limits cannot be enforced by Harbor");
  for (const component of components.filter(c => c.role === "main" || c.role === "verifier")) {
    if (component.fields.cpu_millis.value !== main.cpu_millis || component.fields.memory_bytes.value !== main.memory_bytes) {
      throw new TypeError("phase effective component limits differ from execution main limits");
    }
  }
  const mainComponent = components.find(c => c.role === "main")!;
  if (sha256JSON(mainComponent.resources) !== sha256JSON(main)) throw new TypeError("phase main resource vector differs from execution limits");
  const ids = components.map(componentId);
  const declarations = requirement.declared_limits;
  if (declarations.length !== ids.length || declarations.some((d, i) => d.component !== ids[i]
    || Object.keys(d).sort().join(",") !== "component,fields" || !d.fields)) throw new TypeError("phase declared limits do not cover components");
  for (const declaration of declarations) {
    const effective = components[ids.indexOf(declaration.component)]!;
    if (Object.keys(declaration.fields).sort().join(",") !== Object.keys(effective.fields).sort().join(",")) throw new TypeError("phase declared resource fields differ");
    for (const key of Object.keys(effective.fields) as Array<keyof TaskResourceComponentV1["fields"]>) {
      const field = declaration.fields[key];
      if (!field || !Number.isSafeInteger(field.value) || field.value < 0 || field.value > effective.fields[key]!.value
        || typeof field.estimated !== "boolean" || !["task", "compose", "submission-default", "operator-default", "provider-policy", "derived-components"].includes(field.source)
        || Object.keys(field).sort().join(",") !== "estimated,source,value") throw new TypeError("phase declared resource evidence is invalid");
    }
  }
  const services = new Set(components.filter(c => c.role === "main" || c.role === "task-sidecar").map(c => c.name));
  const seen = new Set<string>();
  for (const artifact of lifecycle.artifacts) {
    if (!artifact || Object.keys(artifact).sort().join(",") !== "path,service" || !services.has(artifact.service)
      || typeof artifact.path !== "string" || !artifact.path.startsWith("/") || /[\0\r\n]/.test(artifact.path)
      || artifact.path.split("/").includes("..") || seen.has(`${artifact.service}\0${artifact.path}`)) throw new TypeError("phase artifact declaration is invalid");
    seen.add(`${artifact.service}\0${artifact.path}`);
  }
  const expected = phaseLifecycle(components, separate, lifecycle.artifacts);
  if (sha256JSON(expected) !== sha256JSON(lifecycle)) throw new TypeError("phase lifecycle or demand does not match effective components");
  if (sha256JSON(phaseReservation(components, expected)) !== sha256JSON(requirement.reservation)) throw new TypeError("phase reservation does not match effective phase demands");
}

/** Used only for a newly planned provider without the phase capability. Never
 * migrate or rewrite a persisted plan. */
export function conservativeTaskRequirement(requirement: TaskResourceRequirementV1, reason = "provider-capability"): TaskResourceRequirementV1 {
  if (!requirement.resource_model) return requirement;
  const { resource_model: _model, lifecycle: _lifecycle, declared_limits: _declared, ...legacy } = requirement;
  const providerComponents = legacy.components.filter(c => c.role === "provider-sidecar");
  // V1 has one overhead entry with an aggregate replica count. Do not expose
  // V2's role-qualified verifier service name to a legacy worker.
  const components = [...legacy.components.filter(c => c.role !== "provider-sidecar"),
    ...(providerComponents.length ? [{ ...providerComponents[0]!, name: EGRESS_SERVICE,
      replicas: providerComponents.reduce((sum, c) => sum + c.replicas, 0), resources: sumResourceComponents(providerComponents) }] : [])];
  const reservation = sumResourceComponents(components);
  const fields = { ...legacy.fields };
  for (const dimension of DIMENSIONS) fields[dimension] = { ...fields[dimension], value: reservation[dimension] };
  return { ...legacy, components, reservation, fields, diagnostics: [...legacy.diagnostics, `phase_envelope_unavailable:${reason}`] };
}
