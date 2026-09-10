import type { ExecutableObservationV2, HarborEnvironmentObservationV2 } from "../../domain/index.js";
import { fingerprintExecutable, resolveExecutable, runCommand } from "../../foundation/index.js";
import { locateHarbor } from "./tools.js";

export interface HarborObservationOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  harborExecutable?: string;
  dockerExecutable?: string;
  signal?: AbortSignal;
}

const unavailable = { status: "unavailable", version: null, executable_digest: null } as const;
const unavailableDocker = { ...unavailable, engine_id: null, os: null, architecture: null };
const unavailableBuildx = { status: "unavailable", version: null } as const;
const version = (value: string) => value.match(/\bv?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
const field = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);

/** Fixed, read-only commands. No image pulls, installation, arbitrary commands or credentials in the result. */
export async function observeHarborEnvironment(options: HarborObservationOptions): Promise<HarborEnvironmentObservationV2> {
  const env = options.env ?? process.env;
  const command = (executable: string, args: string[]) => runCommand(executable, args, { env, timeoutMs: 10_000, signal: options.signal });
  const harbor = async (): Promise<ExecutableObservationV2> => {
    try {
      const located = await locateHarbor({ root: options.root, explicit: options.harborExecutable, env });
      if (!located.executable) return unavailable;
      const digest = await fingerprintExecutable(located.executable);
      // locateHarbor's legacy version hint does not require a successful exit; observe again strictly.
      const output = await command(located.executable, ["--version"]);
      const observed = version(output.stdout) ?? version(output.stderr);
      if (!observed || digest !== await fingerprintExecutable(located.executable)) return unavailable;
      return { status: "available", version: observed, executable_digest: digest };
    } catch { return unavailable; }
  };
  const docker = async (): Promise<Pick<HarborEnvironmentObservationV2, "docker" | "buildx">> => {
    try {
      const executable = await resolveExecutable(options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker", env.PATH || "", env.PATHEXT);
      if (!executable) return { docker: unavailableDocker, buildx: unavailableBuildx };
      const digest = await fingerprintExecutable(executable);
      const output = await command(executable, ["info", "--format", "{{json .}}"]);
      const info = JSON.parse(output.stdout) as Record<string, unknown>;
      if (!field(info.ID) || !field(info.ServerVersion) || !version(info.ServerVersion) || !field(info.OSType) || !field(info.Architecture)) {
        return { docker: unavailableDocker, buildx: unavailableBuildx };
      }
      let buildx: HarborEnvironmentObservationV2["buildx"] = unavailableBuildx;
      try {
        const result = await command(executable, ["buildx", "version"]);
        const observed = version(result.stdout);
        if (observed) buildx = { status: "available", version: observed };
      } catch { /* Plugin presence is separate from Docker engine availability. */ }
      if (digest !== await fingerprintExecutable(executable)) return { docker: unavailableDocker, buildx: unavailableBuildx };
      return { docker: { status: "available", version: info.ServerVersion, executable_digest: digest,
        engine_id: info.ID, os: info.OSType, architecture: info.Architecture }, buildx };
    } catch { return { docker: unavailableDocker, buildx: unavailableBuildx }; }
  };
  const [observedHarbor, observedDocker] = await Promise.all([harbor(), docker()]);
  return { schema_version: "2", host_platform: `${process.platform}-${process.arch}`, harbor: observedHarbor,
    ...observedDocker, sandbox: { status: "unverified" } };
}
