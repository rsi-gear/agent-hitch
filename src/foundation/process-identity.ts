import { spawn } from "node:child_process";
import { sha256JSON } from "./hash.js";

export interface ProcessIdentityV1 {
  pid: number;
  start_identity: `sha256:${string}`;
  observed_at: string;
}

export type ProcessIdentityStatus = "running" | "terminal" | "identity-mismatch" | "unavailable";

export async function captureProcessIdentity(pid: number): Promise<ProcessIdentityV1 | null> {
  const snapshot = await processSnapshot(pid);
  if (!snapshot || snapshot === "unavailable" || terminalState(snapshot.state)) return null;
  return {
    pid,
    start_identity: sha256JSON({ pid, started: snapshot.started, command: snapshot.command }),
    observed_at: new Date().toISOString(),
  };
}

export async function inspectProcessIdentity(identity: ProcessIdentityV1): Promise<ProcessIdentityStatus> {
  validateProcessIdentity(identity);
  const snapshot = await processSnapshot(identity.pid);
  if (snapshot === "unavailable") return "unavailable";
  if (!snapshot) return "terminal";
  const current = sha256JSON({ pid: identity.pid, started: snapshot.started, command: snapshot.command });
  if (current !== identity.start_identity) return "identity-mismatch";
  return terminalState(snapshot.state) ? "terminal" : "running";
}

export function validateProcessIdentity(value: unknown): ProcessIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("process identity must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !new Set(["pid", "start_identity", "observed_at"]).has(key))
    || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
    || typeof record.start_identity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.start_identity)
    || typeof record.observed_at !== "string" || !Number.isFinite(Date.parse(record.observed_at))) {
    throw new TypeError("process identity is invalid");
  }
  return record as unknown as ProcessIdentityV1;
}

async function processSnapshot(pid: number): Promise<{ started: string; command: string; state: string } | null | "unavailable"> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("process pid must be a positive safe integer");
  if (process.platform === "win32") return "unavailable";
  const output = await runPs(pid);
  if (output.code === 1 && output.stdout.trim() === "" && output.stderr.trim() === "") return null;
  if (output.code !== 0) return "unavailable";
  const fields = output.stdout.trim().split(/\s+/);
  if (fields.length < 7) return "unavailable";
  const state = fields.at(-1) as string;
  const command = fields.at(-2) as string;
  const started = fields.slice(0, -2).join(" ");
  return started && command && state ? { started, command, state } : "unavailable";
}

function runPs(pid: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/ps", ["-o", "lstart=", "-o", "comm=", "-o", "stat=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_192); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192); });
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "process observation failed" }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function terminalState(state: string): boolean {
  return state.startsWith("Z") || state.startsWith("X");
}
