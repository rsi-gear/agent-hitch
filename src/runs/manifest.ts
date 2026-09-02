import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, credentialValuesFromEnv, sha256JSON } from "../foundation/index.js";
import { parseHarnessReference } from "../revisions/index.js";
import { workspaceManifestFields } from "../workspaces/index.js";
import type { WorkspacePlan } from "../workspaces/index.js";
import { redactProviderText } from "../trajectories/index.js";
import type { ModelIdentityV1, ProtocolIdentityV1, RunContextV1, RunId } from "../domain/index.js";
import type { ValidatedRunRequest } from "./request.js";

export function newRunId(): RunId {
  return `run_${randomUUID().replaceAll("-", "")}` as RunId;
}

export interface RunManifest extends Record<string, unknown> {
  schema_version: string;
  run_id: RunId;
  status: string;
  harness_id: string;
  requested_harness_ref: string;
  canonical_harness_ref: string;
  agent: string;
  requested_model: string | null;
  effective_model: string | null;
  workspace: string;
  workspace_mode: string;
  timeout_ms: number;
  agent_args_count: number;
  agent_args_sha256: string | null;
  created_at: string;
  context: RunContextV1;
  harness: Record<string, unknown>;
  model: ModelIdentityV1;
  protocol: ProtocolIdentityV1;
  request_ref: string;
  resolution_ref: string;
}

export function buildManifest(runId: RunId, request: ValidatedRunRequest, workspacePlan: WorkspacePlan | null): RunManifest {
  const reference = parseHarnessReference(request.harness_ref);
  const safeAgentArgs = safeAgentArgsForPersistence(request.agent_args, credentialValuesFromEnv(request.credential_names, process.env));
  const argsDigest = safeAgentArgs.length > 0 ? sha256JSON(safeAgentArgs) : undefined;
  const environmentIdentity = request.protocol_identity.environment_identity
    ?? sha256JSON({ platform: process.platform, arch: process.arch, node: process.versions.node });
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: "queued",
    harness_id: reference.harness_id,
    requested_harness_ref: reference.raw,
    canonical_harness_ref: reference.canonical,
    agent: reference.harness_id,
    requested_model: request.model || null,
    effective_model: request.model || null,
    workspace: request.cwd,
    workspace_mode: request.workspace_mode,
    ...workspaceManifestFields(workspacePlan),
    timeout_ms: request.timeout_ms,
    agent_args_count: request.agent_args.length,
    agent_args_sha256: argsDigest ?? null,
    context: request.context,
    ...(request.parent ? { parent: request.parent } : {}),
    harness: {
      harness_id: reference.harness_id,
      requested_ref: reference.raw,
      revision_identity: null,
      ...(argsDigest ? { agent_args_sha256: argsDigest } : {}),
    },
    model: request.model_identity,
    protocol: {
      timeout_ms: request.timeout_ms,
      workspace_mode: request.workspace_mode,
      environment_identity: environmentIdentity,
      ...(request.protocol_identity.tool_policy_sha256 ? { tool_policy_sha256: request.protocol_identity.tool_policy_sha256 } : {}),
    },
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    created_at: new Date().toISOString(),
  };
}

export function safeAgentArgsForPersistence(agentArgs: string[], credentialValues: readonly string[] = []): string[] {
  const sensitiveFlag = /(?:api[-_]?key|authorization|token|secret|password|credential|cookie)/i;
  const result: string[] = [];
  for (let index = 0; index < agentArgs.length; index += 1) {
    const argument = agentArgs[index] as string;
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (flag.startsWith("-") && sensitiveFlag.test(flag)) {
      result.push(separator >= 0 ? `${flag}=[REDACTED]` : flag);
      if (separator < 0 && agentArgs[index + 1] !== undefined && !String(agentArgs[index + 1]).startsWith("--")) {
        result.push("[REDACTED]");
        index += 1;
      }
      continue;
    }
    result.push(redactProviderText(argument, new Map(), credentialValues));
  }
  return result;
}
