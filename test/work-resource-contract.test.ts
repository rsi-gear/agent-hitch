import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackendWorkItemV1, RemoteWorkOfferV1, RemoteWorkInputRefV1, TaskResourceRequirementV1 } from "../src/domain/index.js";
import { workResourceContractFields, parseWorkResourceContract, assertWorkResourceContract, workResourceIdentityFields } from "../src/evals/work-resource-contract.js";
import { workItemId } from "../src/evals/execution-plan-artifacts.js";
import { candidateRestartWorkItem, verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { physicalRetryWorkItemForTriggerIds } from "../src/evals/physical-retry-work.js";
import { parseRemoteWorkItem } from "../src/control-plane/remote-work-item.js";
import { parseRemoteWorkOffer } from "../src/control-plane/remote-worker-codecs.js";
import { assertLegacyRemoteResourceWork } from "../src/control-plane/remote-resource-contract.js";
import { validateRemoteOfferContract } from "../src/control-plane/remote-offer-contract.js";
import { RemoteWorkInputStore, RemoteWorkerProtocol, RemoteWorkerRegistry } from "../src/control-plane/index.js";
import { RemoteWorkerRunner, type RemoteWorkerExecutor } from "../src/control-plane/remote-worker-runner.js";
import type { RemoteWorkerHttpClient } from "../src/control-plane/remote-worker-client.js";
import { parseRemoteHarborWorkSpec } from "../src/workers/remote-harbor-work-spec.js";
import { sha256JSON } from "../src/foundation/index.js";

const reservation = { cpu_millis: 2_000, memory_bytes: 3 * 1024 ** 3, container_slots: 2, build_slots: 0 };
// Resource correctness is covered by the plan tests; here the payload is opaque
// to the binding and every byte, including lifecycle and effective limits, binds.
const requirements = [{ task_id: "task-a", resource_model: "phase-envelope-v1", reservation,
  lifecycle: { phases: [{ id: "agent", demand: reservation }] } }] as unknown as TaskResourceRequirementV1[];

function work(): BackendWorkItemV1 {
  const contract = workResourceContractFields(["task-a"], requirements, "2");
  return { ...contract, work_id: `work_${"a".repeat(32)}`, eval_id: `eval_${"b".repeat(32)}`, backend: "harbor",
    logical_attempt: 1, task_ids: ["task-a"], slots: [`slot_${"c".repeat(32)}`], opaque_membership: false,
    requested_parallelism: 1, reservation, provider: "remote-docker" };
}
function offer(): RemoteWorkOfferV1 {
  const item = work(), now = new Date().toISOString();
  return { ...parseWorkResourceContract(item), offer_id: `offer_${"d".repeat(32)}`, nonce: "e".repeat(64), generation: 1,
    worker_id: "worker_resource", work: item, state: "offered", issued_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(),
    lease: { schema_version: "1", lease_id: `lease_${"f".repeat(32)}`, work_id: item.work_id, eval_id: item.eval_id,
      worker_id: "worker_resource", provider: item.provider, collision_domain_id: "docker:resource", reservation,
      state: "offered", epoch: 1, issued_at: now, expires_at: new Date(Date.now() + 60_000).toISOString() } };
}

test("resource bindings preserve legacy identities and bind the complete selected requirements", () => {
  const item = work();
  assertWorkResourceContract(item, requirements, "2");
  assert.equal(item.resource_contract_digest, sha256JSON({ resource_contract_version: "2", task_resources: requirements }));
  assert.deepEqual(item.required_capabilities, ["phase-exclusive-teardown-v1"]);
  assert.throws(() => assertWorkResourceContract(item, [{ ...requirements[0]!, reservation: { ...reservation, memory_bytes: 1 } }], "2"), /frozen plan/);
  assert.throws(() => assertWorkResourceContract({ ...item, required_capabilities: [] }, requirements, "2"), /frozen plan/);
  const legacyIdentity = { eval_id: item.eval_id, backend: "harbor", logical_attempt: 1, slots: item.slots };
  assert.equal(workItemId(item.eval_id, 1, item.slots), `work_${sha256JSON(legacyIdentity).slice(7, 39)}`);
  assert.notEqual(workItemId(item.eval_id, 1, item.slots), workItemId(item.eval_id, 1, item.slots, [], {}, workResourceIdentityFields(item)));
  assert.deepEqual(workResourceContractFields(item.task_ids, undefined), { schema_version: "1" });
  assert.throws(() => workResourceContractFields(["missing"], requirements, "2"), /missing or duplicated/);
  assert.throws(() => workResourceContractFields([], requirements, "2"), /bounded/);
});

test("work and offer parsers reject downgrades, unknown versions and mismatched resource bindings", () => {
  const item = work(), proposed = offer();
  assert.deepEqual(parseRemoteWorkItem(item), item);
  assert.deepEqual(parseRemoteWorkOffer(proposed), proposed);
  for (const change of [{ schema_version: "1" }, { schema_version: "3" }, { resource_contract_version: undefined },
    { resource_contract_digest: undefined }, { required_capabilities: undefined }, { required_capabilities: ["unknown"] }]) {
    assert.throws(() => parseRemoteWorkItem({ ...item, ...change }), /resource contract/);
  }
  for (const change of [{ schema_version: "1" }, { resource_contract_digest: `sha256:${"0".repeat(64)}` },
    { required_capabilities: [] }, { resource_contract_version: undefined }]) {
    assert.throws(() => parseRemoteWorkOffer({ ...proposed, ...change }), /resource contract/);
  }
  assert.throws(() => parseRemoteWorkOffer({ ...proposed, lease: { ...proposed.lease, reservation: { ...reservation, memory_bytes: 1 } } }), /inconsistent/);
});

test("physical retry and restart retain the frozen resource binding; phase regrade cannot reuse it", () => {
  const item = work(), rerunId = `rerun_${"1".repeat(32)}`;
  for (const physical of [candidateRestartWorkItem(item, rerunId), physicalRetryWorkItemForTriggerIds(item, 1, ["trial-source"])]) {
    assert.deepEqual(parseWorkResourceContract(physical), parseWorkResourceContract(item));
    assert.deepEqual(physical.reservation, reservation);
    assert.notEqual(physical.work_id, item.work_id);
  }
  assert.throws(() => verifierOnlyWorkItem(item, rerunId, `assessment_${"2".repeat(32)}`), { code: "eval_verifier_only_unavailable" });
});

test("P0 remote dispatch refuses V2 before publishing an offer and rejects a plan hidden in V1", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-phase-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RemoteWorkerRegistry({ root }), protocol = new RemoteWorkerProtocol({ root, registry });
  await registry.initialize(); await protocol.initialize();
  const total = { cpu_millis: 16_000, memory_bytes: 64 * 1024 ** 3, container_slots: 16, build_slots: 2 };
  await registry.register({ schema_version: "1", worker_id: "worker_resource", provider: "remote-docker", collision_domain_id: "docker:resource",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false }, task_membership: ["known"],
    capacity: { total, reserved_for_system: { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 }, allocatable: total } });
  const proposed = offer();
  await assert.rejects(protocol.createOffer("worker_resource", proposed.lease, proposed.work), { code: "resource_contract_unsupported" });
  assert.equal((await protocol.listOffers("worker_resource", 1)).length, 0);
  const { resource_contract_version: _version, resource_contract_digest: _digest, required_capabilities: _capabilities, ...rest } = proposed.work;
  const legacy: BackendWorkItemV1 = { ...rest, schema_version: "1" };
  assert.doesNotThrow(() => assertLegacyRemoteResourceWork(legacy));
  const plan = { resource_contract_version: "2", task_resources: requirements };
  assert.throws(() => assertLegacyRemoteResourceWork(legacy, plan), { code: "resource_contract_unsupported" });
  const store = new RemoteWorkInputStore(root); await store.initialize();
  const ref = await store.put("work-spec", "json", Buffer.from(JSON.stringify({ schema_version: "1", plan, work: legacy })));
  const disguised = { ...proposed, schema_version: "1" as const, work: legacy, inputs: [ref] };
  await assert.rejects(validateRemoteOfferContract(disguised, { docker: true, buildkit: true, model_proxy: false, isolated_same_task_attempts: false }, store),
    { code: "resource_contract_unsupported" });
  assert.throws(() => parseRemoteHarborWorkSpec({ plan }, disguised), { code: "resource_contract_unsupported" });
});

test("an unsupported phase offer is rejected before input download, ownership preparation or acceptance", async () => {
  const rejected: string[] = [], actions: string[] = [];
  const client = {
    generation: 1, fencedSignal: new AbortController().signal,
    listOffers: async () => [offer()],
    heartbeat: async () => undefined,
    reject: async (_offer: RemoteWorkOfferV1, code: string) => { rejected.push(code); },
    downloadInput: async () => { actions.push("download"); },
    accept: async () => { actions.push("accept"); },
  } as unknown as RemoteWorkerHttpClient;
  const execute: RemoteWorkerExecutor = async () => { actions.push("execute"); return { status: "succeeded" }; };
  execute.prepare = async () => { actions.push("prepare"); };
  await new RemoteWorkerRunner({ client, capacity: reservation, execute, once: true, pollIntervalMs: 50 }).run();
  assert.deepEqual(actions, []);
  assert.deepEqual(rejected, ["resource_contract_unsupported"]);
});

test("a V2 plan hidden behind V1 transport cannot reach worker acceptance", async () => {
  const phase = offer();
  const { resource_contract_version: _v, resource_contract_digest: _d, required_capabilities: _c, ...item } = phase.work;
  const { resource_contract_version: _ov, resource_contract_digest: _od, required_capabilities: _oc, ...proposed } = phase;
  const disguised: RemoteWorkOfferV1 = { ...proposed, schema_version: "1", work: { ...item, schema_version: "1" },
    inputs: (["work-spec", "harness-artifact", "controller-runtime", "task-input"] as const).map(kind => ({
      kind, format: "json", digest: `sha256:${"a".repeat(64)}`, size: 1,
    })) };
  const actions: string[] = [];
  const client = { generation: 1, fencedSignal: new AbortController().signal, listOffers: async () => [disguised], heartbeat: async () => undefined,
    downloadInput: async (_offer: RemoteWorkOfferV1, ref: RemoteWorkInputRefV1) => ref.kind === "work-spec"
      ? Buffer.from(JSON.stringify({ schema_version: "1", plan: { resource_contract_version: "2", task_resources: requirements } })) : Buffer.from("x"),
    reject: async (_offer: RemoteWorkOfferV1, code: string) => { actions.push(code); },
    accept: async () => { actions.push("accept"); },
  } as unknown as RemoteWorkerHttpClient;
  const execute: RemoteWorkerExecutor = async () => { actions.push("execute"); return { status: "succeeded" }; };
  execute.prepare = async () => { actions.push("prepare"); };
  await new RemoteWorkerRunner({ client, capacity: reservation, execute, once: true, pollIntervalMs: 50 }).run();
  assert.deepEqual(actions, ["resource_contract_unsupported"]);
});
