import path from "node:path";
import { HitchError, sha256JSON } from "../../foundation/index.js";
import { buildHarborRegradeConfig } from "./regrade.js";

export interface PortableHarborRegradeConfigV2 {
  schema_version: "2";
  kind: "harbor-regrade-config";
  source_config_digest: string;
  source_agent_config_digest: string;
  config: Record<string, unknown>;
}

const TIMEOUTS = ["timeout_multiplier", "agent_timeout_multiplier", "verifier_timeout_multiplier", "agent_setup_timeout_multiplier", "environment_build_timeout_multiplier"];
const AGENT_TIMEOUTS = ["override_timeout_sec", "override_setup_timeout_sec", "max_timeout_sec"];
const ENV_FIELDS = ["type", "import_path", "force_build", "delete", "cpu_enforcement_policy", "memory_enforcement_policy", "override_cpus", "override_memory_mb", "override_storage_mb", "override_gpus", "override_tpu", "suppress_override_warnings", "mounts", "extra_docker_compose", "env", "kwargs", "extra_allowed_hosts"];
const VERIFIER_FIELDS = ["override_timeout_sec", "max_timeout_sec", "include_logs", "exclude_logs", "env", "import_path", "kwargs", "disable"];

/** Preserve verifier/environment settings; old paths, lease labels and private agent configuration cannot be replayed on another worker. */
export function capturePortableHarborRegradeConfig(sourceConfig: Record<string, unknown>, taskDirectory: string): PortableHarborRegradeConfigV2 {
  const source = exact(sourceConfig, ["task", "trial_name", "trials_dir", "install_only", ...TIMEOUTS, "agent", "environment", "verifier", "artifacts", "extra_instruction_paths", "job_id", "source_trial"]);
  const task = exact(source.task, ["path", "git_url", "git_commit_id", "name", "ref", "overwrite", "download_dir", "source"]);
  if (task.path !== taskDirectory || source.install_only || source.source_trial
    || nonempty(source.extra_instruction_paths)) throw invalid("source trial cannot be portably regraded");
  const agent = object(source.agent);
  if (agent.import_path !== "hitch_harbor_agent:HitchHarborAgent") throw invalid("source trial has no managed Hitch agent");
  const config: Record<string, unknown> = {
    task: { path: "task-input" }, install_only: false, source_trial: null,
    ...numbers(source, TIMEOUTS),
    agent: { import_path: "hitch_harbor_agent:HitchHarborAgent", ...numbers(agent, AGENT_TIMEOUTS) },
    environment: portableEnvironment(source.environment), verifier: portableVerifier(source.verifier),
    artifacts: parseArtifacts(source.artifacts ?? []), extra_instruction_paths: [],
  };
  return { schema_version: "2", kind: "harbor-regrade-config", source_config_digest: sha256JSON(sourceConfig),
    source_agent_config_digest: sha256JSON(agent), config };
}

export function parsePortableHarborRegradeConfig(value: unknown): PortableHarborRegradeConfigV2 {
  const r = exact(value, ["schema_version", "kind", "source_config_digest", "source_agent_config_digest", "config"]);
  if (Object.keys(r).length !== 5 || r.schema_version !== "2" || r.kind !== "harbor-regrade-config"
    || !digest(r.source_config_digest) || !digest(r.source_agent_config_digest)) throw invalid("portable regrade config identity is invalid");
  // Re-projecting is also a strict whitelist: the portable form contains no agent kwargs/env or executable paths.
  const normalized = capturePortableHarborRegradeConfig(object(r.config), "task-input").config;
  if (sha256JSON(normalized) !== sha256JSON(r.config)) throw invalid("portable regrade config is not canonical");
  return { schema_version: "2", kind: "harbor-regrade-config", source_config_digest: r.source_config_digest as string,
    source_agent_config_digest: r.source_agent_config_digest as string, config: normalized };
}

export function restorePortableHarborRegradeConfig(input: {
  portable: PortableHarborRegradeConfigV2; sourceConfigDigest: string; taskDirectory: string;
  sourceResult: Record<string, unknown>; sourceDirectory: string; outputDirectory: string; trialName: string; ownershipLabels: Record<string, string>;
}): { sourceConfig: Record<string, unknown>; regradeConfig: Record<string, unknown> } {
  const portable = parsePortableHarborRegradeConfig(input.portable);
  if (portable.source_config_digest !== input.sourceConfigDigest || !path.isAbsolute(input.taskDirectory)
    || !path.isAbsolute(input.sourceDirectory) || !path.isAbsolute(input.outputDirectory)) throw invalid("portable regrade config source or paths differ");
  const sourceConfig = { ...portable.config, task: { path: input.taskDirectory } };
  return { sourceConfig, regradeConfig: buildHarborRegradeConfig({ ...input, sourceConfig }) };
}

function portableEnvironment(value: unknown): Record<string, unknown> {
  const env = exact(value, ENV_FIELDS);
  if (env.import_path !== "hitch_harbor_environment:HitchHarborDockerEnvironment" || env.type !== "docker"
    || nonempty(env.mounts) || nonempty(env.extra_docker_compose) || nonempty(env.env) || env.override_tpu != null) throw invalid("source environment requires unavailable host mounts, credentials or runtime");
  const kwargs = exact(env.kwargs ?? {}, ["hitch_ownership_labels", "hitch_service_resource_limits", "hitch_resolved_images", "hitch_prebuilt_task_image", "hitch_model_proxy_host_gateway", "hitch_main_gpu_count"]);
  const { hitch_ownership_labels: _labels, ...portableKwargs } = kwargs;
  if (portableKwargs.hitch_service_resource_limits !== undefined) for (const [name, value] of Object.entries(object(portableKwargs.hitch_service_resource_limits))) {
    text(name); const limits = exact(value, ["cpu_millis", "memory_bytes", "gpu_count"]);
    if (!positiveInteger(limits.cpu_millis) || !positiveInteger(limits.memory_bytes)
      || limits.gpu_count !== undefined && !positiveInteger(limits.gpu_count)) throw invalid("source service limits are invalid");
  }
  if (portableKwargs.hitch_resolved_images !== undefined) for (const [requested, resolved] of Object.entries(object(portableKwargs.hitch_resolved_images))) {
    text(requested); text(resolved);
    if (/[\s$]|:\/\//.test(requested) || /[\s$]|:\/\//.test(String(resolved)) || !/@sha256:[a-f0-9]{64}$/.test(String(resolved))) throw invalid("source image identity is invalid");
  }
  if (portableKwargs.hitch_prebuilt_task_image !== undefined && !digest(portableKwargs.hitch_prebuilt_task_image)
    || portableKwargs.hitch_main_gpu_count !== undefined && !positiveInteger(portableKwargs.hitch_main_gpu_count)
    || portableKwargs.hitch_model_proxy_host_gateway !== undefined && typeof portableKwargs.hitch_model_proxy_host_gateway !== "boolean") throw invalid("source environment settings are invalid");
  const result: Record<string, unknown> = { type: "docker", import_path: env.import_path, delete: false, kwargs: portableKwargs };
  for (const field of ["force_build", "suppress_override_warnings"]) if (env[field] !== undefined) {
    if (typeof env[field] !== "boolean") throw invalid("source environment flag is invalid"); result[field] = env[field];
  }
  for (const field of ["cpu_enforcement_policy", "memory_enforcement_policy"]) if (env[field] !== undefined) {
    if (typeof env[field] !== "string" || !["auto", "limit", "request", "guarantee", "ignore"].includes(env[field])) throw invalid("source resource enforcement policy is invalid"); result[field] = env[field];
  }
  for (const field of ["override_cpus", "override_memory_mb", "override_storage_mb", "override_gpus"]) if (env[field] !== undefined) {
    if (env[field] !== null && (!Number.isSafeInteger(env[field]) || Number(env[field]) < 0)) throw invalid("source resource override is invalid"); result[field] = env[field];
  }
  if (env.extra_allowed_hosts !== undefined) result.extra_allowed_hosts = strings(env.extra_allowed_hosts);
  return result;
}

function portableVerifier(value: unknown): Record<string, unknown> {
  const verifier = exact(value, VERIFIER_FIELDS);
  if (verifier.disable || verifier.import_path !== "hitch_harbor_verifier:HitchRetryingVerifier" || nonempty(verifier.env)) throw invalid("source verifier requires unavailable code or credentials");
  const kwargs = exact(verifier.kwargs ?? {}, ["infrastructure_retries", "infrastructure_retry_backoff_ms"]);
  for (const item of Object.values(kwargs)) if (!Number.isSafeInteger(item) || Number(item) < 0) throw invalid("source verifier retry policy is invalid");
  const result: Record<string, unknown> = { import_path: verifier.import_path, disable: false, kwargs,
    ...numbers(verifier, ["override_timeout_sec", "max_timeout_sec"]) };
  for (const field of ["include_logs", "exclude_logs"]) if (verifier[field] !== undefined) result[field] = strings(verifier[field]);
  return result;
}

function parseArtifacts(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) throw invalid("source artifacts are invalid");
  return value.map(item => {
    if (typeof item === "string") return text(item);
    const artifact = exact(item, ["source", "destination", "exclude", "service"]);
    text(artifact.source);
    for (const field of ["destination", "service"]) if (artifact[field] != null) text(artifact[field]);
    if (artifact.exclude !== undefined) strings(artifact.exclude);
    return structuredClone(artifact);
  });
}
function numbers(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) if (record[field] !== undefined) {
    if (record[field] !== null && (typeof record[field] !== "number" || !Number.isFinite(record[field]) || Number(record[field]) <= 0)) throw invalid("source timeout is invalid"); result[field] = record[field];
  }
  return result;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("source config field is not an object"); return value as Record<string, unknown>; }
function exact(value: unknown, fields: string[]): Record<string, unknown> { const r = object(value); if (Object.keys(r).some(key => !fields.includes(key))) throw invalid("source config has unsupported fields"); return r; }
function nonempty(value: unknown): boolean { return value != null && (Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : true); }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function digest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function text(value: unknown): string { if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) throw invalid("source config text is invalid"); return value; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.length > 4096) throw invalid("source config list is invalid"); return value.map(text); }
function invalid(message: string): HitchError { return new HitchError(message, { code: "eval_verifier_only_unavailable", exitCode: 2 }); }
