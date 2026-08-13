import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HitchError } from "./errors.js";

const definitions = {
  codex: {
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
  pi: {
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
    process(request, executable) {
      const args = ["--mode", "json", "--no-session"];
      if (request.model) args.push("--model", request.model);
      args.push(...request.agent_args);
      return { executable, args, input: request.prompt };
    },
    translate(event) {
      if (event.type === "session" && event.id) {
        return [{ type: "session.created", session_id: event.id }];
      }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        return [{ type: "message.delta", text: event.assistantMessageEvent.delta || "" }];
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const translated = [{ type: "message.completed", text: assistantMessageText(event.message) }];
        if (event.message.usage) translated.push({ type: "usage.updated", usage: event.message.usage });
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          translated.push({
            type: "diagnostic",
            level: "error",
            message: event.message.errorMessage || `Pi request ${event.message.stopReason}`,
          });
        }
        return translated;
      }
      if (event.type === "tool_execution_start") {
        return [{
          type: "tool.started",
          call_id: event.toolCallId,
          name: event.toolName,
          input: event.args,
        }];
      }
      if (event.type === "tool_execution_end") {
        return [{
          type: "tool.completed",
          call_id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? "failed" : "succeeded",
          output: event.result,
        }];
      }
      return [{ type: "provider.event", provider_type: event.type || "unknown", native: event }];
    },
  },
  opencode: {
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
      const translated = [];
      if (event.sessionID && state.session_id !== event.sessionID) {
        state.session_id = event.sessionID;
        translated.push({ type: "session.created", session_id: event.sessionID });
      }
      if (event.type === "text") {
        translated.push({
          type: "message.delta",
          text: typeof event.part?.text === "string" ? event.part.text : event.text || "",
        });
        return translated;
      }
      if (event.type === "tool_use" && event.part) {
        const failed = event.part.state?.status === "error";
        translated.push({
          type: "tool.completed",
          call_id: event.part.callID || event.part.id,
          name: event.part.tool,
          status: failed ? "failed" : "succeeded",
          input: event.part.state?.input,
          output: failed ? event.part.state?.error : event.part.state?.output,
          native: event.part,
        });
        return translated;
      }
      if (event.type === "step_finish" && event.part?.tokens) {
        translated.push({
          type: "usage.updated",
          usage: { ...event.part.tokens, cost: event.part.cost },
        });
        return translated;
      }
      if (event.type === "error") {
        translated.push({ type: "diagnostic", level: "error", message: openCodeErrorMessage(event.error) });
        return translated;
      }
      translated.push({ type: "provider.event", provider_type: event.type || "unknown", native: event });
      return translated;
    },
  },
  deepseek: {
    id: "deepseek",
    display_name: "DeepSeek Harness",
    command: "dsh",
    path_env: "HITCH_DEEPSEEK_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: { type: "npm", package: "@deepseek-ai/dsh", bin: "dsh" },
      commit: {
        type: "git",
        url: "https://github.com/deepseek-ai/deepseek-harness.git",
        commands: [
          { executable: "pnpm", args: ["install", "--frozen-lockfile"] },
          { executable: "pnpm", args: ["run", "build"] },
        ],
        entrypoint: "apps/cli/lib/bin.js",
      },
    },
    capabilities: {
      non_interactive: true,
      streaming: false,
      structured_messages: false,
      structured_tool_events: false,
      sessions: false,
      resume: false,
      model_selection: true,
      graceful_cancel: true,
    },
    async process(request, executable, runtime = {}) {
      const args = ["--profile", "headless", ...request.agent_args];
      if (request.model) {
        const patchFile = await writeDeepseekModelPatch(request.model, runtime.run_directory);
        args.push("--patch", patchFile);
      }
      args.push(request.prompt);
      return {
        executable,
        args,
        input: "",
        env: runtime.runtime_home ? { DSH_HOME: runtime.runtime_home } : {},
      };
    },
    translateLine(line, state = {}) {
      const text = state.has_stdout_line ? `\n${line}` : line;
      state.has_stdout_line = true;
      return [{ type: "message.delta", text }];
    },
  },
};

function codexSupportsEphemeral(observedVersion) {
  const match = String(observedVersion || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 0 || minor >= 99;
}

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

function assistantMessageText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function openCodeErrorMessage(error) {
  if (typeof error === "string") return error;
  if (typeof error?.data?.message === "string") return error.data.message;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.name === "string") return error.name;
  return error == null ? "OpenCode error" : JSON.stringify(error);
}

async function writeDeepseekModelPatch(value, runDirectory) {
  if (!runDirectory) {
    throw new HitchError("DeepSeek model selection requires an isolated run directory", {
      code: "adapter_setup_failed",
      exitCode: 6,
    });
  }
  const separator = value.indexOf("/");
  const provider = separator < 0 ? "deepseek-official" : value.slice(0, separator);
  const model = separator < 0 ? value : value.slice(separator + 1);
  if (!provider || !model) {
    throw new HitchError(`invalid DeepSeek model selector: ${value}`, {
      code: "invalid_input",
      exitCode: 2,
    });
  }
  const file = path.join(runDirectory, "config", "deepseek-model.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify([{
    id: "agent-default-model",
    config: { provider, model },
  }], null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function getAdapter(id) {
  const adapter = definitions[id];
  if (!adapter) {
    throw new HitchError(`unknown harness: ${id}`, { code: "harness_not_found", exitCode: 3 });
  }
  return adapter;
}

export function publicDefinition(definition) {
  const revisionSources = definition.revision_sources || {};
  return {
    id: definition.id,
    display_name: definition.display_name,
    command: definition.command,
    path_env: definition.path_env,
    capabilities: definition.capabilities,
    revision_selectors: ["installed", ...Object.keys(revisionSources)],
    revision_sources: Object.fromEntries(Object.entries(revisionSources).map(([selector, source]) => [
      selector,
      {
        type: source.type,
        ...(source.package ? { package: source.package } : {}),
        ...(source.packages ? { packages: source.packages } : {}),
        ...(source.url ? { url: source.url } : {}),
      },
    ])),
  };
}

export function normalizeRequest(input) {
  const cwd = path.resolve(typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  const harnessRef = typeof input?.harness_ref === "string"
    ? input.harness_ref.trim()
    : typeof input?.agent === "string" && input.agent.trim()
      ? `${input.agent.trim()}@installed`
      : "";
  return {
    harness_ref: harnessRef,
    model: typeof input?.model === "string" ? input.model : "",
    cwd,
    workspace_mode: typeof input?.workspace_mode === "string" ? input.workspace_mode : "shared",
    prompt: typeof input?.prompt === "string" ? input.prompt : "",
    timeout_ms: input?.timeout_ms ?? 0,
    agent_args: Array.isArray(input?.agent_args) ? [...input.agent_args] : [],
  };
}
