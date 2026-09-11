import type { ControllerRuntimeObservationV2, HarborEnvironmentObservationV2, RemoteExecutionObservationChallengeV2, RemoteExecutionObservationReceiptV2, ResidentRuntimeObservationV2 } from "../domain/index.js";
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
  const r = exact(value, "schema_version,challenge,runtime,environment,environment_digest");
  check(r.schema_version === "2");
  const environment = parseHarborEnvironmentObservation(r.environment);
  check(r.environment_digest === sha256JSON(environment));
  return { schema_version: "2", challenge: parseExecutionObservationChallenge(r.challenge),
    runtime: parseResidentRuntimeObservation(r.runtime), environment, environment_digest: r.environment_digest as string };
}
