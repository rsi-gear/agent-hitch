import path from "node:path";
import { chmod, readFile } from "node:fs/promises";
import type { TrainingExternalBindingV1, TrainingProxyIdentityV1 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";

const hash = /^sha256:[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9_-]{1,128}$/;
function invalid(message: string): never { throw new HitchError(message, { code: "training_binding_invalid", exitCode: 12 }); }

export function parseTrainingBinding(value: unknown): TrainingExternalBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("training binding must be an object");
  const r = value as Record<string, unknown>;
  const fields = ["kind", "bindingId", "trainingRunId", "policyLeaseRef", "expectedPolicyVersion", "fencingToken", "expiresAt", "endpointRef", "credentialRef", "generationContractDigest", "requiredCapture", "api", "maxOutputTokens", "maxEpisodeSteps"];
  if (Object.keys(r).some(k => !fields.includes(k)) || fields.some(k => !(k in r))) invalid("training binding fields are invalid");
  if (r.kind !== "training-external" || r.requiredCapture !== "exact-policy-tokens-v1" || r.api !== "chat-completions") invalid("unsupported training binding contract");
  for (const key of ["bindingId", "trainingRunId"]) if (typeof r[key] !== "string" || !id.test(r[key] as string)) invalid(`invalid training ${key}`);
  for (const key of ["expectedPolicyVersion", "fencingToken", "expiresAt", "endpointRef", "credentialRef"]) if (typeof r[key] !== "string" || !(r[key] as string).trim() || /[\0\r\n]/.test(r[key] as string)) invalid(`invalid training ${key}`);
  if (!hash.test(String(r.generationContractDigest)) || !Number.isFinite(Date.parse(String(r.expiresAt)))) invalid("training contract digest or expiration is invalid");
  if (r.endpointRef !== `hitch-training:${r.bindingId}` || r.credentialRef !== r.endpointRef) invalid("training endpoint must use the controlled Hitch registry");
  const ref = r.policyLeaseRef as Record<string, unknown>;
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).sort().join(",") !== "digest,mediaType,uri"
    || !hash.test(String(ref.digest)) || ref.mediaType !== "application/json" || typeof ref.uri !== "string" || !ref.uri) invalid("training lease content reference is invalid");
  for (const key of ["maxOutputTokens", "maxEpisodeSteps"]) if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 1) invalid(`invalid training ${key}`);
  return structuredClone(r) as unknown as TrainingExternalBindingV1;
}

export function trainingProxyIdentity(binding: TrainingExternalBindingV1): TrainingProxyIdentityV1 {
  return { binding_id: binding.bindingId, training_run_id: binding.trainingRunId, policy_version: binding.expectedPolicyVersion,
    generation_contract_digest: binding.generationContractDigest, api: binding.api, max_output_tokens: binding.maxOutputTokens, max_episode_steps: binding.maxEpisodeSteps };
}

export interface RegisteredTrainingEndpoint { schema_version: "1"; binding: TrainingExternalBindingV1; base_url: string; credential: string }
const registrationPath = (root: string, binding: TrainingExternalBindingV1) => path.join(root, "training", "bindings", `${binding.bindingId}.json`);

export async function registerTrainingEndpoint(root: string, input: unknown): Promise<TrainingExternalBindingV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("training registration must be an object");
  const r = input as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "base_url,binding,credential,schema_version" || r.schema_version !== "1") invalid("training registration fields are invalid");
  const binding = parseTrainingBinding(r.binding);
  const url = new URL(String(r.base_url));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") invalid("training gateway must have an explicit /v1 HTTP endpoint without credentials in its URL");
  if (typeof r.credential !== "string" || r.credential.length < 32 || /[\s\0]/.test(r.credential)) invalid("training credential is invalid");
  const registration: RegisteredTrainingEndpoint = { schema_version: "1", binding, base_url: url.toString(), credential: r.credential };
  await withFileLock(path.join(root, "training", "locks"), binding.bindingId, async () => {
    const prior = await readJSON<RegisteredTrainingEndpoint | null>(registrationPath(root, binding), null);
    if (prior && sha256JSON(prior) !== sha256JSON(registration)) invalid("training binding registration is immutable");
    if (!prior) { await atomicWriteJSON(registrationPath(root, binding), registration); await chmod(registrationPath(root, binding), 0o600); }
  });
  return binding;
}

export async function resolveTrainingEndpoint(root: string, bindingInput: TrainingExternalBindingV1): Promise<RegisteredTrainingEndpoint> {
  const binding = parseTrainingBinding(bindingInput);
  if (Date.parse(binding.expiresAt) <= Date.now()) invalid("training policy lease has expired");
  const record = await readJSON<RegisteredTrainingEndpoint | null>(registrationPath(root, binding), null);
  if (!record || sha256JSON(record.binding) !== sha256JSON(binding)) invalid("training binding registration is missing or differs from frozen request");
  const response = await fetch(`${record.base_url.replace(/\/$/, "")}/lease`, { headers: { Authorization: `Bearer ${record.credential}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) invalid("training gateway rejected the policy lease");
  const lease = await response.json() as Record<string, unknown>;
  if (lease.schemaVersion !== 1 || lease.trainingRunId !== binding.trainingRunId || lease.policyVersion !== binding.expectedPolicyVersion
    || lease.fencingToken !== binding.fencingToken || lease.state !== "serving" || lease.generationContractDigest !== binding.generationContractDigest
    || lease.capture !== "exact-policy-tokens-v1") invalid("training gateway does not attest the frozen policy and exact capture contract");
  return record;
}

export async function bindTrainingRun(endpoint: RegisteredTrainingEndpoint, runId: string, signal?: AbortSignal): Promise<void> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) invalid("training requires a canonical Hitch run id");
  const response = await fetch(`${endpoint.base_url.replace(/\/$/, "")}/hitch/run`, {
    method: "POST", headers: { Authorization: `Bearer ${endpoint.credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runId, bindingId: endpoint.binding.bindingId }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) invalid("training gateway refused canonical run binding");
  const result = await response.json() as Record<string, unknown>;
  if (result.runId !== runId || result.policyVersion !== endpoint.binding.expectedPolicyVersion) invalid("training run binding attestation differs");
}

export async function readTrainingRegistration(file: string): Promise<unknown> {
  let text: string;
  if (file === "-") {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) invalid("training registration exceeds 64 KiB"); chunks.push(Buffer.from(chunk)); }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > 65536) invalid("training registration exceeds 64 KiB");
  }
  return JSON.parse(text);
}
