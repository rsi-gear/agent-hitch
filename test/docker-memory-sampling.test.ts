import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { dockerOwnershipLabelMap } from "../src/evals/docker-ownership.js";
import { startDockerResourceObserver } from "../src/evals/docker-resource-observer.js";
import type { DockerResourceObserverOptions } from "../src/evals/docker-resource-observer.js";
import { parseExecutionEvidence } from "../src/evals/execution-evidence.js";

const ownership = { root_id: "a".repeat(24), provider: "local-docker", eval_id: `eval_${"b".repeat(32)}`,
  work_id: `work_${"c".repeat(32)}`, lease_id: `lease_${"d".repeat(32)}`, lease_epoch: 1, task_id: "task-a" };
const limits = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
const ids = ["e".repeat(64), "f".repeat(64)];
function fixture(input: { count?: number; failFirstPoll?: boolean; cli?: (cycle: number) => string;
  engine?: (cycle: number, index: number) => Promise<{ memory_bytes?: number; kernel_peak_bytes?: number; cpu_time_ns?: number; read_at?: string }>;
  state?: (cycle: number) => Record<string, unknown>; trusted?: boolean; kernel?: (cycle: number) => number | undefined } = {}) {
  let cycle = 0, cliCalls = 0;
  const options: DockerResourceObserverOptions = { ownership, workerId: "local", collisionDomainId: "local", reservation: limits,
    mainLimits: limits, sidecarLimits: {}, intervalMs: 60_000,
    kernelMemoryPeak: async () => input.kernel?.(cycle),
    ...(input.engine ? { engineStats: id => input.engine!(cycle, ids.indexOf(id)) } : {}),
    topology: { components: [{ component_id: "main:main", service: "main", role: "main", environment_role: "agent", phase_ids: ["agent"], replicas: 1 },
      { component_id: "task-sidecar:simulator", service: "simulator", role: "task-sidecar", environment_role: "agent", phase_ids: ["agent", "artifact-collection"], replicas: 1 }] },
    resolvePhase: async () => "agent",
    run: async args => {
      if (args[1] === "ls") { cycle += 1; if (input.failFirstPoll && cycle === 1) throw new Error("Docker temporarily unavailable"); return { stdout: ids.slice(0, input.count ?? 1).join("\n") }; }
      if (args[1] === "inspect") return { stdout: JSON.stringify([{ Id: args[2], Name: "/misleading-verifier-main",
        Config: { Labels: { ...dockerOwnershipLabelMap(ownership), "com.docker.compose.service": args[2] === ids[0] ? "main" : "simulator",
          ...(input.trusted ? { "io.hitch.environment-role": "agent" } : {}) } },
        State: { Running: true, Pid: 1234, StartedAt: "2026-10-21T00:00:00.000Z", ...input.state?.(cycle) } }]) };
      if (args[1] === "stats") { cliCalls++; return { stdout: JSON.stringify({ MemUsage: input.cli?.(cycle) ?? "unknown" }) }; }
      throw new Error("unexpected command");
    } };
  return { observer: startDockerResourceObserver(options), cliCalls: () => cliCalls };
}

test("CLI fallback samples every cycle, preserves zero, and polling recovers after failure", async () => {
  const f = fixture({ cli: cycle => `${cycle === 1 ? 0 : 40}B / 1GiB` });
  const first = await f.observer.capture();
  assert.equal(first.observed.containers[0]!.peak_memory_bytes, 0);
  const final = await f.observer.stop();
  assert.equal(f.cliCalls(), 2);
  assert.equal(final.observed.containers[0]!.peak_memory_bytes, 40);
  assert.equal(final.observed.containers[0]!.memory!.sample_count, 2);
  assert.equal(final.observed.containers[0]!.memory!.sampled_peak_semantics, "cli-working-set");
  assert.deepEqual(final.observed.containers[0]!.memory!.samples.map(s => s.memory_bytes), [0, 40]);
  const retry = fixture({ failFirstPoll: true, cli: () => "0B / 1GiB" });
  const retried = await retry.observer.capture();
  assert.equal(retried.observed.memory!.gaps[0]!.reason, "poll-failed");
  assert.equal(retried.observed.sample_count, 1);
  assert.equal(retried.observed.memory!.attempted_cycles, 2);
  assert.equal(retried.observed.containers[0]!.memory!.samples[0]!.cycle, 2);
  const recovered = await retry.observer.stop();
  assert.equal(recovered.observed.containers[0]!.memory!.sampled_peak_bytes, 0);
  assert.equal(recovered.observed.memory!.attempted_cycles, 3);
});

test("Engine usage can recover after a CLI fallback and never suppresses a later fallback", async () => {
  const f = fixture({ engine: async cycle => cycle === 2 ? {} : { memory_bytes: cycle === 1 ? 10 : 50, cpu_time_ns: cycle * 10 }, cli: () => "30B / 1GiB" });
  await f.observer.capture(); await f.observer.capture();
  const evidence = await f.observer.stop(), memory = evidence.observed.containers[0]!.memory!;
  assert.deepEqual(memory.samples.map(s => s.source), ["docker-engine", "docker-cli", "docker-engine"]);
  assert.equal(f.cliCalls(), 1); assert.equal(memory.sampled_peak_bytes, 50);
  assert.equal(evidence.observed.containers[0]!.cpu_time_ns, 30);
});

test("same-cycle totals differ from independent peaks and attribution requires trusted labels plus frozen topology", async () => {
  const f = fixture({ count: 2, trusted: true, engine: async (cycle, index) => ({ memory_bytes: cycle === 1 ? (index === 0 ? 100 : 0) : (index === 0 ? 0 : 200) }) });
  await f.observer.capture(); const evidence = await f.observer.stop(), memory = evidence.observed.memory!;
  assert.equal(memory.max_container_sampled_peak_bytes, 200);
  assert.equal(memory.sum_container_sampled_peaks_bytes, 300);
  assert.deepEqual(memory.groups.filter(g => g.group_id === "task").map(g => g.memory_bytes), [100, 200]);
  assert.equal(evidence.observed.containers[0]!.role, "candidate");
  assert.equal(evidence.observed.containers[0]!.service, "main");
  assert.equal(evidence.observed.containers[0]!.memory!.attribution!.role, "main");
  assert.equal(evidence.observed.containers[0]!.memory!.samples[0]!.phase_id, "agent");
  const unknown = fixture({ cli: () => "1B / 1GiB" });
  const unidentified = await unknown.observer.stop();
  assert.equal(unidentified.observed.containers[0]!.memory!.attribution, undefined);
  assert.equal(unidentified.observed.containers[0]!.memory!.samples[0]!.phase_id, undefined);
});

test("kernel peaks remain distinct from sampled usage and record restart/reset boundaries", async () => {
  const f = fixture({ engine: async () => ({ memory_bytes: 10, kernel_peak_bytes: 90 }),
    kernel: cycle => cycle === 1 ? 500 : cycle === 2 ? 400 : 700,
    state: cycle => ({ StartedAt: cycle < 3 ? "2026-10-21T00:00:00.000Z" : "2026-10-21T00:00:01.000Z" }) });
  await f.observer.capture(); await f.observer.capture(); const evidence = await f.observer.stop();
  const memory = evidence.observed.containers[0]!.memory!;
  assert.equal(memory.sampled_peak_bytes, 10);
  assert.deepEqual(memory.samples.map(s => s.kernel_peak_bytes), [500, 400, 700]);
  assert.deepEqual(memory.samples.map(s => s.reset_boundary), ["container-start", "counter-decrease", "restart"]);
  assert.equal(memory.samples[0]!.kernel_peak_source, "cgroup-v2-memory.peak");
  assert.equal(memory.lifecycle_coverage, "partial");
});

test("group totals disclose missing members, mixed semantics and collection span", async () => {
  const partial = fixture({ count: 2, engine: async (_cycle, index) => index === 0 ? {} : { memory_bytes: 0 } });
  const partialEvidence = await partial.observer.stop();
  const group = partialEvidence.observed.memory!.groups[0]!;
  assert.equal(group.memory_bytes, 0); assert.equal(group.complete, false); assert.equal(group.approximate, true);
  assert.equal(group.running_container_count, 2); assert.equal(group.sampled_container_count, 1);
  assert.equal(partialEvidence.observed.memory!.gaps[0]!.reason, "stats-unavailable");
  const mixed = fixture({ count: 2, engine: async (_cycle, index) => index === 0 ? { memory_bytes: 5 } : {}, cli: () => "10B / 1GiB" });
  const mixedGroup = (await mixed.observer.stop()).observed.memory!.groups[0]!;
  assert.equal(mixedGroup.memory_bytes, 15); assert.equal(mixedGroup.semantics, "mixed"); assert.equal(mixedGroup.approximate, true);
  const slow = fixture({ count: 2, engine: async () => { await new Promise(resolve => setTimeout(resolve, 135)); return { memory_bytes: 1 }; } });
  const slowGroup = (await slow.observer.stop()).observed.memory!.groups[0]!;
  assert.equal(slowGroup.span_ms, Date.parse(slowGroup.collected_at) - Date.parse(slowGroup.started_at));
  assert.ok(slowGroup.span_ms >= 250); assert.equal(slowGroup.approximate, true);
});

test("missing stats remains unavailable rather than zero, and samples/schema remain bounded and compatible", async () => {
  const missing = fixture(); const absent = await missing.observer.stop();
  const memory = absent.observed.containers[0]!.memory!;
  assert.equal(memory.status, "unavailable"); assert.equal(memory.sampled_peak_bytes, undefined);
  assert.equal(memory.gaps[0]!.reason, "stats-unavailable");
  const f = fixture({ engine: async cycle => ({ memory_bytes: cycle }) });
  for (let i = 0; i < 258; i++) await f.observer.capture();
  const evidence = await f.observer.stop(), tracked = evidence.observed.containers[0]!.memory!;
  assert.equal(tracked.samples.length, 256); assert.equal(tracked.dropped_samples, tracked.sample_count - 256);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(JSON.parse(await readFile("docs/schemas/execution-evidence.schema.json", "utf8")));
  assert.equal(validate(evidence), true, ajv.errorsText(validate.errors));
  assert.deepEqual(parseExecutionEvidence(evidence), evidence);
  const legacy = structuredClone(evidence); delete legacy.observed.memory;
  for (const container of legacy.observed.containers) delete container.memory;
  assert.deepEqual(parseExecutionEvidence(legacy), legacy);
  const invalid = structuredClone(evidence); invalid.observed.memory!.groups[0]!.span_ms += 1;
  assert.throws(() => parseExecutionEvidence(invalid), /memory sampling/);
});

test("lifetime classified group peaks survive raw sample truncation and retain Engine timestamp span", async () => {
  const f = fixture({ count: 2, trusted: true, engine: async (cycle, index) => ({ memory_bytes: cycle === 1 ? 1000 : 1,
    read_at: `2026-10-21T00:00:0${index}.000Z` }) });
  for (let i = 0; i < 514; i++) await f.observer.capture();
  const evidence = await f.observer.stop(), memory = evidence.observed.memory!;
  assert.equal(memory.groups.length, 1024); assert.ok(memory.dropped_group_samples > 0);
  assert.equal(Math.max(...memory.groups.map(g => g.memory_bytes ?? 0)), 2);
  for (const id of ["task", "agent"]) {
    const peak = memory.group_peaks.find(g => g.group_id === id)!;
    assert.equal(peak.memory_bytes, 2000); assert.equal(peak.cycle, 1); assert.equal(peak.phase_id, "agent");
    assert.equal(peak.sample_count, 515); assert.equal(peak.approximate, true);
    assert.equal(peak.source_span_ms, 1000); assert.equal(peak.max_source_span_ms, 1000);
    assert.ok(Date.parse(peak.last_sample_at) >= Date.parse(peak.collected_at));
  }
  assert.deepEqual(parseExecutionEvidence(evidence), evidence);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(JSON.parse(await readFile("docs/schemas/execution-evidence.schema.json", "utf8")));
  assert.equal(validate(evidence), true, ajv.errorsText(validate.errors));
});
