import { DEFAULT_HARBOR_VERSION, doctorHarbor, setupHarbor } from "../../backends/index.js";
import { inspectEval, listEvals, parseEvalRerunType, rerunEval, runEval, validateEvalId } from "../../evals/index.js";
import { daemonClient, probeDaemonHealth } from "../../daemon/index.js";
import { HitchError, SCHEMA_VERSION, invalidInput } from "../../foundation/index.js";
import { assertNoArgs, parseEvalRequest, takeFlag, takeOption, takeRepeatedOption } from "../arguments.js";
import { waitForDaemonEval } from "../output.js";

export async function evalCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  switch (action) {
    case "run": return evalRunCommand(args, root);
    case "submit": return evalSubmitCommand(args, root);
    case "watch": return evalWatchCommand(args, root);
    case "cancel": return evalCancelCommand(args, root);
    case "rerun": return evalRerunCommand(args, root);
    case "list": return evalListCommand(args, root);
    case "inspect": return evalInspectCommand(args, root);
    case "setup": return evalSetupCommand(args, root);
    case "doctor": return evalDoctorCommand(args, root);
    default: throw invalidInput("eval requires run, submit, watch, cancel, rerun, list, inspect, setup, or doctor");
  }
}

async function evalRerunCommand(args: string[], root: string): Promise<void> {
  const evalIdValue = args.shift();
  if (!evalIdValue) throw invalidInput("eval rerun requires an eval ID");
  const evalId = validateEvalId(evalIdValue);
  const invalid = takeFlag(args, "--invalid");
  const taskNames = takeRepeatedOption(args, "--task");
  const rerunType = parseEvalRerunType(takeOption(args, "--type") || "candidate-restart");
  const output = takeOption(args, "--output") || "json";
  const harborExecutable = takeOption(args, "--harbor");
  assertNoArgs(args);
  if (output !== "json") throw invalidInput("eval rerun --output must be json");
  if (invalid === (taskNames.length > 0)) throw invalidInput("eval rerun requires exactly one of --invalid or --task");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await rerunEval({
      evalId,
      root,
      rerunType,
      selector: invalid ? { mode: "invalid" } : { mode: "tasks", taskNames },
      ...(harborExecutable === undefined ? {} : { harborExecutable }),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function evalSetupCommand(args: string[], root: string): Promise<void> {
  const backend = args.shift();
  if (backend !== "harbor") throw invalidInput("eval setup currently supports only harbor");
  const version = takeOption(args, "--version") || DEFAULT_HARBOR_VERSION;
  const python = takeOption(args, "--python");
  const force = takeFlag(args, "--force");
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const result = await setupHarbor({
    root,
    version,
    ...(python !== undefined ? { python } : {}),
    force,
    ...(json ? {} : { onProgress: (message) => process.stderr.write(`${message}\n`) }),
  });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.cache_hit ? "Using" : "Installed"} Harbor ${result.version} at ${result.executable}\n`);
}

async function evalDoctorCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const python = takeOption(args, "--python");
  const harbor = takeOption(args, "--harbor");
  const docker = takeOption(args, "--docker");
  assertNoArgs(args);
  const result = await doctorHarbor({
    root,
    ...(python !== undefined ? { python } : {}),
    ...(harbor !== undefined ? { harbor } : {}),
    ...(docker !== undefined ? { docker } : {}),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Harbor eval: ${result.status}\n`);
    for (const [name, check] of Object.entries(result.checks)) {
      const detail = check.version || check.message || (check.present?.length ? check.present.join(", ") : "");
      process.stdout.write(`  ${name.padEnd(12)} ${check.status}${detail ? `  ${detail}` : ""}\n`);
    }
  }
  if (!result.ready) process.exitCode = 3;
}

async function evalRunCommand(args: string[], root: string): Promise<void> {
  const useDaemon = takeFlag(args, "--daemon");
  const idempotencyKey = takeOption(args, "--idempotency-key");
  const output = takeOption(args, "--output") || "json";
  const harborExecutable = takeOption(args, "--harbor");
  const requestedEvalId = takeOption(args, "--eval-id");
  const request = parseEvalRequest(args);
  assertNoArgs(args);
  if (!new Set(["json", "jsonl"]).has(output)) throw invalidInput("--output must be json or jsonl");
  if (useDaemon) {
    if (requestedEvalId !== undefined) throw invalidInput("--eval-id is unavailable with --daemon; submission IDs are server-assigned");
    if (harborExecutable !== undefined) throw invalidInput("--harbor is unavailable with --daemon; configure Harbor for the daemon environment");
    const client = await daemonClient(root);
    const accepted = await client.request("/v1/evals", {
      method: "POST",
      body: JSON.stringify(request),
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
    const result = await waitForDaemonEval(client, accepted.eval_id as string, output);
    process.exitCode = result.exit_code as number;
    return;
  }
  if (idempotencyKey !== undefined) throw invalidInput("--idempotency-key requires --daemon");
  if ((await probeDaemonHealth(root))?.status === "running") {
    throw new HitchError("the daemon controls this root; use hitch eval run --daemon or a separate --root", {
      code: "control_plane_active",
      exitCode: 2,
    });
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runEval({
      ...(requestedEvalId !== undefined ? { evalId: validateEvalId(requestedEvalId) } : {}),
      request,
      root,
      ...(harborExecutable !== undefined ? { harborExecutable } : {}),
      signal: controller.signal,
      ...(output === "jsonl" ? { onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
    });
    if (output === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.exit_code;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function evalSubmitCommand(args: string[], root: string): Promise<void> {
  const idempotencyKey = takeOption(args, "--idempotency-key");
  const request = parseEvalRequest(args);
  assertNoArgs(args);
  const client = await daemonClient(root);
  const accepted = await client.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify(request),
    ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
  });
  process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
}

async function evalWatchCommand(args: string[], root: string): Promise<void> {
  const output = takeOption(args, "--output") || "jsonl";
  const evalIdValue = args.shift();
  if (!evalIdValue) throw invalidInput("eval watch requires an eval ID");
  const evalId = validateEvalId(evalIdValue);
  assertNoArgs(args);
  if (!new Set(["json", "jsonl"]).has(output)) throw invalidInput("--output must be json or jsonl");
  const result = await waitForDaemonEval(await daemonClient(root), evalId, output);
  process.exitCode = result.exit_code as number;
}

async function evalCancelCommand(args: string[], root: string): Promise<void> {
  const evalIdValue = args.shift();
  if (!evalIdValue) throw invalidInput("eval cancel requires an eval ID");
  const evalId = validateEvalId(evalIdValue);
  assertNoArgs(args);
  const result = await (await daemonClient(root)).request(`/v1/evals/${evalId}/cancel`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function evalListCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const evals = await listEvals({ root });
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, evals }, null, 2)}\n`);
    return;
  }
  if (evals.length === 0) {
    process.stdout.write("No evals found\n");
    return;
  }
  for (const evaluation of evals) {
    const reward = evaluation.primary_reward === null ? "-" : String(evaluation.primary_reward);
    process.stdout.write(`${evaluation.eval_id}  ${String(evaluation.status).padEnd(9)}  reward=${reward}  ${evaluation.harness_ref || "-"}  ${evaluation.dataset || "-"}\n`);
  }
}

async function evalInspectCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const evalId = args.shift();
  if (!evalId) throw invalidInput("eval inspect requires an eval ID");
  assertNoArgs(args);
  const evaluation = await inspectEval(evalId, { root });
  if (json) {
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    return;
  }
  const result = evaluation.result;
  process.stdout.write(`${evaluation.eval_id}: ${result?.status || evaluation.control?.state || "running"}\n`);
  process.stdout.write(`  dataset: ${evaluation.request?.dataset}\n`);
  process.stdout.write(`  harness: ${(evaluation.plan?.candidate as Record<string, unknown>)?.harness_ref || evaluation.request?.harness_ref}\n`);
  process.stdout.write(`  primary reward: ${(result?.summary as Record<string, unknown>)?.primary_reward ?? "-"}\n`);
  process.stdout.write(`  runtime storage: ${evaluation.runtime_storage}\n`);
  process.stdout.write(`  directory: ${evaluation.directory}\n`);
}
