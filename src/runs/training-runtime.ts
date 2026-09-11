import type { TrainingProxyIdentityV1 } from "../domain/index.js";
import { invalidInput } from "../foundation/index.js";

export function trainingHarborIdentity(env: NodeJS.ProcessEnv, runId: string, model: string, harness: string): TrainingProxyIdentityV1 | undefined {
  if (env.HITCH_TRAINING_EXTERNAL !== "1") {
    if (model.startsWith("training/")) throw invalidInput("training model requires a managed Harbor handoff");
    return undefined;
  }
  const value = JSON.parse(env.HITCH_TRAINING_BINDING ?? "null") as TrainingProxyIdentityV1 | null;
  if (env.HITCH_HARBOR_INTERNAL !== "1" || env.HITCH_TRAINING_RUN_ID !== runId || env.OPENAI_API_KEY !== "hitch-training-external"
    || !harness.startsWith("training-tool@") || !value || model !== `training/${value.binding_id}` || value.api !== "chat-completions"
    || !/^sha256:[a-f0-9]{64}$/.test(value.generation_contract_digest) || !value.policy_version || !value.training_run_id
    || ![value.max_episode_steps, value.max_output_tokens].every(n => Number.isSafeInteger(n) && n > 0)) throw invalidInput("training Harbor binding is invalid");
  const url = new URL(env.OPENAI_BASE_URL ?? "");
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/[a-f0-9]{48}/${runId}/openai/?$`).test(url.pathname)) throw invalidInput("training Harbor endpoint is not run-scoped");
  return value;
}
