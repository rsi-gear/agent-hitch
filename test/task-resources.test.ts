import test from "node:test";
import assert from "node:assert/strict";
import { deriveTaskResourceRequirement } from "../src/evals/index.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const defaults = { cpu_millis: 1_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 };

test("task resources include Compose sidecars, separate verifier, and provider overhead", () => {
  const requirement = deriveTaskResourceRequirement({
    taskId: "resource-heavy",
    defaultResources: defaults,
    defaultSource: "operator-default",
    declaration: {
      schema_version: "1",
      task: { cpu_millis: 2_000, memory_bytes: 512 * MIB },
      verifier: { separate: true, environment: { cpu_millis: 4_000, memory_bytes: GIB } },
      compose_services: [
        { name: "main", replicas: 1, cpu_millis: 3_000, memory_bytes: 256 * MIB },
        { name: "database", replicas: 2, cpu_millis: 500, memory_bytes: 64 * MIB },
      ],
      provider_sidecars: { main_egress: true, verifier_egress: true },
      environment_images: [],
      environment_image_fallbacks: [],
      environment_builds: [],
    },
  });

  assert.deepEqual(requirement.main_limits, { cpu_millis: 4_000, memory_bytes: GIB, container_slots: 1, build_slots: 0 });
  assert.deepEqual(requirement.reservation, {
    cpu_millis: 9_500,
    memory_bytes: 2 * GIB + 384 * MIB,
    container_slots: 6,
    build_slots: 0,
  });
  assert.deepEqual(requirement.diagnostics, ["resource_declaration_conflict:cpu_millis", "resource_declaration_conflict:memory_bytes"]);
  assert.equal(requirement.fields.cpu_millis.estimated, false);
  assert.deepEqual(requirement.components.map((entry) => [entry.name, entry.role, entry.replicas]), [
    ["main", "main", 1],
    ["database", "task-sidecar", 2],
    ["verifier", "verifier", 1],
    ["harbor-docker-egress-control-sidecar", "provider-sidecar", 2],
  ]);
});

test("missing task and sidecar declarations use conservative non-zero defaults", () => {
  const requirement = deriveTaskResourceRequirement({
    taskId: "estimated",
    defaultResources: defaults,
    defaultSource: "operator-default",
    declaration: {
      schema_version: "1",
      task: {},
      verifier: { separate: false },
      compose_services: [{ name: "main", replicas: 1 }, { name: "cache", replicas: 1 }],
      provider_sidecars: { main_egress: false, verifier_egress: false },
      environment_images: [],
      environment_image_fallbacks: [],
      environment_builds: [],
    },
  });
  assert.deepEqual(requirement.reservation, { cpu_millis: 2_000, memory_bytes: 2 * GIB, container_slots: 2, build_slots: 0 });
  assert.equal(requirement.fields.cpu_millis.estimated, true);
  assert.equal(requirement.components[1]?.fields.memory_bytes.source, "operator-default");
  assert.equal(requirement.components[1]?.fields.memory_bytes.estimated, true);
});

test("fixed Compose GPU requests enter task admission without charging non-GPU sidecars", () => {
  const requirement = deriveTaskResourceRequirement({
    taskId: "gpu-task",
    defaultResources: { ...defaults, gpu_count: 1 },
    defaultSource: "operator-default",
    declaration: {
      schema_version: "1",
      task: {},
      verifier: { separate: false },
      compose_services: [
        { name: "main", replicas: 1, gpu_count: 2 },
        { name: "database", replicas: 1 },
      ],
      provider_sidecars: { main_egress: false, verifier_egress: false },
      environment_images: [], environment_image_fallbacks: [], environment_builds: [],
    },
  });
  assert.equal(requirement.reservation.gpu_count, 2);
  assert.equal(requirement.main_limits.gpu_count, 2);
  assert.equal(requirement.components[0]?.resources.gpu_count, 2);
  assert.equal(requirement.components[1]?.resources.gpu_count, 0);
  assert.equal(requirement.fields.gpu_count?.source, "derived-components");
});
