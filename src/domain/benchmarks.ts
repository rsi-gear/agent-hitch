import type { Sha256 } from "./ids.js";

export interface BenchmarkMetricV1 {
  type: "binary" | "scalar";
  direction: "maximize" | "minimize";
  range: [number, number];
  reducer: "task_macro_mean";
}

export interface BenchmarkManifestV1 {
  schema_version: "1";
  protocol: "hitch-benchmark@1";
  id: string;
  release: string;
  task_root: string;
  task_ids: string[];
  default_profile: string;
  primary_metric: string;
  task_format: { name: "harbor"; schema_version: "1.4" };
  source: { kind: "local" | "git"; path?: string; uri?: string; resolved_revision?: string; license: string; access?: "public" | "private" | "gated" };
  metrics: Record<string, BenchmarkMetricV1>;
  publication: { track: "custom" | "public-subset"; training_eligible: false };
  runtime_components: Array<{ id: string; protocol: string; path: string }>;
  extensions?: Record<string, unknown>;
}

export interface BenchmarkProfileV1 {
  schema_version: "1";
  id: string;
  track: "custom" | "public-subset";
  input_mode: "instruction";
  tool_policy: { id: string; allowed: string[]; network: "open"; enforcement: "required" };
  budget: { agent_timeout: { source: "task" }; setup_timeout_ms: number; collection_timeout_ms: number; cleanup_grace_ms: number };
  sampling: { attempts_per_task: number; seed: number };
  grading: { on_agent_budget_exhausted: "grade_final_state"; on_missing_submission: "error"; infrastructure_retries: number };
  extensions?: Record<string, unknown>;
}

export type BenchmarkHookPhase = "prepare" | "quiesce" | "snapshot" | "cleanup";
export interface BenchmarkHookV1 {
  protocol: "hitch-hook@1";
  target: string;
  argv: string[];
  timeout_ms: number;
}

export interface BenchmarkTaskV1 {
  schema_version: "1";
  source_task_id: string;
  driver: {
    kind: "tool-server";
    protocol_version: "1";
    config: { transport: "http-json-cli"; endpoint: string; schema: string; service: string;
      native_phases?: { argv: string[]; audit_path: string; shutdown_timeout_ms: number } & (
        { protocol: "hitch-native-phase-control@1"; finalization_timeout_ms?: never }
        | { protocol: "hitch-native-phase-control@2"; finalization_timeout_ms: number }
      ) };
  } | { kind: "terminal"; protocol_version: "1"; config: Record<string, never> }
    | { kind: "model-call"; protocol_version: "1"; config: { input: string } };
  requirements: string[];
  lifecycle: Partial<Record<BenchmarkHookPhase, BenchmarkHookV1>>;
  submission: { kind: "artifacts" | "environment"; paths: string[]; max_bytes: number; final_response?: "/hitch-evidence/final-response.json" };
  grading: { kind: "command" | "harbor"; entrypoint: ["bash", "/tests/test.sh"]; metric_map: Record<string, string> };
  extensions?: Record<string, unknown>;
}

export interface BenchmarkFileV1 { path: string; digest: Sha256; bytes: number; mode: number }
export interface BenchmarkEnvironmentRefV1 { role: string; kind: "build"; context_digest: Sha256; base_image_digests: Sha256[]; platform: "linux/amd64" }
export interface BenchmarkLockV1 {
  schema_version: "1";
  protocol: "hitch-benchmark@1";
  benchmark_id: string;
  release: string;
  package_digest: Sha256;
  source: { kind: "local" | "git"; uri: string; resolved_revision: string; access: "public" | "private" | "gated"; manifest_digest: Sha256 };
  components: Array<{ role: string; uri: string; resolved_revision: string; digest: Sha256 }>;
  resolver: { id: string; version: string; code_digest: Sha256 };
  source_adapter?: { id: string; version: string; code_digest: Sha256 };
  task_dialect: BenchmarkManifestV1["task_format"];
  runtime_components: Array<{ id: string; protocol: string; content_digest: Sha256 }>;
  tasks: Array<{ task_id: string; source_task_id: string; path: string; task_digest: Sha256; input_digest: Sha256; grader_digest: Sha256; environment_refs: BenchmarkEnvironmentRefV1[] }>;
  profile_digest: Sha256;
  required_capabilities: string[];
  metric_spec_digest: Sha256;
  files: BenchmarkFileV1[];
  transformations: Array<{ kind: string; before: Sha256; after: Sha256 }>;
}

export interface LoadedBenchmarkV1 {
  directory: string;
  manifest: BenchmarkManifestV1;
  profile: BenchmarkProfileV1;
  tasks: Array<{ id: string; path: string; config: BenchmarkTaskV1; harbor: Record<string, unknown>; tools: unknown[] }>;
  lock: BenchmarkLockV1;
}
