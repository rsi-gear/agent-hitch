import type { ControllerRuntimeObservationV2, ExecutionObservationDiagnosticsV1, HarborEnvironmentObservationV2, RemoteExecutionObservationChallengeV2, RemoteExecutionObservationReceiptV2, ResidentRuntimeObservationV2 } from "../domain/index.js";
import { invalidInput, sha256JSON } from "../foundation/index.js";

type Json = Record<string, unknown>;
const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const digest = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const version = (value: unknown) => typeof value === "string" && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
function exact(value: unknown, keys: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) {
    throw invalidInput("invalid execution observation fields");
  }
  return value as Json;
}
function check(valid: unknown): asserts valid { if (!valid) throw invalidInput("invalid execution observation contract"); }

export function parseExecutionObservationChallenge(value: unknown): RemoteExecutionObservationChallengeV2 {
  const r = exact(value, "schema_version,request_id,nonce,daemon_instance_id,worker_id,generation,provider,collision_domain_id,expires_at");
  check(r.schema_version === "2" && hex(r.request_id, 32) && hex(r.nonce, 32) && hex(r.daemon_instance_id, 32)
    && typeof r.worker_id === "string" && /^worker_[a-z0-9][a-z0-9_-]{0,62}$/.test(r.worker_id)
    && Number.isSafeInteger(r.generation) && Number(r.generation) >= 1 && text(r.provider) && text(r.collision_domain_id)
    && typeof r.expires_at === "string" && Number.isFinite(Date.parse(r.expires_at)) && new Date(r.expires_at).toISOString() === r.expires_at);
  return structuredClone(r) as unknown as RemoteExecutionObservationChallengeV2;
}

function runtime(value: unknown): ControllerRuntimeObservationV2 {
  const r = exact(value, "schema_version,package_version,node_version,runtime_id,source");
  const source = exact(r.source, "kind,commit,dirty");
  check(r.schema_version === "2" && version(r.package_version) && version(r.node_version) && digest(r.runtime_id)
    && (source.kind === "git-checkout" && hex(source.commit, 40) && typeof source.dirty === "boolean"
      || source.kind === "unavailable" && source.commit === null && source.dirty === null));
  return r as unknown as ControllerRuntimeObservationV2;
}

export function parseResidentRuntimeObservation(value: unknown): ResidentRuntimeObservationV2 {
  const r = exact(value, "schema_version,startup,current,unchanged");
  check(r.schema_version === "2" && typeof r.unchanged === "boolean");
  const startup = runtime(r.startup), current = runtime(r.current);
  // A probe may also have observed drift before returning to the original bytes.
  check(!r.unchanged || sha256JSON(startup) === sha256JSON(current));
  return structuredClone({ schema_version: "2", startup, current, unchanged: r.unchanged });
}

export function parseHarborEnvironmentObservation(value: unknown): HarborEnvironmentObservationV2 {
  const r = exact(value, "schema_version,host_platform,harbor,docker,buildx,sandbox");
  const harbor = exact(r.harbor, "status,version,executable_digest");
  const docker = exact(r.docker, "status,version,executable_digest,engine_id,os,architecture");
  const buildx = exact(r.buildx, "status,version"), sandbox = exact(r.sandbox, "status");
  const executable = (item: Json) => item.status === "available" && version(item.version) && digest(item.executable_digest)
    || item.status === "unavailable" && item.version === null && item.executable_digest === null;
  check(r.schema_version === "2" && text(r.host_platform) && executable(harbor) && executable(docker)
    && (docker.status === "available" && text(docker.engine_id) && text(docker.os) && text(docker.architecture)
      || docker.status === "unavailable" && docker.engine_id === null && docker.os === null && docker.architecture === null)
    && (buildx.status === "available" && version(buildx.version) || buildx.status === "unavailable" && buildx.version === null)
    && sandbox.status === "unverified");
  return structuredClone(r) as unknown as HarborEnvironmentObservationV2;
}

export function parseExecutionObservationReceipt(value: unknown): RemoteExecutionObservationReceiptV2 {
  const hasDiagnostics = value !== null && typeof value === "object" && Object.hasOwn(value, "diagnostics");
  const r = exact(value, `schema_version,challenge,runtime,environment,environment_digest${hasDiagnostics ? ",diagnostics" : ""}`);
  check(r.schema_version === "2");
  const environment = parseHarborEnvironmentObservation(r.environment);
  check(r.environment_digest === sha256JSON(environment));
  return { schema_version: "2", challenge: parseExecutionObservationChallenge(r.challenge),
    runtime: parseResidentRuntimeObservation(r.runtime), environment, environment_digest: r.environment_digest as string,
    ...(hasDiagnostics ? { diagnostics: parseExecutionObservationDiagnostics(r.diagnostics) } : {}) };
}

export function parseExecutionObservationDiagnostics(value: unknown): ExecutionObservationDiagnosticsV1 {
  const diagnostics = exact(value, "schema_version,probes");
  check(diagnostics.schema_version === "1" && Array.isArray(diagnostics.probes) && diagnostics.probes.length >= 1 && diagnostics.probes.length <= 4);
  const seen = new Set<string>();
  const stages: Record<string, string[]> = {
    ok: ["complete"], not_found: ["resolve"], io_error: ["resolve", "fingerprint", "identity"],
    spawn_error: ["command"], nonzero_exit: ["command"], signal_exit: ["command"], timed_out: ["command"], output_limit: ["command"],
    invalid_encoding: ["parse"], invalid_json: ["parse"], invalid_fields: ["validate"], executable_changed: ["identity"],
  };
  for (const item of diagnostics.probes) {
    const probe = exact(item, "probe,attempt,stage,outcome,elapsed_ms,exit_code,signal");
    check(typeof probe.probe === "string" && ["harbor_version", "docker_info", "buildx_version"].includes(probe.probe)
      && (probe.attempt === 1 || probe.attempt === 2 && probe.probe === "docker_info" && seen.has("docker_info:1"))
      && typeof probe.outcome === "string" && Object.hasOwn(stages, probe.outcome) && typeof probe.stage === "string" && stages[probe.outcome]!.includes(probe.stage)
      && Number.isSafeInteger(probe.elapsed_ms) && Number(probe.elapsed_ms) >= 0 && Number(probe.elapsed_ms) <= 30_000
      && (probe.exit_code === null || Number.isSafeInteger(probe.exit_code) && Number(probe.exit_code) >= -2_147_483_648 && Number(probe.exit_code) <= 4_294_967_295)
      && [null, "SIGTERM", "SIGKILL", "other"].includes(probe.signal as string | null));
    check(probe.outcome !== "nonzero_exit" || probe.exit_code !== null && probe.exit_code !== 0 && probe.signal === null);
    check(probe.outcome !== "signal_exit" || probe.exit_code === null && probe.signal !== null);
    check(probe.outcome !== "ok" || probe.exit_code === 0 && probe.signal === null);
    const key = `${probe.probe}:${probe.attempt}`;
    check(!seen.has(key)); seen.add(key);
  }
  return structuredClone(diagnostics) as unknown as ExecutionObservationDiagnosticsV1;
}
