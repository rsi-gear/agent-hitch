import path from "node:path";
import { daemonClient } from "../../daemon/index.js";
import type { RunId } from "../../domain/index.js";
import { HitchError, SCHEMA_VERSION, invalidInput, readJSON, statePaths } from "../../foundation/index.js";
import { executeRun, newRunId } from "../../runs/index.js";
import { parseHarnessReference } from "../../revisions/index.js";
import type { ResolvedRevision, VerifiedLocalGitSource } from "../../revisions/index.js";
import { validateLocalGitTransportManifest, verifyMaterializedLocalGitSource } from "../../backends/index.js";
import { assertNoArgs, parseRunRequest, takeFlag, takeOption } from "../arguments.js";
import { waitForDaemonRun } from "../output.js";

export async function runCommand(args: string[], root: string): Promise<void> {
  const useDaemon = takeFlag(args, "--daemon");
  const output = takeOption(args, "--output") || "jsonl";
  const internalFlags = takeInternalLocalGitFlags(args);
  const internalRunId = takeOption(args, "--internal-run-id");
  const deferBenchmarkObservation = takeFlag(args, "--internal-defer-benchmark-observation");
  if ((internalRunId || deferBenchmarkObservation) && process.env.HITCH_HARBOR_INTERNAL !== "1") {
    throw invalidInput("internal eval run options are unavailable outside the Harbor bridge");
  }
  if (internalRunId && !/^run_[a-f0-9]{32}$/.test(internalRunId)) throw invalidInput("invalid internal run ID");
  const request = await parseRunRequest(args);
  if (deferBenchmarkObservation) request.defer_benchmark_observation = true;
  assertNoArgs(args);
  if (!new Set(["json", "jsonl"]).has(output)) throw invalidInput("--output must be json or jsonl");
  if (internalFlags && useDaemon) throw invalidInput("internal Harbor locked resolution cannot use the daemon");
  const internal = internalFlags ? await loadInternalLocalGitSource(internalFlags, request.harness_ref as string) : null;

  if (useDaemon) {
    const client = await daemonClient(root);
    const accepted = await client.request("/v1/runs", { method: "POST", body: JSON.stringify(request) });
    const result = await waitForDaemonRun(client, accepted.run_id as string, output);
    process.exitCode = (result as { exit_code?: unknown }).exit_code as number;
    return;
  }

  const runId = (internalRunId || newRunId()) as RunId;
  const result = await executeRun({
    runId,
    request,
    runsRoot: statePaths(root).runs,
    root,
    ...(internal ? { resolvedRevision: internal.resolution, verifiedLocalGitSource: internal.source } : {}),
    ...(output === "jsonl" ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
  });
  if (output === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exit_code as number;
}

interface InternalLocalGitFlags {
  resolutionPath: string;
  manifestPath: string;
  sourceDirectory: string;
}

export function takeInternalLocalGitFlags(args: string[]): InternalLocalGitFlags | null {
  const resolutionPath = takeOption(args, "--internal-locked-resolution");
  const manifestPath = takeOption(args, "--internal-local-git-manifest");
  const sourceDirectory = takeOption(args, "--internal-local-git-source");
  if (resolutionPath === undefined && manifestPath === undefined && sourceDirectory === undefined) return null;
  if (process.env.HITCH_HARBOR_INTERNAL !== "1") throw invalidInput("internal Harbor source options are unavailable outside the Harbor bridge");
  if (!resolutionPath || !manifestPath || !sourceDirectory) throw invalidInput("internal Harbor source handoff is incomplete");
  return { resolutionPath, manifestPath, sourceDirectory };
}

export async function loadInternalLocalGitSource(
  flags: InternalLocalGitFlags,
  requestedReference: string,
): Promise<{ resolution: ResolvedRevision; source: VerifiedLocalGitSource }> {
  const resolution = await readJSON<ResolvedRevision>(path.resolve(flags.resolutionPath));
  const reference = parseHarnessReference(requestedReference);
  if (
    !resolution || resolution.schema_version !== SCHEMA_VERSION
    || resolution.harness_id !== reference.harness_id
    || resolution.source?.type !== "git" || resolution.source.registered !== false
    || resolution.revision?.type !== "commit"
    || !/^sha256:[0-9a-f]{64}$/.test(resolution.identity || "")
    || `${resolution.harness_id}@commit:${resolution.revision.commit || ""}` !== reference.canonical
  ) {
    throw new HitchError("internal Harbor locked resolution is invalid or does not match the command", {
      code: "local_source_integrity_mismatch",
      exitCode: 12,
    });
  }
  const manifest = validateLocalGitTransportManifest(await readJSON(path.resolve(flags.manifestPath)));
  const source = await verifyMaterializedLocalGitSource({
    directory: path.resolve(flags.sourceDirectory),
    manifest,
    resolution,
  });
  return { resolution, source };
}
