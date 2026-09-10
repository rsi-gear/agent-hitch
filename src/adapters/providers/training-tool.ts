import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterDefinition } from "../contract.js";
import { invalidInput, packageRoot, sha256Bytes } from "../../foundation/index.js";

export const trainingToolAdapter: AdapterDefinition = {
  id: "training-tool", display_name: "Hitch linear training tool harness", command: "hitch-training-tool", path_env: "HITCH_TRAINING_TOOL_PATH", version_args: ["--version"],
  revision_sources: { commit: { type: "git", url: "https://github.com/rsi-gear/agent-hitch.git", commands: [], entrypoint: "integrations/training-tool/cli.js" } },
  capabilities: { non_interactive: true, streaming: false, structured_messages: true, structured_tool_events: true, sessions: false, resume: false, model_selection: true, graceful_cancel: true },
  requirements: { network: "required", credential_names: ["OPENAI_API_KEY"], endpoint_override: "supported", capture: { native_events: true, native_session: false, model_proxy_compatible: true } },
  async process(request, executable, runtime = {}) {
    if (request.agent_args.length) throw invalidInput("training-tool does not accept harness overrides");
    const approved = sha256Bytes(await readFile(path.join(packageRoot(), "integrations/training-tool/cli.js")));
    if (runtime.entrypoint_integrity !== approved) throw invalidInput("training-tool runner differs from this Hitch runtime's tested implementation");
    return { executable, args: ["--model", request.model], input: request.prompt,
      ...(runtime.model_endpoint ? { env: { OPENAI_BASE_URL: runtime.model_endpoint.base_url,
        OPENAI_API_KEY: runtime.model_endpoint_credential as string,
        ...(runtime.model_endpoint_max_output_tokens ? { HITCH_LOCAL_MAX_OUTPUT_TOKENS: String(runtime.model_endpoint_max_output_tokens) } : {}) } }
        : process.env.HITCH_TRAINING_EXTERNAL === "1" ? { env: { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL as string, OPENAI_API_KEY: "hitch-training-external" } } : {}) };
  },
  translate(event) {
    if (event.type === "message.completed" && typeof event.text === "string") return [{ type: "message.completed", text: event.text }];
    if (event.type === "usage.updated" && event.usage && typeof event.usage === "object") return [{ type: "usage.updated", usage: event.usage as Record<string, unknown> }];
    return [{ type: "provider.event", provider_type: String(event.type), native: event }];
  },
};
