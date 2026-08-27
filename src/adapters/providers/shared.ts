import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HitchError } from "../../foundation/index.js";

const DEEPSEEK_HEADLESS_STARTUP_PLUGIN = `export const name = "hitch-headless-startup";
export const inject = ["cmdlineArgs"];

export function apply(ctx, config = {}) {
  const cmdlineArgs = ctx.get("cmdlineArgs");
  if (cmdlineArgs === undefined) throw new Error("hitch-headless-startup: cmdlineArgs is unavailable");
  let task = cmdlineArgs.get().join(" ");
  if (config.unescapeLeadingLineBreak === true) {
    if (!task.startsWith("\\n-")) throw new Error("hitch-headless-startup: escaped task marker is missing");
    task = task.slice(1);
  }
  if (task.trim() === "") throw new Error("hitch-headless-startup: a task is required");
  ctx.provide("headlessStartup", { task });
}
`;

export function codexSupportsEphemeral(observedVersion: string | undefined): boolean {
  const match = String(observedVersion || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 99;
}

export function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    const item = block as Record<string, unknown>;
    if (item?.type === "text") return (item.text as string) || "";
    return JSON.stringify(block);
  }).join("");
}

export function assistantMessageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message?.content)) return "";
  return (message.content as unknown[])
    .filter((block) => (block as Record<string, unknown>)?.type === "text")
    .map((block) => ((block as Record<string, unknown>).text as string) || "")
    .join("");
}

export function openCodeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  const item = (error || {}) as Record<string, unknown>;
  const data = (item.data || {}) as Record<string, unknown>;
  if (typeof data?.message === "string") return data.message;
  if (typeof item?.message === "string") return item.message;
  if (typeof item?.name === "string") return item.name;
  return error == null ? "OpenCode error" : JSON.stringify(error);
}

export async function writeDeepseekRuntimePatch(
  value: string,
  runDirectory: string | undefined,
  runtimeHome: string | undefined,
  unescapeOptionLikePrompt = false,
): Promise<string> {
  if (!runDirectory || !runtimeHome) {
    throw new HitchError("DeepSeek session capture requires an isolated run directory", {
      code: "adapter_setup_failed",
      exitCode: 6,
    });
  }
  const configDirectory = path.join(runDirectory, "config");
  await mkdir(configDirectory, { recursive: true });
  const rows: Array<Record<string, unknown>> = [{
    id: "session-persistence-jsonl",
    config: {
      root: path.join(runtimeHome, "sessions"),
      compression: "none",
      packChunks: false,
    },
  }];
  if (value) {
    const separator = value.indexOf("/");
    const provider = separator < 0 ? "deepseek-official" : value.slice(0, separator);
    const model = separator < 0 ? value : value.slice(separator + 1);
    if (!provider || !model) {
      throw new HitchError(`invalid DeepSeek model selector: ${value}`, {
        code: "invalid_input",
        exitCode: 2,
      });
    }
    rows.push({ id: "agent-default-model", config: { provider, model } });
  }
  if (unescapeOptionLikePrompt) {
    const startupPlugin = path.join(configDirectory, "deepseek-headless-startup.mjs");
    await writeFile(startupPlugin, DEEPSEEK_HEADLESS_STARTUP_PLUGIN, { mode: 0o600 });
    rows.push(
      { id: "headless-startup", disabled: true },
      {
        insert: [{
          id: "hitch-headless-startup",
          name: pathToFileURL(startupPlugin).href,
          inject: ["cmdlineArgs"],
          config: { unescapeLeadingLineBreak: true },
        }],
      },
    );
  }
  const file = path.join(configDirectory, "deepseek-runtime.json");
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
