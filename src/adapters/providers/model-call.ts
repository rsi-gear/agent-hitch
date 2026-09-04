import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterDefinition } from "../contract.js";
import { sha256Bytes, invalidInput, packageRoot } from "../../foundation/index.js";

export const modelCallAdapter: AdapterDefinition = {
  id: "model-call", display_name: "Hitch single model request", command: "hitch-model-call", path_env: "HITCH_MODEL_CALL_PATH", version_args: ["--version"],
  revision_sources: { commit: { type: "git", url: "https://github.com/rsi-gear/agent-hitch.git", commands: [], entrypoint: "integrations/model-call/cli.js" } },
  capabilities: { non_interactive: true, streaming: false, structured_messages: true, structured_tool_events: false, sessions: false, resume: false, model_selection: true, graceful_cancel: true },
  requirements: { network: "required", credential_names: ["OPENAI_API_KEY"], endpoint_override: "supported", capture: { native_events: true, native_session: false, model_proxy_compatible: true } },
  async process(request, executable, runtime = {}) {
    if (request.agent_args.length) throw invalidInput("model-call does not accept agent arguments or tool overrides");
    // An arbitrary custom Git revision cannot claim the no-tools capability.
    const approved = sha256Bytes(await readFile(path.join(packageRoot(), "integrations/model-call/cli.js")));
    if (runtime.entrypoint_integrity !== approved) throw invalidInput("model-call runner differs from the trusted implementation in this Hitch runtime");
    const endpoint = runtime.model_endpoint;
    if (endpoint && !runtime.model_endpoint_credential) throw invalidInput("managed local model binding is incomplete");
    if (endpoint && endpoint.api !== "responses") throw invalidInput("model-call local inference requires a Responses endpoint");
    return {
      executable,
      args: ["--model", endpoint?.wire_model ?? request.model],
      input: request.prompt,
      ...(endpoint ? { env: {
        HITCH_LOCAL_MODEL_BASE_URL: endpoint.base_url,
        HITCH_LOCAL_MODEL_TOKEN: runtime.model_endpoint_credential as string,
        ...(Number.isSafeInteger(runtime.model_endpoint_max_output_tokens)
          ? { HITCH_LOCAL_MAX_OUTPUT_TOKENS: String(runtime.model_endpoint_max_output_tokens) }
          : {}),
      } } : {}),
    };
  },
  translate(event) {
    if (event.type === "message.completed" && typeof event.text === "string") return [{ type: "message.completed", text: event.text }];
    if (event.type === "usage.updated" && event.usage && typeof event.usage === "object") return [{ type: "usage.updated", usage: event.usage as Record<string, unknown> }];
    return [{ type: "provider.event", provider_type: String(event.type), native: event }];
  },
};
