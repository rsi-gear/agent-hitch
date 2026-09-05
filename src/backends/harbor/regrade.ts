import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { HitchError, atomicWriteJSON, ensureDir, fingerprintExecutable, readJSON } from "../../foundation/index.js";
import { locateHarbor } from "./tools.js";
import { invokeHarbor } from "./process.js";

/** Harbor 0.21 dispatches source_trial.action=regrade to RegradeTrial, which
 * never initializes or runs the candidate. Keep the source agent config as
 * provenance, and preserve every timeout/resource/verifier setting. */
export function buildHarborRegradeConfig(input: {
  sourceConfig: Record<string, unknown>;
  sourceResult: Record<string, unknown>;
  sourceDirectory: string;
  outputDirectory: string;
  trialName: string;
  ownershipLabels: Record<string, string>;
}): Record<string, unknown> {
  const source = structuredClone(input.sourceConfig);
  const environment = source.environment as Record<string, unknown> | undefined;
  const agent = source.agent as Record<string, unknown> | undefined;
  const verifier = source.verifier as Record<string, unknown> | undefined;
  if (!environment || environment.import_path !== "hitch_harbor_environment:HitchHarborDockerEnvironment"
    || agent?.import_path !== "hitch_harbor_agent:HitchHarborAgent" || !verifier || verifier.disable
    || source.source_trial || source.install_only || typeof input.sourceResult.id !== "string") {
    throw new HitchError("verifier-only requires an original managed Hitch Harbor trial with verification enabled", { code: "eval_verifier_only_unavailable", exitCode: 2 });
  }
  return {
    ...source,
    job_id: null,
    trial_name: input.trialName,
    trials_dir: input.outputDirectory,
    source_trial: { action: "regrade", type: "local", trial_id: input.sourceResult.id, path: input.sourceDirectory },
    environment: {
      ...environment,
      // The Hitch reaper releases exactly this lease, including on failure.
      delete: false,
      kwargs: { ...(environment.kwargs as Record<string, unknown> ?? {}), hitch_ownership_labels: input.ownershipLabels },
    },
  };
}

/** Harbor copies agent/ and artifacts/ only. The Hitch lifecycle journal is
 * collected control evidence needed by the frozen metric normalizer as well.
 * Copy it verbatim; never manufacture prepare/snapshot success for a regrade. */
export async function seedHarborRegradeTrial(sourceDirectory: string, trialDirectory: string, trustedResult?: Record<string, unknown>): Promise<void> {
  const file = path.join(sourceDirectory, "benchmark-lifecycle.json");
  const journal = await readJSON<Record<string, unknown>>(file);
  if (journal.schema_version !== "1" || journal.failure !== null || !journal.phases || typeof journal.phases !== "object" || Array.isArray(journal.phases)) {
    throw new HitchError("source benchmark lifecycle is incomplete or failed", { code: "eval_verifier_only_unavailable", exitCode: 2 });
  }
  await mkdir(trialDirectory, { recursive: true });
  await copyFile(file, path.join(trialDirectory, "benchmark-lifecycle.json"));
  const responseFile = path.join(sourceDirectory, "hitch-final-response.json");
  const response = await readJSON<Record<string, unknown> | null>(responseFile, null);
  if (response !== null) {
    // Caller has verified the sealed result bundle. Never substitute the
    // candidate-writable artifact for the host's authoritative export.
    if (!trustedResult || typeof trustedResult.output !== "string"
      || response.schema_version !== "1" || response.source !== "hitch-run-result"
      || response.run_id !== trustedResult.run_id || response.termination !== trustedResult.status
      || response.response !== trustedResult.output) {
      throw new HitchError("canonical response differs from the sealed candidate result", { code: "eval_verifier_only_unavailable", exitCode: 2 });
    }
    await copyFile(responseFile, path.join(trialDirectory, "hitch-final-response.json"));
  }
}

export async function runHarborRegrade(input: {
  root: string;
  directory: string;
  config: Record<string, unknown>;
  runtimeDirectory: string;
  env: NodeJS.ProcessEnv;
  trustedResult?: Record<string, unknown>;
  harborExecutable?: string;
  signal?: AbortSignal;
}): Promise<{ trial: Record<string, unknown>; backend: Record<string, unknown> }> {
  const located = await locateHarbor({ root: input.root, explicit: input.harborExecutable, env: input.env });
  // Pin the SDK contract; upgrading this gate requires a regrade parity test.
  if (!located.executable || located.version !== "0.21.0") throw new HitchError("verifier-only requires Harbor 0.21.0", { code: "eval_verifier_only_backend_unavailable", exitCode: 2 });
  await ensureDir(input.directory);
  const configPath = path.join(input.directory, "regrade.json");
  await atomicWriteJSON(configPath, input.config);
  await seedHarborRegradeTrial(String((input.config.source_trial as Record<string, unknown>).path), path.join(String(input.config.trials_dir), String(input.config.trial_name)), input.trustedResult);
  const outcome = await invokeHarbor(located.executable, ["trials", "start", "--config", configPath], {
    cwd: input.directory,
    env: { ...input.env, PYTHONPATH: [path.join(input.runtimeDirectory, "payload/integrations/harbor"), input.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    stdoutPath: path.join(input.directory, "stdout.log"), stderrPath: path.join(input.directory, "stderr.log"),
    ...(input.signal ? { signal: input.signal } : {}), emit: () => {},
    redactEnvNames: Object.keys(input.env).filter((key) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH_JSON/.test(key)),
  });
  const trial = await readJSON<Record<string, unknown>>(path.join(String(input.config.trials_dir), String(input.config.trial_name), "result.json"));
  return { trial, backend: { name: "harbor", version: located.version, identity: await fingerprintExecutable(located.executable), process_exit_code: outcome.code, signal: outcome.signal } };
}
