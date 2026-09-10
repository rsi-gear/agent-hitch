import type { ControllerRuntimeObservationV2, HarborEnvironmentObservationV2, RemoteExecutionObservationChallengeV2, RemoteExecutionObservationReceiptV2, RemoteWorkerRegistrationV1 } from "../src/domain/index.js";
import { sha256JSON } from "../src/foundation/index.js";

export const OBSERVATION_ZERO = { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 };
export function observationRegistration(): RemoteWorkerRegistrationV1 {
  const capacity = { cpu_millis: 1000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 1 };
  return { schema_version: "1", worker_id: "worker_observed", provider: "remote-observed", collision_domain_id: "remote-engine-domain",
    platforms: ["linux/amd64"], backends: [{ id: "harbor", version: "0.21.0" }],
    features: { docker: true, buildkit: true, model_proxy: true, isolated_same_task_attempts: false, execution_observation: "2" },
    task_membership: ["known"], capacity: { total: capacity, reserved_for_system: OBSERVATION_ZERO, allocatable: capacity } };
}

export function observationFixture() {
  const current: ControllerRuntimeObservationV2 = { schema_version: "2", package_version: "0.2.9", node_version: "v22.0.0", runtime_id: sha256JSON("hitch-runtime"),
    source: { kind: "git-checkout", commit: "a".repeat(40), dirty: true } };
  const runtime = { schema_version: "2" as const, startup: structuredClone(current), current, unchanged: true };
  const environment: HarborEnvironmentObservationV2 = { schema_version: "2", host_platform: "linux-x64",
    harbor: { status: "available", version: "0.21.0", executable_digest: sha256JSON("harbor") },
    docker: { status: "available", version: "28.1.0", executable_digest: sha256JSON("docker"), engine_id: "remote-actual-engine", os: "linux", architecture: "x86_64" },
    buildx: { status: "unavailable", version: null }, sandbox: { status: "unverified" } };
  return { runtime, environment };
}

export function observationReceipt(challenge: RemoteExecutionObservationChallengeV2): RemoteExecutionObservationReceiptV2 {
  const { runtime, environment } = observationFixture();
  return { schema_version: "2", challenge, runtime, environment, environment_digest: sha256JSON(environment) };
}

export async function waitObservation<T>(read: () => Promise<T | null | undefined | false>, timeout = 5000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("observation fixture condition timed out");
}
