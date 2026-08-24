import type { AdapterDefinition, NormalizedEvent } from "../contract.js";
import { asString, openCodeErrorMessage } from "./shared.js";

export const opencodeAdapter: AdapterDefinition = {
    id: "opencode",
    display_name: "OpenCode",
    command: "opencode",
    path_env: "HITCH_OPENCODE_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: { type: "npm", package: "opencode-ai", bin: "opencode" },
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
      const args = ["run", "--format", "json", "--dir", request.cwd];
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args);
      return { executable, args, input: request.prompt };
    },
    translate(event, state = {}) {
      const translated: NormalizedEvent[] = [];
      if (event.sessionID && state.session_id !== event.sessionID) {
        state.session_id = event.sessionID;
        translated.push({ type: "session.created", session_id: asString(event.sessionID) });
      }
      if (event.type === "text") {
        const part = (event.part || {}) as Record<string, unknown>;
        translated.push({
          type: "message.delta",
          text: typeof part.text === "string" ? part.text : (asString(event.text) ?? ""),
        });
        return translated;
      }
      if (event.type === "tool_use" && event.part) {
        const part = (event.part || {}) as Record<string, unknown>;
        const partState = (part.state || {}) as Record<string, unknown>;
        const failed = partState.status === "error";
        translated.push({
          type: "tool.completed",
          call_id: asString(part.callID ?? part.id),
          name: asString(part.tool),
          status: failed ? "failed" : "succeeded",
          input: partState.input,
          output: failed ? partState.error : partState.output,
          native: part,
        });
        return translated;
      }
      if (event.type === "step_finish" && (event.part as Record<string, unknown>)?.tokens) {
        const part = event.part as Record<string, unknown>;
        translated.push({
          type: "usage.updated",
          usage: { ...(part.tokens as Record<string, unknown>), cost: part.cost },
        });
        return translated;
      }
      if (event.type === "error") {
        translated.push({ type: "diagnostic", level: "error", message: openCodeErrorMessage(event.error) });
        return translated;
      }
      translated.push({ type: "provider.event", provider_type: (event.type as string) || "unknown", native: event });
      return translated;
    },
};
