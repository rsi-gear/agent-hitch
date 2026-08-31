import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExecutionLease, dockerOwnershipLabelMap, dockerResourceOwnership, markExecutionLeaseLost, reapOwnedDockerResources } from "../src/evals/index.js";

const evalId = "eval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const reservation = { cpu_millis: 1_000, memory_bytes: 1024, container_slots: 1, build_slots: 0 };
const worker = { workerId: "worker_reaper", provider: "local-docker", collisionDomainId: "docker:test" };

test("Docker reaper deletes only exact terminal lease ownership after a second inspection", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-docker-reaper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalDirectory = path.join(root, "evals", evalId);
  const released = await lease(evalDirectory, "b", "released");
  const active = await lease(evalDirectory, "c", "running");
  const lost = await lease(evalDirectory, "d", "lost");
  const releasedLabels = dockerOwnershipLabelMap(dockerResourceOwnership(root, released.active, "task-released"));
  const activeLabels = dockerOwnershipLabelMap(dockerResourceOwnership(root, active.active, "task-active"));
  const lostLabels = dockerOwnershipLabelMap(dockerResourceOwnership(root, lost.active, "task-lost"));
  const wrongRoot = { ...releasedLabels, "io.hitch.root-id": "f".repeat(24) };
  const staleEpoch = { ...releasedLabels, "io.hitch.lease-epoch": "9" };
  const missingLease = { ...releasedLabels };
  delete missingLease["io.hitch.lease-id"];

  const resources = new Map<string, { kind: "container" | "network" | "volume"; labels: Record<string, string> }>([
    ["container-released", { kind: "container", labels: releasedLabels }],
    ["container-active", { kind: "container", labels: activeLabels }],
    ["container-wrong-root", { kind: "container", labels: wrongRoot }],
    ["network-lost", { kind: "network", labels: lostLabels }],
    ["network-stale", { kind: "network", labels: staleEpoch }],
    ["volume-released", { kind: "volume", labels: releasedLabels }],
    ["volume-missing", { kind: "volume", labels: missingLease }],
  ]);
  const removed: string[] = [];
  const inspected = new Map<string, number>();
  const commands: string[][] = [];
  const run = async (args: string[]): Promise<{ stdout: string }> => {
    commands.push(args);
    const kind = args[0] as "container" | "network" | "volume";
    if (args[1] === "ls") {
      return { stdout: [...resources].filter(([, value]) => value.kind === kind).map(([id]) => id).join("\n") };
    }
    if (args[1] === "inspect") {
      const id = args[2] as string;
      const value = resources.get(id);
      if (!value || value.kind !== kind) throw new Error("resource not found");
      inspected.set(id, (inspected.get(id) ?? 0) + 1);
      return { stdout: JSON.stringify([kind === "container"
        ? { Id: id, Config: { Labels: value.labels } }
        : kind === "volume" ? { Name: id, Labels: value.labels } : { Id: id, Labels: value.labels }]) };
    }
    const id = args.at(-1) as string;
    removed.push(id);
    resources.delete(id);
    return { stdout: "" };
  };

  const report = await reapOwnedDockerResources({ root, run });
  assert.deepEqual(removed.sort(), ["container-released", "network-lost", "volume-released"]);
  assert.deepEqual(report.deleted.map((entry) => entry.id).sort(), removed);
  assert.equal(report.scanned, 7);
  assert.equal(report.issues.length, 0);
  assert.equal(inspected.get("container-released"), 2);
  assert.equal(inspected.get("network-lost"), 2);
  assert.equal(inspected.get("volume-released"), 2);
  assert.ok(report.retained.some((entry) => entry.id === "container-active" && /not terminal/.test(entry.reason)));
  assert.ok(report.retained.some((entry) => entry.id === "network-stale" && /epoch/.test(entry.reason)));
  assert.ok(report.retained.some((entry) => entry.id === "container-wrong-root" && /root/.test(entry.reason)));
  assert.ok(report.retained.some((entry) => entry.id === "volume-missing" && /ownership/.test(entry.reason)));
  assert.ok(commands.filter((args) => args[1] === "ls").every((args) => args.includes(`label=io.hitch.root-id=${report.root_id}`)));
  assert.equal(commands.some((args) => args[0] === "image" || args.includes("prune")), false);
  await active.handle.release();
});

test("Docker reaper refuses deletion when ownership changes between inspection and removal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-docker-reaper-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evalDirectory = path.join(root, "evals", evalId);
  const released = await lease(evalDirectory, "e", "released");
  const labels = dockerOwnershipLabelMap(dockerResourceOwnership(root, released.active));
  let inspections = 0;
  let removed = false;
  const report = await reapOwnedDockerResources({
    root,
    run: async (args) => {
      if (args[1] === "ls") return { stdout: args[0] === "container" ? "changing" : "" };
      if (args[1] === "inspect") {
        inspections += 1;
        return { stdout: JSON.stringify([{ Id: "changing", Config: { Labels: inspections === 1 ? labels : { ...labels, "io.hitch.work-id": `work_${"f".repeat(32)}` } } }]) };
      }
      removed = true;
      return { stdout: "" };
    },
  });
  assert.equal(removed, false);
  assert.equal(report.deleted.length, 0);
  assert.ok(report.issues.some((entry) => entry.stage === "delete" && /ownership changed/.test(entry.message)));
});

async function lease(evalDirectory: string, workCharacter: string, terminal: "released" | "running" | "lost") {
  const handle = await createExecutionLease({
    evalDirectory,
    evalId,
    workId: `work_${workCharacter.repeat(32)}`,
    worker,
    reservation,
    ttlMs: 60_000,
  });
  const active = await handle.markRunning();
  if (terminal === "released") await handle.release();
  if (terminal === "lost") await markExecutionLeaseLost({ evalDirectory, leaseId: handle.leaseId, expectedEpoch: 1 });
  return { handle, active };
}
