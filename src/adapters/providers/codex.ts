import type { AdapterDefinition } from "../contract.js";
import { asString, codexSupportsEphemeral } from "./shared.js";
import { codexContainerAuth } from "./codex-auth.js";

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
