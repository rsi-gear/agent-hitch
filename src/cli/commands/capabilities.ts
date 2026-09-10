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
    training_external_binding: "1",
    exact_policy_tokens: "1",
    training_policy_fencing: "1",
    training_harnesses: ["training-tool"],
    training_gpu_validation: "pending",
    managed_model_node: "2",
    model_node_usage: "2",
    model_node_storage: "1",
    ordered_eval_control: "2",
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
