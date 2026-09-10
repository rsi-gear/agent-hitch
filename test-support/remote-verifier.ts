import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { EvalRequest, ExecutionEvidenceV1, RemoteVerifierWorkV2 } from "../src/domain/index.js";
import { buildEvalExecutionPlan, captureRemoteVerifierSource, createExecutionLease, portableRemoteTrial, validateEvalId, createEvalProgress, mergeEvalProgressTrial, writeEvalProgress } from "../src/evals/index.js";
import { prepareHarness, resolveHarness } from "../src/artifacts/index.js";
import { harborPreparedArtifact } from "../src/evals/prepared-harness.js";
import { candidateRestartWorkItem, verifierOnlyWorkItem } from "../src/evals/physical-work-plan.js";
import { buildBenchmarkAdapterManifest } from "../src/evals/benchmark-adapter-manifest.js";
import { benchmarkTreeDigest } from "../src/benchmarks/index.js";
import { benchmarkVerifierIdentity, writeResultBundleIndex, verifyResultBundleIndex } from "../src/runs/index.js";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { atomicWriteJSON, sha256Bytes, sha256JSON } from "../src/foundation/index.js";
import { encodeVerifierSource, importVerifierSource } from "../src/control-plane/remote-verifier-source-transport.js";
import { TrajectoryProjector, TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/index.js";
import { forceRemove, writeFakeNpm } from "./helpers.js";

const sha = `sha256:${"a".repeat(64)}` as const, timestamp = "2026-09-01T00:00:00.000Z";
export async function remoteVerifierFixture(t: TestContext, graderTtlMs = 60_000, prepare = false) {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-result-")); t.after(() => forceRemove(root));
  const evalId = validateEvalId(`eval_${"b".repeat(32)}`), runId = `run_${"c".repeat(32)}`, trialId = "one__source";
  const evalDirectory = path.join(root, "evals", evalId), dataset = path.join(root, "dataset"), taskDirectory = path.join(dataset, "one");
  const runtime = await ensureControllerRuntime({ root });
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "task.toml"), '[verifier]\nenvironment_mode="separate"\n');
  const adapter = await buildBenchmarkAdapterManifest({ dataset, benchmark: { id: "demo", revision: "1" },
    adapter: { id: "fixture", revision: sha, output_protocol: "gear-harbor-eval-result-v1" }, taskIds: ["one"],
    scoring: { total_score: { source_metric: "success", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" } } });
  await atomicWriteJSON(path.join(dataset, "benchmark.adapter.json"), adapter);
  const sourcePackage = path.join(root, "source-package"); await mkdir(sourcePackage);
  await writeFile(path.join(sourcePackage, "input"), "frozen"); await chmod(path.join(sourcePackage, "input"), 0o644);
  const lock = { protocol: "hitch-benchmark@1", benchmark_id: "demo", package_digest: await benchmarkTreeDigest(sourcePackage),
    files: [{ path: "input", digest: sha256Bytes(Buffer.from("frozen")), bytes: 6, mode: 0o644 }] };
  const compiledDigest = sha256JSON({ lock, compiler: "harbor-package@6" });
  await atomicWriteJSON(path.join(evalDirectory, "benchmark/package.json"), { source: sourcePackage, tasks: dataset, package_digest: lock.package_digest, compiled_digest: compiledDigest });
  await atomicWriteJSON(path.join(evalDirectory, "benchmark/benchmark.lock.json"), lock);
  await atomicWriteJSON(path.join(root, "compiled.json"), { digest: compiledDigest, tasks_digest: await benchmarkTreeDigest(dataset) });
  const env = prepare ? { ...process.env, HITCH_NPM_PATH: await writeFakeNpm(root) } : process.env;
  const resolution = prepare ? await resolveHarness("pi@version:1.2.3", { root, env }) : undefined;
  const artifact = resolution ? harborPreparedArtifact(root, await prepareHarness(resolution, { root, env })) : undefined;
  const request: EvalRequest = { schema_version: "1", backend: "harbor", dataset, harness_ref: resolution?.requested_ref ?? "codex@version:1.0.0", model: "synthetic-model",
    attempts: 1, max_concurrent: 1, infrastructure_retries: 0, infrastructure_retry_backoff_ms: 0, timeout_ms: 0, setup_timeout_ms: 1000,
    agent_args: [], pass_env: [], benchmark_id: "demo", benchmark_revision: adapter.dataset_digest };
  const reservation = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0 };
  const plan = buildEvalExecutionPlan({ evalId, request, tasks: ["one"], workItemMode: "task-slots", maxParallelism: 1,
    candidate: { revisionIdentity: resolution?.identity ?? sha, artifactId: artifact?.artifact_id ?? sha }, provider: "remote-docker", trialResources: reservation });
  const logical = plan.work_items[0]!;
  const actualCandidateWork = candidateRestartWorkItem(logical, `rerun_${"1".repeat(32)}`);
  const sourceOwner = await createExecutionLease({ evalDirectory, evalId, workId: actualCandidateWork.work_id, reservation, ttlMs: 60_000,
    worker: { workerId: "worker_source", provider: plan.provider, collisionDomainId: "source-engine" } });
  await sourceOwner.markRunning();
  const sourceLease = sourceOwner.current();
  const observed = { status: "unavailable" as const, started_at: timestamp, collected_at: timestamp, sample_count: 0,
    containers: [], unavailable_fields: [], issues: [] };
  const execution: ExecutionEvidenceV1 = { schema_version: "1", provider: plan.provider, worker_id: sourceLease.worker_id,
    collision_domain_id: sourceLease.collision_domain_id, eval_id: evalId, work_id: actualCandidateWork.work_id,
    lease_id: sourceLease.lease_id, lease_epoch: sourceLease.epoch, task_id: "one", reservation,
    enforced: { main_limits: reservation, sidecar_limits: {} }, observed };
  const context = { kind: "benchmark_task", benchmark_id: "demo", benchmark_revision: adapter.dataset_digest, task_id: "one",
    task_digest: sha, verifier_identity: benchmarkVerifierIdentity("demo", adapter.dataset_digest) };
  const parent = { kind: "eval", eval_id: evalId, trial_id: trialId, attempt: 1 }, runDirectory = path.join(root, "runs", runId);
  await atomicWriteJSON(path.join(runDirectory, "manifest.json"), { schema_version: "1", run_id: runId, context, parent, status: "succeeded",
    harness: { harness_id: resolution?.harness_id ?? "codex", requested_ref: request.harness_ref, revision_identity: resolution?.identity ?? sha },
    model: { requested_id: request.model, effective_id: request.model, identity_resolved: false }, protocol: { timeout_ms: 1000, workspace_mode: "shared" },
    observation: { status: "invalid", invalid_reason: "verifier_result_missing" }, request_ref: "request.json", resolution_ref: "resolution.json",
    result_ref: "result.json", trajectory_ref: "trajectory.ref.json", created_at: timestamp, sealed: true });
  const candidateResult = { run_id: runId, status: "succeeded", output: "original candidate", started_at: timestamp, completed_at: timestamp };
  await atomicWriteJSON(path.join(runDirectory, "request.json"), { context, parent });
  await atomicWriteJSON(path.join(runDirectory, "resolution.json"), {});
  await atomicWriteJSON(path.join(runDirectory, "result.json"), candidateResult);
  await atomicWriteJSON(path.join(runDirectory, "execution.json"), execution);
  await writeFile(path.join(runDirectory, "events.jsonl"), "");
  const projector = new TrajectoryProjector({ runId, cwd: "/workspace", prompt: "fixture", model: request.model, fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "original candidate" }); const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory, cwd: "/workspace", sessionId: projected.header.id, fidelity: projected.fidelity, header: projected.header });
  for (const event of projected.events) writer.append(event);
  const file = await canonicalTrajectoryFileRef(runDirectory, await writer.close());
  await atomicWriteJSON(path.join(runDirectory, "trajectory.ref.json"), trajectoryRefV2({ runId, fidelity: "normalized", providerSessionId: "fixture-session", files: [file] }));
  await writeResultBundleIndex(runDirectory);
  const nativeDirectory = path.join(root, "native-source"); await mkdir(path.join(nativeDirectory, "artifacts"), { recursive: true });
  await writeFile(path.join(nativeDirectory, "artifacts/patch.diff"), "original patch\n");
  const config = { task: { path: taskDirectory }, agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", kwargs: { token: "private-agent-token" } },
    environment: { type: "docker", import_path: "hitch_harbor_environment:HitchHarborDockerEnvironment", override_cpus: 1, override_memory_mb: 1024,
      cpu_enforcement_policy: "limit", memory_enforcement_policy: "limit" }, verifier: { import_path: "hitch_harbor_verifier:HitchRetryingVerifier" } };
  const sourceTrial = { id: "00000000-0000-0000-0000-000000000001", trial_name: trialId, task_name: "one", config,
    agent_result: { metadata: { hitch_run_id: runId, controller_runtime_id: runtime.runtime_id } } };
  await atomicWriteJSON(path.join(nativeDirectory, "config.json"), config); await atomicWriteJSON(path.join(nativeDirectory, "result.json"), sourceTrial);
  await atomicWriteJSON(path.join(nativeDirectory, "benchmark-lifecycle.json"), { schema_version: "1", failure: null, phases: {} });
  const capture = await captureRemoteVerifierSource({ taskId: "one", taskDirectory, trialDirectory: nativeDirectory, bundleDirectory: runDirectory,
    runId, runtimeId: runtime.runtime_id, trial: sourceTrial, destination: path.join(root, "source-snapshot") });
  const trialDirectory = path.join(evalDirectory, "harbor/work-items", execution.work_id, "epoch-000001/job", trialId); await mkdir(trialDirectory, { recursive: true });
  const seal = await importVerifierSource({ source: await encodeVerifierSource(capture), trial: portableRemoteTrial(sourceTrial), trialDirectory,
    taskId: "one", taskDirectory, bundleDirectory: runDirectory, runtimeId: runtime.runtime_id }); await seal({ root, runId });
  await sourceOwner.release();
  const assessmentId = `assessment_${"d".repeat(32)}`, rerunId = `rerun_${"e".repeat(32)}`;
  const physical = { schema_version: "2" as const, kind: "verifier-only" as const, source_work_id: logical.work_id, rerun_id: rerunId, assessment_id: assessmentId };
  const work = verifierOnlyWorkItem(logical, rerunId, assessmentId);
  const owner = await createExecutionLease({ evalDirectory, evalId, workId: work.work_id, reservation, ttlMs: graderTtlMs,
    worker: { workerId: "worker_verifier", provider: plan.provider, collisionDomainId: "verifier-engine" } }); await owner.markRunning();
  const descriptor: RemoteVerifierWorkV2 = { schema_version: "2", kind: "verifier-only", assessment_id: assessmentId,
    source_ref: { trial_id: trialId, run_id: runId, task_id: "one", attempt: 1, observation_status: "invalid", invalid_reason: "verifier_result_missing" },
    source_manifest: capture.manifest, source_trial: portableRemoteTrial(sourceTrial), candidate_result: candidateResult,
    candidate_result_digest: sha256JSON(candidateResult), canonical_bundle_digest: sha256JSON(await verifyResultBundleIndex(runDirectory)), verifier_runtime_id: runtime.runtime_id };
  if (artifact && resolution) {
    await atomicWriteJSON(path.join(evalDirectory, "request.json"), request);
    await atomicWriteJSON(path.join(evalDirectory, "execution-plan.json"), plan);
    await atomicWriteJSON(path.join(evalDirectory, "resolution.json"), resolution);
    await atomicWriteJSON(path.join(evalDirectory, "plan.json"), { schema_version: "1", eval_id: evalId, dataset,
      benchmark_id: request.benchmark_id, benchmark_revision: request.benchmark_revision, tasks: ["one"], attempts: 1, attempt_execution: "harbor-task-slots-v1",
      candidate: { harness_id: resolution.harness_id, revision_identity: resolution.identity }, prepared_artifact: artifact,
      controller_runtime: { runtime_id: runtime.runtime_id, manifest_digest: runtime.manifest_digest } });
    await writeEvalProgress(evalDirectory, mergeEvalProgressTrial(createEvalProgress({ evalId, benchmarkId: request.benchmark_id,
      benchmarkRevision: request.benchmark_revision, plannedTasks: 1, plannedTrials: 1, startedAt: timestamp }), descriptor.source_ref));
    await atomicWriteJSON(path.join(evalDirectory, "result.json"), { status: "failed", trials: [descriptor.source_ref], exit_code: 13 });
    await atomicWriteJSON(path.join(evalDirectory, "submission.json"), { execution: { provider: plan.provider } });
  }
  return { root, evalId, runId, evalDirectory, runDirectory, taskDirectory, runtime, descriptor, plan, work, physical, owner, execution, trialDirectory, request, artifact, resolution,
    sourceSnapshotDirectory: path.join(trialDirectory, "verifier-source") };
}
