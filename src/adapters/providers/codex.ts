import type { AdapterDefinition } from "../contract.js";
import { asString, codexSupportsEphemeral } from "./shared.js";
import { codexContainerAuth } from "./codex-auth.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalidInput } from "../../foundation/index.js";

export const codexAdapter: AdapterDefinition = {
    id: "codex",
    display_name: "Codex CLI",
    command: "codex",
    path_env: "HITCH_CODEX_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: { type: "npm", package: "@openai/codex", bin: "codex" },
      commit: {
        type: "git",
        url: "https://github.com/openai/codex.git",
        commands: [
          { executable: "cargo", args: ["build", "--release", "--locked", "--bin", "codex"], cwd: "codex-rs" },
        ],
        entrypoint: "codex-rs/target/release/codex",
      },
    },
    capabilities: {
      non_interactive: true,
      streaming: true,
      structured_messages: true,
      structured_tool_events: true,
      sessions: true,
      resume: false,
      model_selection: true,
      graceful_cancel: true,
    },
    requirements: {
      network: "required",
      credential_names: ["OPENAI_API_KEY"],
      endpoint_override: "supported",
      capture: { native_events: true, native_session: true, model_proxy_compatible: true },
    },
    process(request, executable, runtime = {}) {
      if (runtime.isolated) {
        const isolated = runtime.isolated;
        return { executable, input: request.prompt, args: [
          "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
          "--disable", "apps", "--disable", "plugins", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
          "-C", request.cwd, "-m", request.model, "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
          "-c", 'model_provider="hitch_isolated"',
          "-c", `model_providers.hitch_isolated={name="Hitch isolated",base_url=${JSON.stringify(isolated.provider_url)},wire_api="responses",env_key="HITCH_ISOLATED_MODEL_KEY",request_max_retries=0,stream_max_retries=0,requires_openai_auth=false}`,
          ...(isolated.reasoning_effort ? ["-c", `model_reasoning_effort=${JSON.stringify(isolated.reasoning_effort)}`] : []),
          ...(isolated.output_schema ? ["--output-schema", isolated.output_schema] : []),
          ...(isolated.output_file ? ["--output-last-message", isolated.output_file] : []), "-",
        ] };
      }
      const args = ["exec", "--json"];
      if (codexSupportsEphemeral(runtime.observed_version)) args.push("--ephemeral");
      args.push("--skip-git-repo-check", "--color", "never", "-C", request.cwd);
      const endpoint = runtime.model_endpoint;
      if (endpoint && (!runtime.model_endpoint_credential || !runtime.runtime_home)) {
        throw new Error("managed local model binding is incomplete");
      }
      if (endpoint && request.agent_args.some(arg => /^(?:-m|--model|--oss|--local-provider|-p|--profile|-c|--config)(?:=|$)/.test(arg))) {
        throw invalidInput("endpoint-bound Codex runs do not accept model/provider/profile/config overrides");
      }
      const model = endpoint?.wire_model ?? request.model;
      if (model) args.push("--model", model);
      args.push(...request.agent_args, "-");
      if (endpoint) {
        return localCodexProcess(request, executable, args, runtime);
      }
      const auth = codexContainerAuth();
      return { executable, args, input: request.prompt, ...(auth ? { env: auth } : {}) };
    },
    translate(event, state = {}) {
      const pendingCommands = (state.pendingCommands ??= {}) as Record<string, Record<string, unknown>>;
      if (event.type === "thread.started") {
        return [{ type: "session.created", session_id: asString(event.thread_id) }];
      }
      if (event.type === "item.completed" && (event.item as Record<string, unknown>)?.type === "agent_message") {
        return [{ type: "message.completed", text: asString((event.item as Record<string, unknown>).text) }];
      }
      const toolTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
      const item = (event.item || {}) as Record<string, unknown>;
      if (event.type === "item.started" && toolTypes.has(item.type as string)) {
        if (item.type === "command_execution") pendingCommands[asString(item.id)] = item;
        return [{
          type: "tool.started",
          call_id: asString(item.id),
          name: asString(item.type),
          input: item.type === "command_execution" ? { command: item.command } : item,
          native: item,
        }];
      }
      if (event.type === "item.completed" && toolTypes.has(item.type as string)) {
        delete pendingCommands[asString(item.id)];
        return [{
          type: "tool.completed",
          call_id: asString(item.id),
          name: asString(item.type),
          status: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0) ? "failed" : "succeeded",
          output: item.aggregated_output ?? item,
          native: item,
        }];
      }
      if (event.type === "turn.completed") {
        // Codex can finish while a long-lived server remains in progress. Close
        // the observation with an explicitly unknown outcome, never success.
        const detached = Object.entries(pendingCommands).map(([id, command]) => ({
          type: "tool.completed" as const, call_id: id, name: "command_execution", status: "unknown",
          output: "Codex turn ended without a command completion event; process outcome is unknown.",
          native: { ...command, hitch_observation: "open_at_turn_end" },
        }));
        for (const id of Object.keys(pendingCommands)) delete pendingCommands[id];
        return [...detached, ...(event.usage ? [{ type: "usage.updated" as const, usage: event.usage as Record<string, unknown> }] : [])];
      }
      if (event.type === "error") {
        return [{ type: "diagnostic", level: "error", message: asString(event.message) || "Codex error" }];
      }
      return [{ type: "provider.event", provider_type: (event.type as string) || "unknown", native: event }];
    },
};

async function localCodexProcess(
  request: import("../contract.js").AdapterRequest,
  executable: string,
  args: string[],
  runtime: import("../contract.js").AdapterProcessRuntime,
): Promise<import("../contract.js").ProcessSpecification> {
  const endpoint = runtime.model_endpoint;
  if (!endpoint) throw new Error("managed local model binding is missing");
  if (endpoint.api !== "responses") throw invalidInput("Codex external endpoint requires a Responses endpoint");
  const codexHome = await mkdtemp(path.join(tmpdir(), "hitch-codex-local-"));
  try {
    await chmod(codexHome, 0o700);
    await writeFile(path.join(codexHome, "config.toml"), localCodexConfig(endpoint), { mode: 0o600 });
  } catch (error) {
    await rm(codexHome, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    executable,
    args,
    input: request.prompt,
    env: {
      CODEX_HOME: codexHome,
      [endpoint.credential_env_name]: runtime.model_endpoint_credential as string,
    },
    cleanup: () => rm(codexHome, { recursive: true, force: true }),
  };
}

function localCodexConfig(endpoint: import("../../domain/index.js").ModelEndpointBindingV1): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    `model = ${quote(endpoint.wire_model)}`,
    'model_provider = "hitch_local"',
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    "",
    "[model_providers.hitch_local]",
    'name = "Hitch External Endpoint"',
    `base_url = ${quote(endpoint.base_url.replace(/\/+$/, ""))}`,
    `env_key = ${quote(endpoint.credential_env_name)}`,
    'wire_api = "responses"',
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "requires_openai_auth = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
  ].join("\n");
}
