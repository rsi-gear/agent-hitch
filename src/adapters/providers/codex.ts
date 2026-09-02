import type { AdapterDefinition } from "../contract.js";
import { asString, codexSupportsEphemeral } from "./shared.js";

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
      const args = ["exec", "--json"];
      if (codexSupportsEphemeral(runtime.observed_version)) args.push("--ephemeral");
      args.push("--skip-git-repo-check", "--color", "never", "-C", request.cwd);
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args, "-");
      return { executable, args, input: request.prompt };
    },
    translate(event) {
      if (event.type === "thread.started") {
        return [{ type: "session.created", session_id: asString(event.thread_id) }];
      }
      if (event.type === "item.completed" && (event.item as Record<string, unknown>)?.type === "agent_message") {
        return [{ type: "message.delta", text: asString((event.item as Record<string, unknown>).text) }];
      }
      const toolTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
      const item = (event.item || {}) as Record<string, unknown>;
      if (event.type === "item.started" && toolTypes.has(item.type as string)) {
        return [{
          type: "tool.started",
          call_id: asString(item.id),
          name: asString(item.type),
          native: item,
        }];
      }
      if (event.type === "item.completed" && toolTypes.has(item.type as string)) {
        return [{
          type: "tool.completed",
          call_id: asString(item.id),
          name: asString(item.type),
          status: (item.status as string) || "completed",
          native: item,
        }];
      }
      if (event.type === "turn.completed" && event.usage) {
        return [{ type: "usage.updated", usage: event.usage as Record<string, unknown> }];
      }
      if (event.type === "error") {
        return [{ type: "diagnostic", level: "error", message: asString(event.message) || "Codex error" }];
      }
      return [{ type: "provider.event", provider_type: (event.type as string) || "unknown", native: event }];
    },
};
