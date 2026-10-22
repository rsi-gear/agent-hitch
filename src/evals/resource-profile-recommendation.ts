import type { ResourceProfileIdentityV1 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseResourceProfileIdentity, resourceProfileIdentityDigest } from "./resource-profile-identity.js";
import { RESOURCE_PROFILE_PHASES, type ResourceProfileTrialV1, type ResourceProfileV1 } from "./resource-profile-evidence.js";
import { profileInteger } from "./resource-profile-validation.js";

export function resourceProfileTrialEligibility(trial: ResourceProfileTrialV1, identity: ResourceProfileIdentityV1): string[] {
  const reasons = [...trial.blocked_reasons];
  if (trial.identity_digest !== resourceProfileIdentityDigest(identity)) reasons.push("profile_identity_changed");
  if (!identity.tasks.some(task => task.task_id === trial.task_id)) reasons.push("task_outside_profile");
  if (trial.source.trust !== "provider-lifecycle-attestation") reasons.push("complete_provider_attestation_missing");
  if (!trial.lifecycle.complete || RESOURCE_PROFILE_PHASES.some(phase => !trial.lifecycle.covered_phases.includes(phase))) reasons.push("lifecycle_phase_coverage_incomplete");
  for (const expected of identity.role_images) {
    const roles = trial.roles.filter(role => role.component_id === expected.component_id);
    if (roles.length !== expected.replicas || new Set(roles.map(role => role.container_id)).size !== roles.length) reasons.push(`role_inventory_incomplete:${expected.component_id}`);
    if (roles.some(role => !role.complete_lifetime || role.peak_kind !== "terminal-kernel-peak" || role.peak_semantics !== "cgroup-usage"
      || !Number.isSafeInteger(role.memory_peak_bytes) || role.memory_peak_bytes! < 0 || typeof role.oom_killed !== "boolean"
      || !Number.isSafeInteger(role.exit_code) || role.exit_code! < 0 || role.exit_code! > 255)) reasons.push(`reliable_role_peak_or_exit_missing:${expected.component_id}`);
  }
  if (trial.roles.some(role => !identity.role_images.some(expected => expected.component_id === role.component_id))) reasons.push("unexpected_observed_role");
  return [...new Set(reasons)];
}

export function recommendResourceConfiguration(profile: ResourceProfileV1, currentIdentity?: ResourceProfileIdentityV1, options: {
  min_complete_trials?: number; margin_ratio?: number; minimum_margin_bytes?: number; round_up_bytes?: number;
} = {}) {
  const { profile_digest, ...body } = profile;
  if (profile.schema_version !== "1" || profile.kind !== "resource-observation-profile" || sha256JSON(body) !== profile_digest) throw new TypeError("resource profile digest changed");
  const minimum = profileInteger(options.min_complete_trials ?? 3);
  const ratio = options.margin_ratio ?? 0.25, marginBytes = profileInteger(options.minimum_margin_bytes ?? 64 * 1024 ** 2, 0);
  const round = profileInteger(options.round_up_bytes ?? 1024 ** 2);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 10) throw new TypeError("resource recommendation margin is invalid");
  const identity = profile.identity ? parseResourceProfileIdentity(profile.identity) : null;
  const blocked = [...profile.blocked_reasons];
  if (!identity || profile.identity_digest !== resourceProfileIdentityDigest(identity)) blocked.push("frozen_profile_identity_unavailable");
  if (currentIdentity && (!identity || resourceProfileIdentityDigest(currentIdentity) !== profile.identity_digest)) blocked.push("profile_identity_changed");
  const unique = new Set(profile.trials.map(trial => trial.sample_id));
  if (unique.size !== profile.trials.length) blocked.push("duplicate_physical_samples");
  const trials = profile.trials.map(trial => ({ sample_id: trial.sample_id, reasons: identity ? resourceProfileTrialEligibility(trial, identity) : ["profile_identity_unavailable"] }));
  const eligible = profile.trials.filter((_trial, index) => trials[index]!.reasons.length === 0);
  if (eligible.length < minimum) blocked.push("insufficient_complete_trials");
  if (trials.some(trial => trial.reasons.length > 0)) blocked.push("incomplete_or_unverified_samples_prevent_lowering");
  // Failed/OOM trials remain in the same population, including incomplete ones.
  if (profile.trials.some(trial => trial.roles.some(role => role.oom_killed === true))) blocked.push("oom_samples_prevent_lowering");
  if (profile.trials.some(trial => trial.roles.some(role => role.exit_code !== undefined && role.exit_code !== 0))) blocked.push("failed_samples_prevent_lowering");
  for (const task of identity?.tasks ?? []) if (eligible.filter(trial => trial.task_id === task.task_id).length < minimum) blocked.push(`insufficient_task_coverage:${task.task_id}`);
  if ((identity?.tasks.length ?? 0) > 1) for (const task of identity!.tasks) for (const kind of ["representative", "stress"] as const) {
    if (!eligible.some(trial => trial.task_id === task.task_id && trial.input_case.kind === kind)) blocked.push(`input_coverage_missing:${task.task_id}:${kind}`);
  }
  const allowed = blocked.length === 0;
  const currentLimits = currentRoleLimits(identity);
  const names = [...new Set([...(identity?.role_images.map(role => role.component_id) ?? []), ...profile.trials.flatMap(trial => trial.roles.map(role => role.component_id))])].sort();
  const roles = names.map(component_id => {
    const observations = profile.trials.flatMap(trial => trial.roles.filter(role => role.component_id === component_id));
    const values = observations.flatMap(role => role.memory_peak_bytes === undefined ? [] : [role.memory_peak_bytes]).sort((a, b) => a - b);
    const maximum = values.at(-1);
    const suggested = allowed && maximum !== undefined ? Math.ceil((maximum + Math.max(maximum * ratio, marginBytes)) / round) * round : undefined;
    if (suggested !== undefined && !Number.isSafeInteger(suggested)) throw new TypeError("resource recommendation is unrepresentable");
    return { component_id, current_limits: currentLimits.find(role => role.component_id === component_id) ?? null, observed_max_bytes: maximum ?? null, p95_descriptive_bytes: values.length ? values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] : null,
      measurement_kinds: [...new Set(observations.map(role => `${role.peak_kind}:${role.peak_semantics}`))],
      ...(suggested === undefined ? {} : { suggested_memory_bytes: suggested }), source_digests: profile.trials.filter(trial => trial.roles.some(role => role.component_id === component_id)).map(trial => trial.source.digest) };
  });
  return { schema_version: "1", kind: "resource-configuration-recommendation", profile_digest, identity_digest: profile.identity_digest,
    automatic_application: false, lowering_eligible: allowed, min_complete_trials: minimum, complete_trials: eligible.length, all_trials: profile.trials.length,
    blocked_reasons: [...new Set(blocked)], trial_eligibility: trials, roles, current_role_limits: currentLimits,
    group_observations: profile.trials.flatMap(trial => trial.memory_observation ? [{ sample_id: trial.sample_id, ...trial.memory_observation }] : []),
    actions: allowed ? [{ action: "review_explicit_configuration", detail: "Review the maximum-plus-margin proposal and create a new explicit configuration and plan; no limit changes automatically." }]
      : [{ action: "retain_current_limits", detail: "Keep the current enforced limits; sampled maxima do not establish safe lower limits." },
        { action: "collect_complete_lifecycle_evidence", detail: "Collect cold-start, agent, artifact-collection, verifier and exit coverage, per-role final kernel peaks, OOM flags and exit outcomes." },
        ...(blocked.includes("oom_samples_prevent_lowering") || blocked.includes("failed_samples_prevent_lowering")
          ? [{ action: "investigate_failures_and_rerun", detail: "Retain failed/OOM samples, investigate their cause, then rerun with a new explicit resource configuration and identity." }] : []),
        ...(!identity ? [{ action: "run_with_frozen_profile_identity", detail: "Create a new plan that freezes task, artifact, runtime, immutable images, platform, backend, inputs and resource parameters." }] : [])],
    margin_policy: { strategy: "observed-maximum-plus-margin", margin_ratio: ratio, minimum_margin_bytes: marginBytes, round_up_bytes: round },
    coverage: profile.coverage, limitations: ["P95 describes observed peaks and is not a hard limit", "Three complete trials do not establish tail safety",
      "Sum of individual container peaks is not a simultaneous task peak; group samples retain their timing and quality",
      "CPU, GPU, disk, and reservation are not changed", "Apply any selected limits through a new explicit configuration and plan"] };
}

function currentRoleLimits(identity: ResourceProfileIdentityV1 | null): Array<{ component_id: string; replicas: number; cpu_millis: number; memory_bytes: number }> {
  const limits = identity?.resource_parameters.limits;
  if (!Array.isArray(limits)) return [];
  return limits.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const limit = value as Record<string, unknown>, resources = limit.resources as Record<string, unknown> | undefined;
    if (typeof limit.component_id !== "string" || !Number.isSafeInteger(limit.replicas) || (limit.replicas as number) < 1 || !resources) return [];
    const replicas = limit.replicas as number, cpu = Number(resources.cpu_millis) / replicas, memory = Number(resources.memory_bytes) / replicas;
    if (!Number.isSafeInteger(cpu) || cpu < 1 || !Number.isSafeInteger(memory) || memory < 1) return [];
    return [{ component_id: limit.component_id, replicas, cpu_millis: cpu, memory_bytes: memory }];
  });
}
