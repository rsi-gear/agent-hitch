import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalRequest } from "../src/domain/index.js";
import { hitchRootId, readJSON } from "../src/foundation/index.js";
import { buildEvalExecutionPlan } from "../src/evals/execution-plan.js";
import { deriveTaskResourceRequirement } from "../src/evals/task-resources.js";
import { createExecutionLease } from "../src/evals/execution-leases.js";
import { phaseResourceContractForTask } from "../src/evals/phase-resource-runtime.js";
import { bindPhaseDockerBackend, preparePhaseDockerExecution } from "../src/evals/phase-docker-backend.js";
import { verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { finishVerifierOnlyWork } from "../src/evals/verifier-work-cleanup.js";
import { validateEvalId } from "../src/evals/request.js";
import type { DockerReaperReportV1 } from "../src/evals/docker-reaper.js";

const GIB = 1024 ** 3;
const evalId = validateEvalId(`eval_${"a".repeat(32)}`);
const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset: "/tasks", harness_ref: "pi@version:1.2.3", model: "test/model",
  attempts: 1, max_concurrent: 2, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 0,
  agent_args: [], pass_env: [], benchmark_id: "fixture", benchmark_revision: "fixture" };

function mixedPlan() {
  const taskResources = ["legacy", "phase"].map(taskId => deriveTaskResourceRequirement({ taskId,
    defaultResources: { cpu_millis: 1000, memory_bytes: GIB, container_slots: 1, build_slots: 0 }, defaultSource: "operator-default",
    declaration: { schema_version: "1", task: { cpu_millis: 1000, memory_bytes: 2 * GIB },
      verifier: { separate: true, environment: { cpu_millis: 1000, memory_bytes: 2 * GIB } },
      compose_services: [{ name: "main", replicas: 1 }], verifier_compose_services: [{ name: "main", replicas: 1 }],
      provider_sidecars: { main_egress: false, verifier_egress: false },
      environment_images: [], environment_image_fallbacks: [], environment_builds: [],
      ...(taskId === "phase" ? { lifecycle: { contract: "harbor-native-docker-single-step-v1" as const,
        capability: "phase-exclusive-teardown-v1" as const, verifier_mode: "separate" as const,
        verifier_dependencies: { inputs: "artifacts-only" as const, live_services: [], artifacts: [] } } } : {}),
    },
  }));
  return buildEvalExecutionPlan({ evalId, request, candidate: { revisionIdentity: `sha256:${"b".repeat(64)}`, artifactId: `sha256:${"c".repeat(64)}` },
    maxParallelism: 2, tasks: ["phase", "legacy"], taskResources, workItemMode: "task-slots", provider: "local-docker",
    createdAt: "2026-10-21T00:00:00.000Z" });
}

test("mixed V2 legacy separate verifier keeps its allocation until cleanup is confirmed", async () => {
  const plan = mixedPlan();
  const source = plan.work_items.find(work => work.task_ids[0] === "legacy")!;
  assert.equal(plan.resource_contract_version, "2");
  assert.equal(source.schema_version, "2");
  assert.equal(phaseResourceContractForTask(plan, source, "legacy"), undefined);
  const work = verifierOnlyWorkItem(source, `rerun_${"d".repeat(32)}`, `assessment_${"e".repeat(32)}`, plan);
  assert.deepEqual(work.reservation, source.reservation);
  for (const failure of ["none", "wrong-root", "issues", "retained", "exception", "daemon-changed"]) {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-cleanup-"));
    const evidence = path.join(root, "evidence");
    let released = false; let swept = false;
    try {
      const lease = await createExecutionLease({ evalDirectory: path.join(root, "evals", evalId), evalId, workId: work.work_id,
        worker: { workerId: "local", provider: "local-docker", collisionDomainId: "local" }, reservation: work.reservation, ttlMs: 45_000 });
      await lease.markRunning();
      const docker = path.join(root, "docker");
      await writeFile(docker, '#!/bin/sh\nif [ "$1" = info ]; then echo verifier-test-daemon; fi\n', { mode: 0o755 });
      const env = { ...process.env, HITCH_DOCKER_PATH: docker, DOCKER_CONTEXT: "verifier-test-context" };
      await preparePhaseDockerExecution({ root, lease: lease.current() });
      await bindPhaseDockerBackend({ root, lease: lease.current(), env });
      if (failure === "daemon-changed") await writeFile(docker, '#!/bin/sh\nif [ "$1" = info ]; then echo another-test-daemon; fi\n');
      const input = { root, evidence, env, work, lease, permit: { release: () => { released = true; } },
        reaper: async (): Promise<DockerReaperReportV1> => {
          assert.equal(released, false);
          assert.equal(lease.current().state, "released");
          swept = true;
          if (failure === "exception") throw new Error("Docker unavailable");
          return { schema_version: "1", root_id: failure === "wrong-root" ? "other-root" : hitchRootId(root), scanned: 0, deleted: [],
            retained: failure === "retained" ? [{ kind: "container", id: "owned", reason: "stop unconfirmed" }] : [],
            issues: failure === "issues" ? [{ kind: "container", stage: "delete", message: "failed" }] : [] };
        } };
      if (failure === "none") {
        await finishVerifierOnlyWork(input);
        assert.equal((await readJSON<DockerReaperReportV1>(path.join(evidence, "cleanup.json"))).root_id, hitchRootId(root));
      } else await assert.rejects(finishVerifierOnlyWork(input), { code: "phase_transition_unconfirmed" });
      assert.equal(swept, failure !== "daemon-changed");
      assert.equal(released, failure === "none");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
