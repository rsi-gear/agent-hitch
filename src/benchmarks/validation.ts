import type { BenchmarkManifestV1, BenchmarkProfileV1, BenchmarkTaskV1 } from "../domain/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";

export const BENCHMARK_CAPABILITIES = new Set([
  "shell", "artifact-export", "separate-verifier", "shared-verifier", "compose", "tool-server@1", "http-json-cli", "hitch-hook@1",
  "model-call@1", "native-image-input", "no-tools", "tool-result-images@1", "native-phases@1",
]);

export function unsupported(message: string): never {
  throw new HitchError(message, { code: "unsupported_feature", exitCode: 2 });
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  for (const key of Object.keys(result)) if (!allowed.includes(key)) unsupported(`${label}.${key} is unsupported`);
  return result;
}
export function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) throw invalidInput(`${label} must be a nonempty string`);
}
export function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw invalidInput(`${label} must be an array`);
  value.forEach((item) => nonempty(item, label));
  if (new Set(value).size !== value.length) throw invalidInput(`${label} contains duplicates`);
}
export function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalidInput(`${label} must be a positive integer`);
}
export function relativePath(value: unknown): string {
  nonempty(value, "package path");
  if (/[\x00-\x1f\x7f\\:]/.test(value) || value.startsWith("/") || value.split("/").some((part) => ["", ".", ".."].includes(part))) {
    throw invalidInput(`invalid package-relative path: ${value}`);
  }
  return value;
}

export function parseManifest(value: unknown): BenchmarkManifestV1 {
  const m = fields(value, ["schema_version", "protocol", "id", "release", "task_root", "task_ids", "default_profile", "primary_metric", "task_format", "source", "metrics", "publication", "runtime_components", "extensions"], "manifest");
  if (m.schema_version !== "1" || m.protocol !== "hitch-benchmark@1") unsupported("unsupported benchmark protocol");
  for (const key of ["id", "release", "primary_metric"]) nonempty(m[key], key);
  relativePath(m.task_root); relativePath(m.default_profile);
  strings(m.task_ids, "task_ids");
  if (!m.task_ids.length || m.task_ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))) throw invalidInput("invalid or empty task membership");
  const dialect = fields(m.task_format, ["name", "schema_version"], "task_format");
  if (dialect.name !== "harbor" || dialect.schema_version !== "1.4") unsupported("only Harbor schema 1.4 is supported");
  const source = fields(m.source, ["kind", "path", "uri", "resolved_revision", "license", "access"], "source");
  nonempty(source.license, "source.license");
  if (source.access !== undefined && !["public", "private", "gated"].includes(String(source.access))) throw invalidInput("invalid source access");
  if (source.kind === "git") {
    nonempty(source.uri, "source.uri");
    let uri: URL;
    try { uri = new URL(source.uri); } catch { throw invalidInput("Git source requires a credential-free HTTPS URI"); }
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.search || uri.hash || source.path !== undefined) throw invalidInput("Git source requires a credential-free HTTPS URI without a host path");
    if (!/^[a-f0-9]{40}$/.test(String(source.resolved_revision))) throw invalidInput("Git source requires a full resolved commit");
  } else if (source.kind !== "local") unsupported("unsupported source kind");
  else if (source.path !== "." || source.uri !== undefined || source.resolved_revision !== undefined) throw invalidInput("local source must name package root '.'; its content identity is resolved by Hitch");
  const metrics = object(m.metrics, "metrics");
  if (!Object.hasOwn(metrics, m.primary_metric as string)) throw invalidInput("primary_metric must name a declared metric");
  for (const [name, value] of Object.entries(metrics)) {
    nonempty(name, "metric name");
    const metric = fields(value, ["type", "direction", "range", "reducer"], `metrics.${name}`);
    if (!["binary", "scalar"].includes(String(metric.type)) || !["maximize", "minimize"].includes(String(metric.direction)) || metric.reducer !== "task_macro_mean") unsupported(`unsupported metric definition: ${name}`);
    if (!Array.isArray(metric.range) || metric.range.length !== 2 || !metric.range.every((v) => typeof v === "number" && Number.isFinite(v)) || metric.range[0] > metric.range[1]) throw invalidInput(`invalid metric range: ${name}`);
    if (metric.type === "binary" && JSON.stringify(metric.range) !== "[0,1]") throw invalidInput("binary metrics require range [0,1]");
  }
  const publication = fields(m.publication, ["track", "training_eligible"], "publication");
  if (!["custom", "public-subset"].includes(String(publication.track)) || publication.training_eligible !== false) unsupported("MVP packages require custom/public-subset track and training_eligible=false");
  m.runtime_components ??= [];
  if (!Array.isArray(m.runtime_components)) throw invalidInput("runtime_components must be an array");
  const ids = new Set<string>();
  for (const value of m.runtime_components) {
    const component = fields(value, ["id", "protocol", "path"], "runtime component");
    nonempty(component.id, "component.id"); nonempty(component.protocol, "component.protocol"); relativePath(component.path);
    if (ids.has(component.id)) throw invalidInput("duplicate runtime component id");
    ids.add(component.id);
  }
  return m as unknown as BenchmarkManifestV1;
}

export function parseProfile(value: unknown): BenchmarkProfileV1 {
  const p = fields(value, ["schema_version", "id", "track", "input_mode", "tool_policy", "budget", "sampling", "grading", "extensions"], "profile");
  if (p.schema_version !== "1" || p.input_mode !== "instruction") unsupported("unsupported profile version/input mode");
  nonempty(p.id, "profile.id");
  if (!["custom", "public-subset"].includes(String(p.track))) unsupported("unsupported profile track");
  const policy = fields(p.tool_policy, ["id", "allowed", "network", "enforcement"], "tool_policy");
  nonempty(policy.id, "tool_policy.id"); strings(policy.allowed, "tool_policy.allowed");
  if (policy.network !== "open" || policy.enforcement !== "required") unsupported("this backend profile currently supports explicit open network only");
  if (policy.allowed.some((c) => !BENCHMARK_CAPABILITIES.has(c))) unsupported("unknown allowed tool capability");
  const budget = fields(p.budget, ["agent_timeout", "setup_timeout_ms", "collection_timeout_ms", "cleanup_grace_ms"], "budget");
  const timeout = fields(budget.agent_timeout, ["source"], "agent_timeout");
  if (timeout.source !== "task") unsupported("agent timeout must inherit task");
  for (const key of ["setup_timeout_ms", "collection_timeout_ms", "cleanup_grace_ms"]) positive(budget[key], key);
  const sampling = fields(p.sampling, ["attempts_per_task", "seed"], "sampling");
  positive(sampling.attempts_per_task, "attempts_per_task");
  if (!Number.isSafeInteger(sampling.seed)) throw invalidInput("seed must be an integer");
  const grading = fields(p.grading, ["on_agent_budget_exhausted", "on_missing_submission", "infrastructure_retries"], "grading");
  if (grading.on_agent_budget_exhausted !== "grade_final_state" || grading.on_missing_submission !== "error") unsupported("unsupported grading policy");
  if (!Number.isSafeInteger(grading.infrastructure_retries) || Number(grading.infrastructure_retries) < 0) throw invalidInput("invalid grading retries");
  return p as unknown as BenchmarkProfileV1;
}

export function parseTask(value: unknown, manifest: BenchmarkManifestV1): BenchmarkTaskV1 {
  const t = fields(value, ["schema_version", "source_task_id", "driver", "requirements", "lifecycle", "submission", "grading", "extensions"], "task");
  if (t.schema_version !== "1") unsupported("unsupported task extension version");
  nonempty(t.source_task_id, "source_task_id"); strings(t.requirements, "requirements");
  for (const cap of t.requirements) if (!BENCHMARK_CAPABILITIES.has(cap)) unsupported(`required capability unavailable: ${cap}`);
  const driver = fields(t.driver, ["kind", "protocol_version", "config"], "driver");
  if (!["tool-server", "terminal", "model-call"].includes(String(driver.kind)) || driver.protocol_version !== "1") unsupported("unsupported driver protocol");
  const required = driver.kind === "model-call" ? ["model-call@1", "native-image-input", "no-tools", "artifact-export", "separate-verifier"] : driver.kind === "terminal" ? ["shell"] : ["shell", "tool-server@1", "http-json-cli", "hitch-hook@1", "separate-verifier", "compose", "artifact-export"];
  for (const cap of required) if (!t.requirements.includes(cap)) throw invalidInput(`${driver.kind} driver requires capability ${cap}`);
  if (t.requirements.includes("tool-result-images@1") && (driver.kind !== "tool-server" || !t.requirements.includes("native-image-input"))) throw invalidInput("tool-result-images@1 requires a tool-server driver and native-image-input");
  if (driver.kind !== "tool-server") {
    const config = fields(driver.config, driver.kind === "model-call" ? ["input"] : [], "driver.config");
    if (driver.kind === "model-call") relativePath(config.input);
    if (driver.kind !== "model-call" && t.requirements.includes("no-tools")) unsupported("only the trusted model-call runner enforces no-tools");
    fields(t.lifecycle, [], "native lifecycle (Harbor owns the lifecycle)");
  } else {
  const config = fields(driver.config, ["transport", "endpoint", "schema", "service", "native_phases"], "driver.config");
  if (config.transport !== "http-json-cli") unsupported("unsupported tool-server transport");
  nonempty(config.service, "tool service");
  if (!/^[a-z][a-z0-9_-]*$/.test(config.service) || config.service === "main") throw invalidInput("tool service must be a sidecar");
  nonempty(config.endpoint, "tool endpoint");
  const url = new URL(config.endpoint);
  if (url.protocol !== "http:" || url.hostname !== config.service || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw invalidInput("tool endpoint must target the declared isolated Compose service root");
  relativePath(config.schema);
  if (config.native_phases !== undefined) {
    const phases = fields(config.native_phases, ["protocol", "argv", "audit_path", "shutdown_timeout_ms", "finalization_timeout_ms"], "native_phases");
    if (!["hitch-native-phase-control@1", "hitch-native-phase-control@2"].includes(String(phases.protocol))) unsupported("unsupported native phase protocol");
    if (phases.protocol === "hitch-native-phase-control@2") positive(phases.finalization_timeout_ms, "native finalization timeout");
    else if (phases.finalization_timeout_ms !== undefined) throw invalidInput("native finalization requires control protocol v2");
    if (!Array.isArray(phases.argv) || !phases.argv.length || phases.argv.length > 32) throw invalidInput("invalid native phase controller argv");
    phases.argv.forEach(arg => { nonempty(arg, "native phase argv"); if (arg.length > 8192) throw invalidInput("native phase argv too long"); });
    positive(phases.shutdown_timeout_ms, "phase shutdown timeout");
    if (phases.shutdown_timeout_ms > 600000) throw invalidInput("native phase shutdown allowance too large");
    nonempty(phases.audit_path, "native phase audit path");
    if (!phases.audit_path.startsWith("/") || phases.audit_path.slice(1).split("/").some(p => !p || p === "." || p === "..") || /[\\\x00-\x1f\x7f]/.test(phases.audit_path)) throw invalidInput("invalid native phase audit path");
    for (const cap of ["native-phases@1", "native-image-input", "tool-result-images@1"]) if (!t.requirements.includes(cap)) throw invalidInput(`native phases require ${cap}`);
  }
  const lifecycle = fields(t.lifecycle, ["prepare", "quiesce", "snapshot", "cleanup"], "lifecycle");
  for (const phase of ["prepare", "quiesce", "snapshot", "cleanup"]) {
    const hook = fields(lifecycle[phase], ["protocol", "target", "argv", "timeout_ms"], `hook.${phase}`);
    if (hook.protocol !== "hitch-hook@1" || hook.target !== `environment:${config.service}`) unsupported(`unsupported hook target/protocol: ${phase}`);
    // Repeated argv values are valid, unlike membership lists.
    if (!Array.isArray(hook.argv) || !hook.argv.length) throw invalidInput(`missing hook argv: ${phase}`);
    hook.argv.forEach((arg) => nonempty(arg, "hook argv")); positive(hook.timeout_ms, "hook timeout");
  }
  }
  if (t.requirements.includes("native-phases@1") && (driver.kind !== "tool-server" || !(driver.config as Record<string, unknown>).native_phases)) throw invalidInput("native-phases@1 requires a native phase controller");
  const submission = fields(t.submission, ["kind", "paths", "max_bytes", "final_response"], "submission");
  if (submission.kind !== "artifacts" && !(driver.kind === "terminal" && submission.kind === "environment")) unsupported("unsupported submission");
  strings(submission.paths, "submission.paths"); positive(submission.max_bytes, "submission.max_bytes");
  if ((submission.kind === "artifacts" && !submission.paths.length) || submission.paths.some((p) => !p.startsWith("/") || p.split("/").includes(".."))) throw invalidInput("submission paths must be absolute safe container paths");
  if (submission.kind === "environment" && submission.paths.length) throw invalidInput("environment submission uses the upstream verifier's live workspace, not artifact paths");
  if (driver.kind === "tool-server") {
    const phases = (driver.config as { native_phases?: { audit_path: string } }).native_phases;
    if (phases && !submission.paths.some(p => phases.audit_path === p || phases.audit_path.startsWith(p.replace(/\/$/, "") + "/"))) throw invalidInput("native audit must be in a declared controller snapshot");
  }
  if (submission.final_response !== undefined && (submission.final_response !== "/hitch-evidence/final-response.json" || !submission.paths.includes(submission.final_response) || driver.kind === "tool-server")) throw invalidInput("invalid final response export");
  if (driver.kind === "model-call" && !submission.final_response) throw invalidInput("model-call requires canonical final response export");
  const grading = fields(t.grading, ["kind", "entrypoint", "metric_map"], "grading");
  if ((grading.kind !== "command" && !(driver.kind === "terminal" && grading.kind === "harbor")) || JSON.stringify(grading.entrypoint) !== '["bash","/tests/test.sh"]') unsupported("unsupported grader command");
  const mapping = object(grading.metric_map, "metric_map");
  if (Object.keys(mapping).sort().join("\0") !== Object.keys(manifest.metrics).sort().join("\0")) throw invalidInput("metric_map must cover exactly the declared metrics");
  Object.values(mapping).forEach((v) => nonempty(v, "metric mapping"));
  return t as unknown as BenchmarkTaskV1;
}
