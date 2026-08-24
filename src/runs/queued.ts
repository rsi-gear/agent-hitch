import path from "node:path";
import type { RunId } from "../domain/index.js";
import { HitchError, SCHEMA_VERSION, atomicWriteJSON, ensureDir } from "../foundation/index.js";
import { resolveHarness } from "../artifacts/index.js";
import type { ResolvedRevision } from "../artifacts/index.js";
import { planWorkspace, workspaceRecordPath } from "../workspaces/index.js";
import type { WorkspacePlan } from "../workspaces/index.js";
import { redactProviderText } from "../trajectories/index.js";
import { canonicalJSON } from "./records.js";
import { validateRunRequest } from "./request.js";
import type { RunRequestInput, ValidatedRunRequest } from "./request.js";
import { buildManifest, newRunId, safeAgentArgsForPersistence } from "./manifest.js";
import type { RunManifest } from "./manifest.js";

export function assertQueuedRunIdentity(existing: Record<string, unknown>, requested: RunManifest): void {
  const fields = ["context", "parent", "harness", "model", "protocol"] as const;
  for (const field of fields) {
    const left = existing[field];
    const right = requested[field];
    if (field === "harness") {
      const leftHarness = { ...(left as Record<string, unknown>), revision_identity: null, artifact_id: undefined };
      const rightHarness = { ...(right as Record<string, unknown>), revision_identity: null, artifact_id: undefined };
      if (canonicalJSON(leftHarness) === canonicalJSON(rightHarness)) continue;
    } else if (canonicalJSON(left) === canonicalJSON(right)) {
      continue;
    }
    throw new HitchError(`queued run identity does not match the execution request (${field})`, {
      code: "run_identity_mismatch",
      exitCode: 11,
    });
  }
}

export interface QueuedRun {
  runId: RunId;
  request: ValidatedRunRequest;
  resolvedRevision: ResolvedRevision;
  workspacePlan: WorkspacePlan;
  directory: string;
}

export async function createQueuedRun({
  runId = newRunId(),
  request,
  runsRoot,
  root = path.dirname(runsRoot),
}: { runId?: RunId; request: RunRequestInput; runsRoot: string; root?: string }): Promise<QueuedRun> {
  const normalized = await validateRunRequest(request);
  const resolvedRevision = await resolveHarness(normalized.harness_ref, { root });
  const workspacePlan = await planWorkspace({ runId, sourceCwd: normalized.cwd, mode: normalized.workspace_mode, root });
  const directory = await ensureDir(path.join(runsRoot, runId));
  await atomicWriteJSON(workspaceRecordPath(root, runId), workspacePlan);
  const manifest = buildManifest(runId, normalized, workspacePlan);
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    ...manifest,
    resolved_revision: resolvedRevision,
    revision_identity: resolvedRevision.identity,
    harness: {
      ...(manifest.harness as Record<string, unknown>),
      revision_identity: resolvedRevision.identity,
    },
  });
  await atomicWriteJSON(path.join(directory, "request.json"), {
    ...normalized,
    prompt: redactProviderText(normalized.prompt),
    agent_args: safeAgentArgsForPersistence(normalized.agent_args),
    schema_version: SCHEMA_VERSION,
  });
  await atomicWriteJSON(path.join(directory, "resolution.json"), resolvedRevision);
  return { runId, request: normalized, resolvedRevision, workspacePlan, directory };
}
