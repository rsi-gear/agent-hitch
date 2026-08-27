import type { AdapterDefinition } from "../contract.js";
import { writeDeepseekRuntimePatch } from "./shared.js";

export const deepseekAdapter: AdapterDefinition = {
    id: "deepseek",
    display_name: "DeepSeek Harness",
    command: "dsh",
    path_env: "HITCH_DEEPSEEK_PATH",
    version_args: ["--version"],
    revision_sources: {
      version: { type: "npm", package: "@deepseek-ai/dsh", bin: "dsh", install_mode: "global" },
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
      // Headless stdout is only the final text, but DSH persists the complete
      // structured session before the process exits. The engine imports that
      // native session after exit rather than treating stdout as the trace.
      structured_messages: true,
      structured_tool_events: true,
      sessions: true,
      resume: false,
      model_selection: true,
      graceful_cancel: true,
    },
    async process(request, executable, runtime = {}) {
      const args = ["--profile", "headless", ...request.agent_args];
      const patchFile = await writeDeepseekRuntimePatch(request.model, runtime.run_directory, runtime.runtime_home);
      args.push("--patch", patchFile);
      // DSH parses argv once in the launcher and again in the headless app.
      // Each parser consumes one terminator, leaving the prompt byte-exact.
      args.push("--", "--", request.prompt);
      return {
        executable,
        args,
        input: "",
        ...(runtime.runtime_home ? { env: { DSH_HOME: runtime.runtime_home } } : {}),
      };
    },
    translateLine(line, state) {
      const text = state.has_stdout_line ? `\n${line}` : line;
      state.has_stdout_line = true;
      return [{ type: "message.delta", text }];
    },
};
