export interface AdapterCapabilities {
  non_interactive: boolean;
  streaming: boolean;
  structured_messages: boolean;
  structured_tool_events: boolean;
  sessions: boolean;
  resume: boolean;
  model_selection: boolean;
  graceful_cancel: boolean;
}

export type NormalizedEvent =
  | { type: "session.created"; session_id: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; text: string }
  | { type: "tool.started"; call_id: string; name: string; input?: unknown }
  | {
      type: "tool.completed";
      call_id: string;
      name?: string;
      status: string;
      input?: unknown;
      output?: unknown;
      native?: unknown;
    }
  | { type: "usage.updated"; usage: Record<string, unknown> }
  | { type: "diagnostic"; level: string; message: string }
  | { type: "provider.event"; provider_type: string; native: unknown };

export interface AdapterRequest {
  cwd: string;
  model: string;
  prompt: string;
  agent_args: string[];
  workspace_mode: string;
  harness_ref: string;
  timeout_ms: number;
}

export interface AdapterProcessRuntime {
  observed_version?: string | undefined;
  run_directory?: string;
  runtime_home?: string;
  resolution?: unknown;
}

export interface ProcessSpecification {
  executable: string;
  args: string[];
  input: string;
  env?: Record<string, string>;
}

export interface RevisionSourceDefinition {
  type: string;
  package?: string;
  packages?: string[];
  bin?: string;
  install_mode?: "project" | "global";
  url?: string;
  commands?: Array<{ executable: string; args: string[]; cwd?: string }>;
  entrypoint?: string;
}

export interface AdapterDefinition {
  id: string;
  display_name: string;
  command: string;
  path_env: string;
  version_args: string[];
  revision_sources?: Record<string, RevisionSourceDefinition>;
  capabilities: AdapterCapabilities;
  process(
    request: AdapterRequest,
    executable: string,
    runtime?: AdapterProcessRuntime,
  ): Promise<ProcessSpecification> | ProcessSpecification;
  /** Structured provider event translation; absent for plain-text adapters. */
  translate?(event: Record<string, unknown>, state?: Record<string, unknown>): NormalizedEvent[];
  /** Plain-text line translation; absent for structured adapters. */
  translateLine?(line: string, state: Record<string, unknown>): NormalizedEvent[];
}

export interface PublicRevisionSource {
  type: string;
  package?: string;
  packages?: string[];
  url?: string;
}

export interface PublicAdapterDefinition {
  id: string;
  display_name: string;
  command: string;
  path_env: string;
  capabilities: AdapterCapabilities;
  revision_selectors: string[];
  revision_sources: Record<string, PublicRevisionSource>;
}
