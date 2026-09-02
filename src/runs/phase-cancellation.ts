import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

const MAX_BYTES = 4096;
const REASONS = new Set(["native_phase_reset", "native_task_finished", "task_budget_expired", "cancelled"]);

async function boundedJSON(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || info.mode & 0o077) {
      throw new TypeError("phase control input must be a private bounded regular file");
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new TypeError("phase control input is too large");
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new TypeError("phase control input is not valid JSON"); }
  } finally {
    await handle.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid phase control envelope");
  return value as Record<string, unknown>;
}

async function canonicalFuturePath(value: string): Promise<string> {
  let existing = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(existing), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(existing) === existing) throw error;
      missing.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

/** Internal cancellation transport; it neither signals PIDs nor claims native completion. */
export async function monitorPhaseCancellation(input: {
  configurationPath: string;
  expectedRunId: string;
  runsRoot: string;
}): Promise<{ signal: AbortSignal; close(): Promise<void> }> {
  if (process.platform === "win32") throw new TypeError("phase cancellation control currently requires POSIX files");
  const supplied = path.resolve(input.configurationPath);
  const directory = await realpath(path.dirname(supplied));
  const configurationPath = path.join(directory, path.basename(supplied));
  const requestPath = configurationPath.replace(/\.config\.json$/, ".request.json");
  const runsRoot = await canonicalFuturePath(input.runsRoot);
  if (!/^run_[a-f0-9]{32}$/.test(input.expectedRunId)
    || !configurationPath.endsWith(`-${input.expectedRunId}.config.json`)
    || requestPath === configurationPath || configurationPath === runsRoot || configurationPath.startsWith(runsRoot + path.sep)) {
    throw new TypeError("phase control must have a run-scoped path outside run bundles");
  }
  const configuration = record(await boundedJSON(configurationPath));
  if (Object.keys(configuration).sort().join(",") !== "run_id,schema_version,token"
    || configuration.schema_version !== "hitch-phase-control@1" || configuration.run_id !== input.expectedRunId
    || typeof configuration.token !== "string" || !/^[a-f0-9]{64}$/.test(configuration.token)) {
    throw new TypeError("phase control configuration does not match the assigned run");
  }
  const token = Buffer.from(configuration.token, "hex");
  const controller = new AbortController();
  let closed = false;
  let active: Promise<void> | undefined;
  async function poll(): Promise<void> {
    try {
      const request = record(await boundedJSON(requestPath));
      if (!closed && !controller.signal.aborted
        && Object.keys(request).sort().join(",") === "reason,run_id,schema_version,token"
        && request.schema_version === "hitch-phase-cancel@1" && request.run_id === input.expectedRunId
        && typeof request.token === "string" && /^[a-f0-9]{64}$/.test(request.token)
        && timingSafeEqual(token, Buffer.from(request.token, "hex"))
        && typeof request.reason === "string" && REASONS.has(request.reason)) {
        controller.abort(new Error("candidate phase cancellation requested"));
      }
    } catch {
      // Missing, partially uploaded, oversized or stale requests cannot cancel
      // the run. Never echo a control input (it contains the private nonce).
    }
  }
  await poll(); // A request arriving before the CLI starts still applies.
  const timer = setInterval(() => {
    if (closed || controller.signal.aborted || active) return;
    active = poll().finally(() => { active = undefined; });
  }, 100);
  timer.unref();
  return {
    signal: controller.signal,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
      token.fill(0);
    },
  };
}
