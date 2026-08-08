import { homedir } from "node:os";
import path from "node:path";
import { invalidInput } from "./errors.js";

export const SCHEMA_VERSION = "1";
export const DEFAULT_PORT = 7463;
export const DEFAULT_MAX_CONCURRENT = 4;

export function defaultRoot() {
  return path.resolve(process.env.HITCH_ROOT || path.join(homedir(), ".hitch"));
}

export function parseDuration(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw invalidInput(`invalid duration: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] || "ms"];
  return Math.round(Number(match[1]) * scale);
}

export function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw invalidInput(`${name} must be a positive integer`);
  }
  return number;
}

export function statePaths(root) {
  return {
    root,
    daemon: path.join(root, "daemon.json"),
    lock: path.join(root, "daemon.lock"),
    token: path.join(root, "daemon.token"),
    log: path.join(root, "daemon.log"),
    errorLog: path.join(root, "daemon.err.log"),
    runs: path.join(root, "runs"),
    store: path.join(root, "store"),
    artifacts: path.join(root, "store", "artifacts"),
    artifactIndex: path.join(root, "store", "refs"),
    sourceCache: path.join(root, "cache", "sources"),
    artifactLocks: path.join(root, "locks", "artifacts"),
    sourceLocks: path.join(root, "locks", "sources"),
    workspaceLocks: path.join(root, "locks", "workspaces"),
    workspaces: path.join(root, "workspaces"),
    temporary: path.join(root, "tmp"),
  };
}
