import path from "node:path";
import { HitchError } from "./errors.js";

const definitions = {
  codex: {
    id: "codex",
    display_name: "Codex CLI",
    command: "codex",
    path_env: "HITCH_CODEX_PATH",
    version_args: ["--version"],
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
      const args = ["exec", "--json", "--ephemeral", "--color", "never", "-C", request.cwd];
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args, "-");
      return { executable, args, input: request.prompt };
    },
    translate(event) {
      if (event.type === "thread.started") {
        return [{ type: "session.created", session_id: event.thread_id }];
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        return [{ type: "message.delta", text: event.item.text || "" }];
      }
      const toolTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
      if (event.type === "item.started" && toolTypes.has(event.item?.type)) {
        return [{
          type: "tool.started",
          call_id: event.item.id,
          name: event.item.type,
          native: event.item,
        }];
      }
      if (event.type === "item.completed" && toolTypes.has(event.item?.type)) {
        return [{
          type: "tool.completed",
          call_id: event.item.id,
          name: event.item.type,
          status: event.item.status || "completed",
          native: event.item,
        }];
      }
      if (event.type === "turn.completed" && event.usage) {
        return [{ type: "usage.updated", usage: event.usage }];
      }
      if (event.type === "error") {
        return [{ type: "diagnostic", level: "error", message: event.message || "Codex error" }];
      }
      return [{ type: "provider.event", provider_type: event.type || "unknown", native: event }];
    },
  },
  claude: {
    id: "claude",
    display_name: "Claude Code",
    command: "claude",
    path_env: "HITCH_CLAUDE_PATH",
    version_args: ["--version"],
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
        return [{ type: "session.created", session_id: event.session_id }];
      }
      if (event.type === "assistant") {
        const content = event.message?.content || [];
        return content.flatMap((block) => {
          if (block.type === "text") return [{ type: "message.delta", text: block.text || "" }];
          if (block.type === "tool_use") {
            return [{ type: "tool.started", call_id: block.id, name: block.name, input: block.input }];
          }
          return [];
        });
      }
      if (event.type === "user") {
        const content = event.message?.content || [];
        return content.flatMap((block) => {
          if (block.type !== "tool_result") return [];
          return [{
            type: "tool.completed",
            call_id: block.tool_use_id,
            status: block.is_error ? "failed" : "succeeded",
            output: claudeToolResultText(block.content),
          }];
        });
      }
      if (event.type === "result") {
        const translated = [];
        if (typeof event.result === "string") translated.push({ type: "message.completed", text: event.result });
        if (event.usage) translated.push({ type: "usage.updated", usage: event.usage });
        return translated;
      }
      return [{ type: "provider.event", provider_type: event.type || "unknown", native: event }];
    },
  },
};

export function listDefinitions() {
  return Object.values(definitions).map(publicDefinition);
}

function claudeToolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (block?.type === "text") return block.text || "";
    return JSON.stringify(block);
  }).join("");
}

export function getAdapter(id) {
  const adapter = definitions[id];
  if (!adapter) {
    throw new HitchError(`unknown agent: ${id}`, { code: "agent_not_found", exitCode: 3 });
  }
  return adapter;
}

export function publicDefinition(definition) {
  return {
    id: definition.id,
    display_name: definition.display_name,
    command: definition.command,
    path_env: definition.path_env,
    capabilities: definition.capabilities,
  };
}

export function normalizeRequest(input) {
  const cwd = path.resolve(typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  return {
    agent: typeof input?.agent === "string" ? input.agent.trim() : "",
    model: typeof input?.model === "string" ? input.model : "",
    cwd,
    prompt: typeof input?.prompt === "string" ? input.prompt : "",
    timeout_ms: input?.timeout_ms ?? 0,
    agent_args: Array.isArray(input?.agent_args) ? [...input.agent_args] : [],
  };
}
