import { SCHEMA_VERSION } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export function capabilitiesCommand(args: string[]): void {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const capabilities = {
    schema_version: SCHEMA_VERSION,
    trajectory_analysis: "1",
    trajectory_events_page: "1",
    verifier_evidence: "1",
    verifier_diagnostic_pages: "1",
    run_output_artifacts: "1",
    run_output_artifact_backends: ["local-docker"],
    training_external_binding: "1",
    external_endpoint_binding: "1",
    endpoint_evaluation_attempts: "1",
    endpoint_host_credentials: "1",
    endpoint_harnesses: ["codex", "model-call", "training-tool"],
    exact_policy_tokens: "1",
    training_policy_fencing: "1",
    training_harnesses: ["training-tool"],
    training_gpu_validation: "pending",
    ordered_eval_control: "2",
    evaluation_environment_binding: "3",
    evaluation_preparation: "1",
    evaluation_artifact_pins: "1",
    controller_runtime_observation: "2",
    local_execution_observation: "2",
    remote_execution_observation: "2",
  } as const;
  if (json) {
    process.stdout.write(`${JSON.stringify(capabilities)}\n`);
    return;
  }
  for (const [key, value] of Object.entries(capabilities)) process.stdout.write(`${key} ${Array.isArray(value) ? value.join(",") : value}\n`);
}
