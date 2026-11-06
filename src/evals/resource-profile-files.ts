import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWriteJSON, sha256Bytes, sha256JSON } from "../foundation/index.js";
import { approveResourceConfiguration } from "./resource-profile-approval.js";
import { makeResourceProfile, resourceProfileTrialFromExecution } from "./resource-profile-evidence.js";
import { parseResourceProfileIdentity } from "./resource-profile-identity.js";
import type { ResourceProfileTrialV1, ResourceProfileV1 } from "./resource-profile-evidence.js";

export async function approveResourceConfigurationFile(file: string, actor: string, reason: string) {
  const value = JSON.parse(await readFile(file, "utf8")) as { identity: unknown; role_limits: unknown };
  if (!value || Object.keys(value).some(key => key !== "identity" && key !== "role_limits")) throw new TypeError("approval config must contain identity and role_limits only");
  return approveResourceConfiguration({ identity: value.identity, role_limits: value.role_limits, actor, reason });
}

export async function readResourceProfileIdentityFile(file: string) {
  return parseResourceProfileIdentity(JSON.parse(await readFile(file, "utf8")));
}

export async function saveResourceProfileOutput(file: string, result: unknown) {
  const destination = path.resolve(file);
  await atomicWriteJSON(destination, result);
  return { output: destination, digest: sha256JSON(result) };
}

export async function importedProfile(file: string): Promise<ResourceProfileV1> {
  const value = JSON.parse(await readFile(file, "utf8")) as { identity?: unknown; trials?: Array<{ evidence: string; input_case?: ResourceProfileTrialV1["input_case"] }> };
  if (!value || !Array.isArray(value.trials) || value.trials.length > 10000 || Object.keys(value).some(key => !["identity", "trials"].includes(key))) throw new TypeError("profile input must contain identity and bounded trials");
  const identity = value.identity === undefined ? null : parseResourceProfileIdentity(value.identity);
  const trials: ResourceProfileTrialV1[] = [];
  for (const trial of value.trials) {
    if (typeof trial.evidence !== "string" || Object.keys(trial).some(key => !["evidence", "input_case"].includes(key))) throw new TypeError("profile trial must reference an execution evidence file");
    const source = path.resolve(path.dirname(file), trial.evidence), content = await readFile(source);
    trials.push(resourceProfileTrialFromExecution({ evidence: JSON.parse(content.toString("utf8")), source: { path: source, digest: sha256Bytes(content), trust: "operator-import" },
      ...(identity ? { identityDigest: sha256JSON(identity) } : {}), ...(trial.input_case ? { inputCase: trial.input_case } : {}) }));
  }
  return makeResourceProfile({ identity, trials, blockedReasons: ["operator_import_is_not_frozen_provider_evidence"] });
}

export async function importedSavedProfile(file: string): Promise<ResourceProfileV1> {
  const profile = JSON.parse(await readFile(file, "utf8")) as ResourceProfileV1;
  const { profile_digest, ...body } = profile;
  if (sha256JSON(body) !== profile_digest || !Array.isArray(profile.trials)) throw new TypeError("saved resource profile digest changed");
  // A self-supplied digest is integrity metadata, not provider attestation.
  return makeResourceProfile({ identity: profile.identity ? parseResourceProfileIdentity(profile.identity) : null,
    trials: profile.trials.map(trial => ({ ...trial, source: { ...trial.source, trust: "operator-import" },
      blocked_reasons: [...trial.blocked_reasons, "saved_profile_requires_source_reverification"] })),
    blockedReasons: [...profile.blocked_reasons, "use_eval_to_reverify_frozen_sources"] });
}
