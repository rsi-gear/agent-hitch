import type { ExecutableObservationV2, ExecutionObservationProbeV1, HarborEnvironmentObservationV2 } from "../../domain/index.js";
import { HitchError, resolveExecutable } from "../../foundation/index.js";
import { fingerprintObservationExecutable, runObservationProbe } from "./observation-probe.js";
import type { ObservationProbeResult } from "./observation-probe.js";
import { locateHarborLauncher } from "./tools.js";

export interface HarborObservationOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  dockerExecutable?: string;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: ExecutionObservationProbeV1) => void;
}

const unavailable = { status: "unavailable", version: null, executable_digest: null } as const;
const unavailableDocker = { ...unavailable, engine_id: null, os: null, architecture: null };
const unavailableBuildx = { status: "unavailable", version: null } as const;
const unavailableEngine = { docker: unavailableDocker, buildx: unavailableBuildx };
const version = (value: string) => value.match(/\bv?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
const field = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);
const retryable = new Set(["nonzero_exit", "signal_exit", "timed_out", "invalid_json", "invalid_fields"]);
function engineFields(value: unknown): value is Record<"ID" | "ServerVersion" | "OSType" | "Architecture", string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  return field(info.ID) && field(info.ServerVersion) && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(info.ServerVersion)
    && field(info.OSType) && field(info.Architecture);
}

function attempt(probe: ExecutionObservationProbeV1["probe"], number: 1 | 2) {
  const started = performance.now();
  let stage: ExecutionObservationProbeV1["stage"] = "resolve";
  let result: ObservationProbeResult | undefined;
  return {
    stage(value: ExecutionObservationProbeV1["stage"]) { stage = value; },
    get ioStage() { return stage === "resolve" || stage === "fingerprint" || stage === "identity"; },
    command(value: ObservationProbeResult) { result = value; stage = value.outcome === "invalid_encoding" ? "parse" : "command"; },
    finish(outcome: ExecutionObservationProbeV1["outcome"]): ExecutionObservationProbeV1 {
      return { probe, attempt: number, stage, outcome, elapsed_ms: Math.min(30_000, Math.max(0, Math.round(performance.now() - started))),
        exit_code: result?.exit_code ?? null, signal: result?.signal ?? null };
    },
  };
}

/** Pure stable environment. Diagnostics are delivered separately and never enter its digest. */
export async function observeHarborEnvironment(options: HarborObservationOptions): Promise<HarborEnvironmentObservationV2> {
  const env = options.env ?? process.env, deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Environment observation deadline exceeded", "TimeoutError")), 25_000);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const diagnostics: ExecutionObservationProbeV1[] = [];
  // fs resolution promises cannot be interrupted. Await settlement, then honour cancellation before any spawn.
  const io = async <T>(pending: Promise<T>): Promise<T> => {
    try { const value = await pending; signal.throwIfAborted(); return value; }
    catch (error) { signal.throwIfAborted(); throw error; }
  };
  const fingerprint = (executable: string) => io(fingerprintObservationExecutable(executable, signal));
  const command = (executable: string, probe: ExecutionObservationProbeV1["probe"], timeoutMs: number) =>
    runObservationProbe(executable, probe, { env, signal, timeoutMs });
  const harbor = async (): Promise<ExecutableObservationV2> => {
    const current = attempt("harbor_version", 1);
    const finish = (outcome: ExecutionObservationProbeV1["outcome"]) => { diagnostics.push(current.finish(outcome)); return unavailable; };
    try {
      signal.throwIfAborted();
      const located = await io(locateHarborLauncher({ root: options.root, explicit: options.harborExecutable, env }));
      if (!located.executable) return finish("not_found");
      current.stage("fingerprint");
      const digest = await fingerprint(located.executable);
      current.stage("command");
      const output = await command(located.executable, "harbor_version", 5_000);
      current.command(output);
      current.stage("identity");
      if (digest !== await fingerprint(located.executable)) return finish("executable_changed");
      current.command(output);
      if (output.outcome !== "ok") return finish(output.outcome);
      current.stage("validate");
      const observed = version(output.stdout) ?? version(output.stderr);
      if (!observed) return finish("invalid_fields");
      current.stage("complete"); diagnostics.push(current.finish("ok"));
      return { status: "available", version: observed, executable_digest: digest };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof HitchError && error.code === "execution_observation_cleanup_failed") throw error;
      if (!current.ioStage) throw error;
      return finish("io_error");
    }
  };
  const buildx = async (executable: string): Promise<HarborEnvironmentObservationV2["buildx"]> => {
    const current = attempt("buildx_version", 1);
    current.stage("command");
    const output = await command(executable, "buildx_version", 2_000);
    current.command(output);
    if (output.outcome !== "ok") { diagnostics.push(current.finish(output.outcome)); return unavailableBuildx; }
    current.stage("validate");
    const observed = version(output.stdout);
    if (!observed) { diagnostics.push(current.finish("invalid_fields")); return unavailableBuildx; }
    current.stage("complete"); diagnostics.push(current.finish("ok"));
    return { status: "available", version: observed };
  };
  const docker = async (): Promise<Pick<HarborEnvironmentObservationV2, "docker" | "buildx">> => {
    let executable: string | null = null, digest: string | undefined;
    for (const number of [1, 2] as const) {
      const current = attempt("docker_info", number);
      const finish = (outcome: ExecutionObservationProbeV1["outcome"]) => {
        diagnostics.push(current.finish(outcome));
        return number === 1 && retryable.has(outcome);
      };
      try {
        signal.throwIfAborted();
        executable ??= await io(resolveExecutable(options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker", env.PATH || "", env.PATHEXT));
        if (!executable) { finish("not_found"); return unavailableEngine; }
        current.stage(digest ? "identity" : "fingerprint");
        const before = await fingerprint(executable);
        if (digest && digest !== before) { finish("executable_changed"); return unavailableEngine; }
        digest = before;
        current.stage("command");
        const output = await command(executable, "docker_info", 10_000);
        current.command(output);
        current.stage("identity");
        if (digest !== await fingerprint(executable)) { finish("executable_changed"); return unavailableEngine; }
        current.command(output);
        if (output.outcome !== "ok") {
          if (finish(output.outcome)) continue;
          return unavailableEngine;
        }
        current.stage("parse");
        let info: unknown;
        try { info = JSON.parse(output.stdout); }
        catch { if (finish("invalid_json")) continue; return unavailableEngine; }
        current.stage("validate");
        if (!engineFields(info)) {
          if (finish("invalid_fields")) continue;
          return unavailableEngine;
        }
        const observedBuildx = await buildx(executable);
        current.stage("identity");
        if (digest !== await fingerprint(executable)) { finish("executable_changed"); return unavailableEngine; }
        current.stage("complete"); finish("ok");
        return { docker: { status: "available", version: info.ServerVersion, executable_digest: digest,
          engine_id: info.ID, os: info.OSType, architecture: info.Architecture }, buildx: observedBuildx };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof HitchError && error.code === "execution_observation_cleanup_failed") throw error;
        if (!current.ioStage) throw error;
        finish("io_error"); return unavailableEngine;
      }
    }
    return unavailableEngine;
  };
  try {
    // Rejection must not release the observer while the other branch still owns a probe process.
    const [observedHarbor, observedDocker] = await Promise.allSettled([harbor(), docker()]);
    signal.throwIfAborted();
    if (observedHarbor.status === "rejected") throw observedHarbor.reason;
    if (observedDocker.status === "rejected") throw observedDocker.reason;
    for (const diagnostic of diagnostics) options.onDiagnostic?.(diagnostic);
    return { schema_version: "2", host_platform: `${process.platform}-${process.arch}`, harbor: observedHarbor.value,
      ...observedDocker.value, sandbox: { status: "unverified" } };
  } finally { clearTimeout(timer); }
}
