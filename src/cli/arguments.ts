import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MAX_CONCURRENT, invalidInput, parseDuration, positiveInteger } from "../foundation/index.js";
import type { RunRequestInput } from "../runs/index.js";
import { WORKSPACE_MODES } from "../workspaces/index.js";

export async function parseRunRequest(args: string[]): Promise<RunRequestInput> {
  const harness = takeOption(args, "--harness");
  const agent = takeOption(args, "--agent");
  const model = takeOption(args, "--model") || "";
  const cwd = takeOption(args, "--cwd") || process.cwd();
  const workspaceMode = takeOption(args, "--workspace-mode") || "shared";
  const promptValue = takeOption(args, "--prompt");
  const promptFile = takeOption(args, "--prompt-file");
  const timeout = parseDuration(takeOption(args, "--timeout") || "0");
  const agentArgs = takeRepeatedOption(args, "--agent-arg");
  const contextFile = takeOption(args, "--context-file");
  const parentFile = takeOption(args, "--parent-file");
  const modelIdentityFile = takeOption(args, "--model-identity-file");
  const protocolIdentityFile = takeOption(args, "--protocol-identity-file");
  if (harness && agent) throw invalidInput("use only one of --harness and the legacy --agent option");
  if (!harness && !agent) throw invalidInput("--harness is required");
  if (!WORKSPACE_MODES.has(workspaceMode)) throw invalidInput(`--workspace-mode must be one of: ${[...WORKSPACE_MODES].join(", ")}`);
  if (agent?.includes("@")) throw invalidInput("--agent accepts only a harness name; use --harness for revision selection");
  if (promptValue !== undefined && promptFile) throw invalidInput("use only one of --prompt and --prompt-file");
  let prompt = promptValue;
  if (promptFile) prompt = await readFile(path.resolve(promptFile), "utf8");
  if (prompt === undefined && !process.stdin.isTTY) prompt = readFileSync(0, "utf8");
  if (!prompt) throw invalidInput("provide --prompt, --prompt-file, or stdin");
  const loadInputFile = async (file: string | undefined, label: string): Promise<unknown | undefined> => {
    if (!file) return undefined;
    try {
      return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown;
    } catch (error) {
      throw invalidInput(`${label} is not readable JSON: ${(error as Error).message}`, { cause: error });
    }
  };
  const context = await loadInputFile(contextFile, "--context-file");
  const parent = await loadInputFile(parentFile, "--parent-file");
  const modelIdentity = await loadInputFile(modelIdentityFile, "--model-identity-file");
  const protocolIdentity = await loadInputFile(protocolIdentityFile, "--protocol-identity-file");
  return {
    harness_ref: harness || `${agent}@installed`,
    model,
    cwd,
    workspace_mode: workspaceMode,
    prompt,
    timeout_ms: timeout,
    agent_args: agentArgs,
    ...(context !== undefined ? { context } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(modelIdentity !== undefined ? { model_identity: modelIdentity } : {}),
    ...(protocolIdentity !== undefined ? { protocol_identity: protocolIdentity } : {}),
  };
}

export function parseEvalRequest(args: string[]): Record<string, unknown> {
  const backend = takeOption(args, "--backend") || "harbor";
  const dataset = takeOption(args, "--dataset");
  const harness = takeOption(args, "--harness");
  const model = takeOption(args, "--model") || "";
  const attempts = positiveInteger(takeOption(args, "--attempts") || 1, "--attempts");
  const maxConcurrent = positiveInteger(takeOption(args, "--max-concurrent") || DEFAULT_MAX_CONCURRENT, "--max-concurrent");
  const timeoutValue = takeOption(args, "--timeout");
  const setupTimeoutValue = takeOption(args, "--setup-timeout");
  const agentArgs = takeRepeatedOption(args, "--agent-arg");
  const passEnv = takeRepeatedOption(args, "--pass-env");
  if (!dataset) throw invalidInput("--dataset is required");
  if (!harness) throw invalidInput("--harness is required");
  return {
    backend,
    dataset,
    harness_ref: harness,
    model,
    attempts,
    max_concurrent: maxConcurrent,
    timeout_ms: timeoutValue === undefined ? undefined : parseDuration(timeoutValue),
    setup_timeout_ms: setupTimeoutValue === undefined ? undefined : parseDuration(setupTimeoutValue),
    agent_args: agentArgs,
    pass_env: passEnv,
  };
}

export function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index === args.length - 1) throw invalidInput(`${name} requires a value`);
  const [value] = args.splice(index + 1, 1);
  args.splice(index, 1);
  return value;
}

export function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

export function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw invalidInput(`unexpected argument: ${args[0]}`);
}
