import { homedir } from "node:os";
import path from "node:path";
import { invalidInput } from "./errors.js";

export const SCHEMA_VERSION = "1";
export const DEFAULT_PORT = 7463;
export const DEFAULT_MAX_CONCURRENT = 4;

export interface StatePaths {
  root: string;
  daemon: string;
  lock: string;
  token: string;
  log: string;
  errorLog: string;
  runs: string;
  evals: string;
  tools: string;
  store: string;
  artifacts: string;
  artifactIndex: string;
  sourceCache: string;
  artifactLocks: string;
  sourceLocks: string;
  workspaceLocks: string;
  controllerRuntimeLocks: string;
  controllerRuntimes: string;
  workspaces: string;
  temporary: string;
}

export function defaultRoot(): string {
  return path.resolve(process.env.HITCH_ROOT || path.join(homedir(), ".hitch"));
}

export function parseDuration(value: string | number | null | undefined): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw invalidInput(`invalid duration: ${value}`);
  const scale: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const unit = match[2] || "ms";
  return Math.round(Number(match[1]) * (scale[unit] ?? 1));
}

export function positiveInteger(value: string | number, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw invalidInput(`${name} must be a positive integer`);
  }
  return number;
}

export function statePaths(root: string): StatePaths {
  return {
    root,
    daemon: path.join(root, "daemon.json"),
    lock: path.join(root, "daemon.lock"),
    token: path.join(root, "daemon.token"),
    log: path.join(root, "daemon.log"),
    errorLog: path.join(root, "daemon.err.log"),
    runs: path.join(root, "runs"),
    evals: path.join(root, "evals"),
    tools: path.join(root, "tools"),
    store: path.join(root, "store"),
    artifacts: path.join(root, "store", "artifacts"),
    artifactIndex: path.join(root, "store", "refs"),
    sourceCache: path.join(root, "cache", "sources"),
    artifactLocks: path.join(root, "locks", "artifacts"),
    sourceLocks: path.join(root, "locks", "sources"),
    workspaceLocks: path.join(root, "locks", "workspaces"),
    controllerRuntimeLocks: path.join(root, "locks", "controller-runtimes"),
    controllerRuntimes: path.join(root, "store", "controller-runtimes", "sha256"),
    workspaces: path.join(root, "workspaces"),
    temporary: path.join(root, "tmp"),
  };
}
