import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DockerResourceOwnershipV1, EvalExecutionPlanV1, TaskResourceRequirementV1 } from "../src/domain/index.js";
import { deriveTaskResourceRequirement } from "../src/evals/task-resources.js";
import { agentEnvironmentRoleForTask, frozenDockerObservation } from "../src/evals/frozen-docker-observation.js";
import { dockerOwnershipLabelMap } from "../src/evals/docker-ownership.js";
import { sha256JSON } from "../src/foundation/index.js";

const ownership: DockerResourceOwnershipV1 = { root_id: "a".repeat(24), provider: "local-docker", eval_id: `eval_${"b".repeat(32)}`,
  work_id: `work_${"c".repeat(32)}`, lease_id: `lease_${"d".repeat(32)}`, lease_epoch: 1, task_id: "task" };
function plan(shared = false): EvalExecutionPlanV1 {
  const requirement: TaskResourceRequirementV1 = deriveTaskResourceRequirement({ taskId: "task", phaseEnvelope: true,
    defaultResources: { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 }, defaultSource: "operator-default",
    declaration: { schema_version: "1", task: { cpu_millis: 1000, memory_bytes: 1024 ** 3 },
      verifier: { separate: !shared }, compose_services: [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 2 }],
      verifier_compose_services: shared ? [] : [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: true, verifier_egress: !shared },
      environment_images: [], environment_image_fallbacks: [], environment_builds: [],
      lifecycle: { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: shared ? "shared" : "separate",
        verifier_dependencies: { inputs: shared ? "backend-defined" : "artifacts-only", live_services: [], artifacts: [] } } } });
  return { task_resources: [requirement] } as EvalExecutionPlanV1;
}
const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
test("frozen topology distinguishes repeated service names and requires host phase evidence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-frozen-observation-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const trial = path.join(directory, "trial"); await mkdir(trial);
  const frozen = plan(), observed = frozenDockerObservation(frozen, "task", ownership, { trialParent: directory });
  assert.equal(agentEnvironmentRoleForTask(frozen, "task"), "agent");
  assert.deepEqual(observed.topology!.components.filter(c => c.service === "main").map(c => [c.component_id, c.environment_role]), [["main:main", "agent"], ["verifier:verifier", "verifier"]]);
  assert.deepEqual(observed.topology!.components.filter(c => c.service === "harbor-docker-egress-control-sidecar").map(c => c.environment_role), ["agent", "verifier"]);
  assert.equal(observed.topology!.components.find(c => c.service === "simulator")!.replicas, 2);
  const labels = dockerOwnershipLabelMap(ownership);
  const observationFile = path.join(trial, "hitch-environment-observation-agent.json"), proofFile = path.join(trial, "hitch-phase-resources-agent.json");
  const observation = { schema_version: "1", ownership: labels, environment_role: "agent", phase: "agent" };
  const proof = { schema_version: "1", ownership: labels, role: "agent", failure: null,
    contract: { plan_digest: sha256JSON(frozen), task_id: "task" }, events: [{ event: "environment.started" }] };
  assert.equal(await observed.resolvePhase!("agent"), undefined);
  await write(observationFile, observation); assert.equal(await observed.resolvePhase!("agent"), undefined);
  await write(proofFile, proof); assert.equal(await observed.resolvePhase!("agent"), "agent");
  await write(proofFile, { ...proof, events: [...proof.events, { event: "main.stopped-confirmed" }] });
  assert.equal(await observed.resolvePhase!("agent"), undefined, "unacknowledged transition must remain unknown");
  await write(observationFile, { ...observation, phase: "artifact-collection" });
  assert.equal(await observed.resolvePhase!("agent"), "artifact-collection");
  for (const invalid of [{ ...proof, failure: "stop failed" }, { ...proof, ownership: { ...labels, "io.hitch.lease-epoch": "2" } },
    { ...proof, contract: { ...proof.contract, plan_digest: `sha256:${"0".repeat(64)}` } },
    { ...proof, events: [{ event: "environment.stopped-confirmed" }] }]) {
    await write(proofFile, invalid); assert.equal(await observed.resolvePhase!("agent"), undefined);
  }
  await write(proofFile, proof); await write(observationFile, observation);
  const second = path.join(directory, "second"); await mkdir(second);
  await write(path.join(second, path.basename(observationFile)), observation); await write(path.join(second, path.basename(proofFile)), proof);
  assert.equal(await observed.resolvePhase!("agent"), undefined, "multiple owned trials are ambiguous");
  await rm(second, { recursive: true }); await rm(proofFile); await symlink(observationFile, proofFile);
  assert.equal(await observed.resolvePhase!("agent"), undefined, "receipt symlinks are not evidence");
});

test("shared phase uses trusted wrapper journal; absent lifecycle never guesses", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-shared-observation-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const frozen = plan(true), observed = frozenDockerObservation(frozen, "task", ownership, { trialDirectory: directory });
  assert.equal(agentEnvironmentRoleForTask(frozen, "task"), "shared");
  assert.ok(observed.topology!.components.every(c => c.environment_role === "shared"));
  const file = path.join(directory, "hitch-environment-observation-shared.json");
  const journal = { schema_version: "1", ownership: dockerOwnershipLabelMap(ownership), environment_role: "shared", phase: "shared" };
  await write(file, journal); assert.equal(await observed.resolvePhase!("shared"), "shared");
  await write(file, { ...journal, phase: null }); assert.equal(await observed.resolvePhase!("shared"), undefined);
  delete frozen.task_resources![0]!.lifecycle;
  assert.deepEqual(frozenDockerObservation(frozen, "task", ownership, { trialDirectory: directory }), {});
  assert.equal(agentEnvironmentRoleForTask(frozen, "task"), undefined);
});
