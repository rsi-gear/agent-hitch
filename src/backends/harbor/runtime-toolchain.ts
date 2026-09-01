import { HitchError } from "../../foundation/index.js";

export const HARBOR_NODE_VERSION = "22.23.0";
export const HARBOR_NODE_VERSION_WITH_PREFIX = `v${HARBOR_NODE_VERSION}`;
export const HARBOR_PNPM_VERSION = "10.17.1";

/**
 * The runtime ABI that a prepared harness artifact must match. This is a
 * planner input: it describes the trial container that will consume the
 * artifact, never the controller host that happens to run the planner.
 */
export interface HarborTrialRuntimeContract {
  dockerPlatform: string;
  artifactPlatform: string;
  nodeVersion: string;
}

export const DEFAULT_HARBOR_TRIAL_DOCKER_PLATFORM = "linux/amd64";

export function harborTrialRuntimeContract(dockerPlatform: string): HarborTrialRuntimeContract {
  const normalized = normalizeDockerPlatform(dockerPlatform);
  const artifactPlatform = normalized === "linux/amd64" ? "linux-x64"
    : normalized === "linux/arm64" ? "linux-arm64"
      : null;
  if (artifactPlatform === null) {
    throw new HitchError(`unsupported Harbor trial runtime platform: ${dockerPlatform || "unknown"}`, {
      code: "harbor_trial_runtime_platform_unsupported",
      exitCode: 12,
    });
  }
  return {
    dockerPlatform: normalized,
    artifactPlatform,
    nodeVersion: HARBOR_NODE_VERSION_WITH_PREFIX,
  };
}

function normalizeDockerPlatform(value: string): string {
  const [os, rawArchitecture, extra] = value.trim().toLowerCase().split("/");
  const architecture = rawArchitecture === "x86_64" || rawArchitecture === "x86-64" ? "amd64"
    : rawArchitecture === "aarch64" ? "arm64"
      : rawArchitecture;
  return extra === undefined && os && architecture ? `${os}/${architecture}` : value.trim().toLowerCase();
}
