import type { AdapterDefinition, NormalizedEvent } from "../contract.js";
import { asString, claudeToolResultText } from "./shared.js";

export const claudeAdapter: AdapterDefinition = {
    id: "claude",
    display_name: "Claude Code",
    command: "claude",
    path_env: "HITCH_CLAUDE_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: { type: "npm", package: "@anthropic-ai/claude-code", bin: "claude" },
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
    process(request, executable) {
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args);
      return { executable, args, input: request.prompt };
    },
    translate(event) {
      if (event.type === "system" && event.session_id) {
        return [{ type: "session.created", session_id: asString(event.session_id) }];
      }
      if (event.type === "assistant") {
        const content = ((event.message as Record<string, unknown>)?.content as unknown[]) || [];
        return content.flatMap((block): NormalizedEvent[] => {
          const item = block as Record<string, unknown>;
          if (item.type === "text") return [{ type: "message.delta", text: asString(item.text) }];
          if (item.type === "tool_use") {
            return [{ type: "tool.started", call_id: asString(item.id), name: asString(item.name), input: item.input }];
          }
          return [];
        });
      }
      if (event.type === "user") {
        const content = ((event.message as Record<string, unknown>)?.content as unknown[]) || [];
        return content.flatMap((block): NormalizedEvent[] => {
          const item = block as Record<string, unknown>;
          if (item.type !== "tool_result") return [];
          return [{
            type: "tool.completed",
            call_id: asString(item.tool_use_id),
            status: item.is_error ? "failed" : "succeeded",
            output: claudeToolResultText(item.content),
          }];
        });
      }
      if (event.type === "result") {
        const translated: NormalizedEvent[] = [];
        if (typeof event.result === "string") translated.push({ type: "message.completed", text: event.result });
        if (event.usage) translated.push({ type: "usage.updated", usage: event.usage as Record<string, unknown> });
        return translated;
      }
      return [{ type: "provider.event", provider_type: (event.type as string) || "unknown", native: event }];
    },
};
