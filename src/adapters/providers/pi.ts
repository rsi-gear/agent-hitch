import type { AdapterDefinition, NormalizedEvent } from "../contract.js";
import { asString, assistantMessageText } from "./shared.js";

export const piAdapter: AdapterDefinition = {
    id: "pi",
    display_name: "Pi Coding Agent",
    command: "pi",
    path_env: "HITCH_PI_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: {
        type: "npm",
        packages: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
        bin: "pi",
      },
      commit: {
        type: "git",
        url: "https://github.com/earendil-works/pi.git",
        commands: [
          { executable: "npm", args: ["ci", "--ignore-scripts"] },
          { executable: "npm", args: ["run", "build"] },
        ],
        entrypoint: "packages/coding-agent/dist/cli.js",
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
      credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      endpoint_override: "unknown",
      capture: { native_events: true, native_session: true, model_proxy_compatible: false },
    },
    process(request, executable) {
      const args = ["--mode", "json", "--no-session"];
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args);
      return { executable, args, input: request.prompt };
    },
    translate(event) {
      if (event.type === "session" && event.id) {
        return [{ type: "session.created", session_id: asString(event.id) }];
      }
      if (event.type === "message_update" && (event.assistantMessageEvent as Record<string, unknown>)?.type === "text_delta") {
        return [{ type: "message.delta", text: asString((event.assistantMessageEvent as Record<string, unknown>).delta) }];
      }
      if (event.type === "message_end" && (event.message as Record<string, unknown>)?.role === "assistant") {
        const message = (event.message || {}) as Record<string, unknown>;
        const translated: NormalizedEvent[] = [{ type: "message.completed", text: assistantMessageText(message) }];
        if (message.usage) translated.push({ type: "usage.updated", usage: message.usage as Record<string, unknown> });
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          translated.push({
            type: "diagnostic",
            level: "error",
            message: asString(message.errorMessage) || `Pi request ${String(message.stopReason)}`,
          });
        }
        return translated;
      }
      if (event.type === "tool_execution_start") {
        return [{
          type: "tool.started",
          call_id: asString(event.toolCallId),
          name: asString(event.toolName),
          input: event.args,
        }];
      }
      if (event.type === "tool_execution_end") {
        return [{
          type: "tool.completed",
          call_id: asString(event.toolCallId),
          name: asString(event.toolName),
          status: event.isError ? "failed" : "succeeded",
          output: event.result,
        }];
      }
      return [{ type: "provider.event", provider_type: (event.type as string) || "unknown", native: event }];
    },
};
