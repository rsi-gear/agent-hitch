import { DEFAULT_HARBOR_VERSION, doctorHarbor, setupHarbor } from "../../backends/index.js";
import type { EvalExecutionPolicyV1, ResourceVectorV1 } from "../../domain/index.js";
import { inspectEval, isControlPlaneEval, listEvals, parseEvalRerunType, rerunEval, runEval, runBenchmarkEval, validateEvalId } from "../../evals/index.js";
import { daemonClient, probeDaemonHealth } from "../../daemon/index.js";
import { HitchError, SCHEMA_VERSION, invalidInput, positiveInteger } from "../../foundation/index.js";
import { assertNoArgs, parseEvalRequest, takeFlag, takeOption, takeRepeatedOption } from "../arguments.js";
import { waitForDaemonEval, waitForDaemonEvalRerun } from "../output.js";

export async function evalCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  switch (action) {
    case "run": return evalRunCommand(args, root);
    case "submit": return evalSubmitCommand(args, root);
    case "watch": return evalWatchCommand(args, root);
    case "cancel": return evalCancelCommand(args, root);
    case "rerun": return evalRerunCommand(args, root);
    case "rerun-cancel": return evalRerunCancelCommand(args, root);
    case "list": return evalListCommand(args, root);
    case "inspect": return evalInspectCommand(args, root);
    case "setup": return evalSetupCommand(args, root);
    case "doctor": return evalDoctorCommand(args, root);
    default: throw invalidInput("eval requires run, submit, watch, cancel, rerun, rerun-cancel, list, inspect, setup, or doctor");
  }
}

async function evalRerunCommand(args: string[], root: string): Promise<void> {
  const evalIdValue = args.shift();
  if (!evalIdValue) throw invalidInput("eval rerun requires an eval ID");
  const evalId = validateEvalId(evalIdValue);
  const invalid = takeFlag(args, "--invalid");
  let useDaemon = takeFlag(args, "--daemon");
  const taskNames = takeRepeatedOption(args, "--task");
  const rerunType = parseEvalRerunType(takeOption(args, "--type") || "candidate-restart");
  const verifierRuntimeId = takeOption(args, "--verifier-runtime");
  if (verifierRuntimeId !== undefined && (rerunType !== "verifier-only" || !/^sha256:[a-f0-9]{64}$/.test(verifierRuntimeId))) throw invalidInput("--verifier-runtime requires verifier-only and an exact runtime digest");
  const rerunId = takeOption(args, "--rerun-id");
  if (rerunId !== undefined && !/^rerun_[a-f0-9]{32}$/.test(rerunId)) throw invalidInput("eval rerun id is invalid");
  const output = takeOption(args, "--output") || "json";
  const harborExecutable = takeOption(args, "--harbor");
  assertNoArgs(args);
  if (output !== "json") throw invalidInput("eval rerun --output must be json");
  if (invalid === (taskNames.length > 0)) throw invalidInput("eval rerun requires exactly one of --invalid or --task");
  if (!useDaemon && await isControlPlaneEval(root, evalId)) {
    if (!(await probeDaemonHealth(root))) {
      throw new HitchError("control-plane eval reruns require a running daemon; start it and retry with --daemon", {
        code: "control_plane_required",
        exitCode: 2,
      });
    }
    useDaemon = true;
  }
  if (useDaemon) {
    if (harborExecutable !== undefined) throw invalidInput("eval rerun --harbor cannot be combined with --daemon");
    const client = await daemonClient(root);
    const accepted = await client.request(`/v1/evals/${evalId}/reruns`, {
      method: "POST",
      body: JSON.stringify({
        ...(rerunId === undefined ? {} : { rerun_id: rerunId }),
        rerun_type: rerunType,
        ...(verifierRuntimeId ? { verifier_runtime_id: verifierRuntimeId } : {}),
        selector: invalid ? { mode: "invalid" } : { mode: "tasks", task_names: taskNames },
      }),
    });
    await waitForDaemonEvalRerun(client, evalId, accepted.rerun_id as string);
    return;
  }
  if (rerunId !== undefined) throw invalidInput("--rerun-id requires a daemon rerun");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await rerunEval({
      evalId,
      root,
      rerunType,
      ...(verifierRuntimeId ? { verifierRuntimeId } : {}),
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

async function evalRerunCancelCommand(args: string[], root: string): Promise<void> {
  const evalId = validateEvalId(args.shift() || "");
  const rerunId = args.shift();
  if (!rerunId || !/^rerun_[a-f0-9]{32}$/.test(rerunId)) throw invalidInput("eval rerun-cancel requires a rerun ID");
  assertNoArgs(args);
  const result = await (await daemonClient(root)).request(`/v1/evals/${evalId}/reruns/${rerunId}/cancel`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const benchmark = takeOption(args, "--benchmark");
  const benchmarkLock = takeOption(args, "--benchmark-lock");
  const useDaemon = takeFlag(args, "--daemon");
  const idempotencyKey = takeOption(args, "--idempotency-key");
  const output = takeOption(args, "--output") || "json";
  const harborExecutable = takeOption(args, "--harbor");
  const requestedEvalId = takeOption(args, "--eval-id");
  const executionOptions = parseEvalExecutionOptions(args);
  const request = parseEvalRequest(args, Boolean(benchmark || benchmarkLock));
  assertNoArgs(args);
  if (!new Set(["json", "jsonl"]).has(output)) throw invalidInput("--output must be json or jsonl");
  if (useDaemon) {
    if (benchmark || benchmarkLock) throw invalidInput("standard package runs currently require a local root without --daemon");
    if (requestedEvalId !== undefined) throw invalidInput("--eval-id is unavailable with --daemon; submission IDs are server-assigned");
    if (harborExecutable !== undefined) throw invalidInput("--harbor is unavailable with --daemon; configure Harbor for the daemon environment");
    const client = await daemonClient(root);
    const submission = await daemonEvalSubmission(client, request, executionOptions);
    const accepted = await client.request("/v1/evals", {
      method: "POST",
      body: JSON.stringify(submission),
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
    const result = await waitForDaemonEval(client, accepted.eval_id as string, output);
    process.exitCode = result.exit_code as number;
    return;
  }
  if (executionOptions.explicit) throw invalidInput("eval execution policy options require --daemon or eval submit");
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
    const run = benchmark || benchmarkLock ? runBenchmarkEval : runEval;
    const result = await run({
      ...(benchmark ? { benchmark } : {}),
      ...(benchmarkLock ? { benchmarkLock } : {}),
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
  const executionOptions = parseEvalExecutionOptions(args);
  const request = parseEvalRequest(args);
  assertNoArgs(args);
  const client = await daemonClient(root);
  const submission = await daemonEvalSubmission(client, request, executionOptions);
  const accepted = await client.request("/v1/evals", {
    method: "POST",
    body: JSON.stringify(submission),
    ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
  });
  process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
}

export interface EvalCliExecutionOptions {
  explicit: boolean;
  provider?: string;
  cpu_millis?: number;
  memory_bytes?: number;
  build_mode?: EvalExecutionPolicyV1["build"]["mode"];
  model_capture?: EvalExecutionPolicyV1["model_capture"]["mode"];
  require_model_capture: boolean;
}

export function parseEvalExecutionOptions(args: string[]): EvalCliExecutionOptions {
  const provider = takeOption(args, "--provider");
  const cpuValue = takeOption(args, "--cpu-per-trial");
  const memoryValue = takeOption(args, "--memory-per-trial");
  const buildMode = takeOption(args, "--build-mode");
  const modelCapture = takeOption(args, "--model-capture");
  const requireModelCapture = takeFlag(args, "--require-model-capture");
  if (provider !== undefined && (!provider.trim() || /[\0\r\n]/.test(provider))) throw invalidInput("--provider must be a non-empty provider id");
  if (buildMode !== undefined && !new Set(["backend", "prebuild-preferred", "prebuild-required"]).has(buildMode)) {
    throw invalidInput("--build-mode must be backend, prebuild-preferred, or prebuild-required");
  }
  if (modelCapture !== undefined && !new Set(["off", "native", "proxy", "hybrid"]).has(modelCapture)) {
    throw invalidInput("--model-capture must be off, native, proxy, or hybrid");
  }
  if (modelCapture === "off" && requireModelCapture) throw invalidInput("--model-capture off cannot be combined with --require-model-capture");
  const cpu = cpuValue === undefined ? undefined : positiveInteger(cpuValue, "--cpu-per-trial") * 1_000;
  if (cpu !== undefined && !Number.isSafeInteger(cpu)) throw invalidInput("--cpu-per-trial is too large");
  return {
    explicit: provider !== undefined || cpuValue !== undefined || memoryValue !== undefined || buildMode !== undefined || modelCapture !== undefined || requireModelCapture,
    ...(provider === undefined ? {} : { provider: provider.trim() }),
    ...(cpu === undefined ? {} : { cpu_millis: cpu }),
    ...(memoryValue === undefined ? {} : { memory_bytes: parseMemorySize(memoryValue) }),
    ...(buildMode === undefined ? {} : { build_mode: buildMode as EvalExecutionPolicyV1["build"]["mode"] }),
    ...(modelCapture === undefined ? {} : { model_capture: modelCapture as EvalExecutionPolicyV1["model_capture"]["mode"] }),
    require_model_capture: requireModelCapture,
  };
}

export function buildDaemonEvalSubmission(
  request: Record<string, unknown>,
  options: EvalCliExecutionOptions,
  defaultTrial: ResourceVectorV1,
): Record<string, unknown> {
  if (!options.explicit) return request;
  const maxParallelism = request.max_concurrent;
  if (!Number.isSafeInteger(maxParallelism) || (maxParallelism as number) < 1) throw invalidInput("eval max_concurrent is invalid");
  const resources: ResourceVectorV1 = {
    ...defaultTrial,
    ...(options.cpu_millis === undefined ? {} : { cpu_millis: options.cpu_millis }),
    ...(options.memory_bytes === undefined ? {} : { memory_bytes: options.memory_bytes }),
  };
  if (resources.cpu_millis < 1 || resources.memory_bytes < 1 || resources.container_slots < 1 || resources.build_slots !== 0) {
    throw new HitchError("daemon eval trial resource defaults are invalid", { code: "daemon_resource_policy_invalid", exitCode: 12 });
  }
  return {
    schema_version: SCHEMA_VERSION,
    request,
    execution: {
      provider: options.provider ?? "local-docker",
      max_parallelism: maxParallelism,
      resources: { default_trial: resources },
      build: { mode: options.build_mode ?? "prebuild-preferred" },
      model_capture: { mode: options.model_capture ?? "native", required: options.require_model_capture },
    },
  };
}

async function daemonEvalSubmission(
  client: Awaited<ReturnType<typeof daemonClient>>,
  request: Record<string, unknown>,
  options: EvalCliExecutionOptions,
): Promise<Record<string, unknown>> {
  if (!options.explicit) return request;
  const health = await client.request("/health");
  const policy = health.resource_policy;
  const evalTrial = policy && typeof policy === "object" && !Array.isArray(policy)
    ? (policy as Record<string, unknown>).eval_trial
    : undefined;
  return buildDaemonEvalSubmission(request, options, parseHealthResourceVector(evalTrial));
}

function parseHealthResourceVector(value: unknown): ResourceVectorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HitchError("daemon health has no eval trial resource policy", { code: "daemon_resource_policy_unavailable", exitCode: 12 });
  }
  const record = value as Record<string, unknown>;
  const required = ["cpu_millis", "memory_bytes", "container_slots", "build_slots"] as const;
  if (required.some((field) => !Number.isSafeInteger(record[field]) || (record[field] as number) < 0)
    || (record.gpu_count !== undefined && (!Number.isSafeInteger(record.gpu_count) || (record.gpu_count as number) < 0))
    || (record.ephemeral_disk_bytes !== undefined && (!Number.isSafeInteger(record.ephemeral_disk_bytes) || (record.ephemeral_disk_bytes as number) < 0))) {
    throw new HitchError("daemon health eval trial resource policy is invalid", { code: "daemon_resource_policy_invalid", exitCode: 12 });
  }
  return {
    cpu_millis: record.cpu_millis as number,
    memory_bytes: record.memory_bytes as number,
    container_slots: record.container_slots as number,
    build_slots: record.build_slots as number,
    ...(record.gpu_count === undefined ? {} : { gpu_count: record.gpu_count as number }),
    ...(record.ephemeral_disk_bytes === undefined ? {} : { ephemeral_disk_bytes: record.ephemeral_disk_bytes as number }),
  };
}

function parseMemorySize(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/i);
  if (!match) throw invalidInput("--memory-per-trial must use B, KiB, MiB, or GiB units");
  const amount = Number(match[1]);
  const unit = (match[2] as string).toLowerCase();
  const multiplier = unit === "gib" ? 1024 ** 3 : unit === "mib" ? 1024 ** 2 : unit === "kib" ? 1024 : 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 ** 2 || bytes % (1024 ** 2) !== 0) {
    throw invalidInput("--memory-per-trial must be a positive whole number of MiB");
  }
  return bytes;
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
