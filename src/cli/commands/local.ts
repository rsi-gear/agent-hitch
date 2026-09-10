import { ensureLocalInferenceDaemon } from "./daemon.js";
import type { LocalInferenceDevice, LocalInferenceProfile } from "../../domain/index.js";
import { invalidInput } from "../../foundation/index.js";
import { doctorLocalInference, resolveLocalInferenceDevice, loadInferenceLock, prepareLocalInference } from "../../inference/index.js";
import { daemonClient, probeDaemonHealth } from "../../daemon/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";
import { readModelNodeBinding, inspectModelNodeService, readServiceRecords } from "../../inference/index.js";

export async function localCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "inspect-service") {
    const serviceId = args.shift(); takeFlag(args, "--json"); assertNoArgs(args);
    if (!serviceId || !/^inference_[a-f0-9]{32}$/.test(serviceId)) throw invalidInput("local inspect-service requires a model-node service ID");
    process.stdout.write(`${JSON.stringify(await inspectModelNodeService(root, serviceId), null, 2)}\n`);
    return;
  }
  if (action === "plan") {
    const model = args.shift();
    const harnessRef = takeOption(args, "--harness");
    const gpu = takeOption(args, "--gpu");
    const nodeFile = takeOption(args, "--model-node-file");
    const modelNode = nodeFile ? await readModelNodeBinding(nodeFile) : undefined;
    const offline = takeFlag(args, "--offline");
    takeFlag(args, "--json");
    assertNoArgs(args);
    if (!model || !harnessRef || !gpu || !/^GPU-[a-fA-F0-9-]+$/.test(gpu)) throw invalidInput("local plan requires MODEL --harness REF --gpu GPU-UUID");
    const planned = await prepareLocalInference({ root, selection: { model, device: "cuda", profile: "baseline", offline, ...(modelNode ? { model_node: modelNode } : {}) },
      harnessRef, doctor: { deviceConstraint: gpu } });
    process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`);
    return;
  }
  if (action === "inspect") {
    const id = args.shift();
    takeFlag(args, "--json");
    assertNoArgs(args);
    if (!id || !/^sha256:[a-f0-9]{64}$/.test(id)) throw invalidInput("local inspect requires an exact inference digest");
    process.stdout.write(`${JSON.stringify(await loadInferenceLock(root, id as `sha256:${string}`), null, 2)}\n`);
    return;
  }
  if (action === "prepare") {
    const model = args.shift();
    const inferenceId = takeOption(args, "--inference");
    const nodeFile = takeOption(args, "--model-node-file");
    const modelNode = nodeFile ? await readModelNodeBinding(nodeFile) : undefined;
    const device = localDevice(takeOption(args, "--device") || "auto");
    const profile = localProfile(takeOption(args, "--profile") || "baseline");
    const offline = takeFlag(args, "--offline");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    if (!model) throw invalidInput("local prepare requires local/<name>");
    if (inferenceId && !/^sha256:[a-f0-9]{64}$/.test(inferenceId)) throw invalidInput("--inference requires a SHA-256 digest");
    await ensureLocalInferenceDaemon(root);
    const prepared = await (await daemonClient(root)).prepareInference({ model, device, profile, offline,
      ...(modelNode ? { model_node: modelNode } : {}), ...(inferenceId ? { inference_id: inferenceId as `sha256:${string}` } : {}) },
      json ? undefined : (message) => process.stderr.write(`${message}\n`));
    if (json) process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    else process.stdout.write(`Validated ${model} (${(prepared.lock as { inference_id: string }).inference_id})\n`);
    return;
  }
  if (action === "doctor") {
    const device = localDevice(takeOption(args, "--device") || "auto");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const doctor = device === "auto"
      ? (await resolveLocalInferenceDevice("auto")).doctor
      : await doctorLocalInference(device);
    if (json) process.stdout.write(`${JSON.stringify(doctor, null, 2)}\n`);
    else {
      process.stdout.write(`Local inference ${doctor.backend}: ${doctor.ready ? "eligible; run prepare to validate" : "unavailable"}\n`);
      for (const [name, check] of Object.entries(doctor.checks)) process.stdout.write(`  ${name.padEnd(10)} ${check.status}  ${check.message}\n`);
    }
    if (!doctor.ready) process.exitCode = 3;
    return;
  }
  if (action === "status") {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const health = await probeDaemonHealth(root);
    const services = health ? ((await (await daemonClient(root)).request("/v1/inference/services")).services ?? []) : await readServiceRecords(root);
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: "1", services }, null, 2)}\n`);
    else process.stdout.write(services instanceof Array && services.length ? `${services.length} local inference service(s)\n` : "No local inference services\n");
    return;
  }
  if (action === "stop") {
    const serviceId = args[0]?.startsWith("--") ? undefined : args.shift();
    const force = takeFlag(args, "--force");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const health = await probeDaemonHealth(root);
    if (!health) { process.stdout.write(json ? '{"stopped":0}\n' : "No local inference services\n"); return; }
    const client = await daemonClient(root);
    const listing = await client.request("/v1/inference/services");
    const services = (listing.services instanceof Array ? listing.services : []) as Array<{ service_id?: unknown; state?: unknown }>;
    const ids = serviceId ? [serviceId] : services.filter((service) => service.state !== "stopped" && service.state !== "failed")
      .map((service) => service.service_id).filter((value): value is string => typeof value === "string");
    for (const id of ids) await client.request(`/v1/inference/services/${id}/stop`, {
      method: "POST", body: JSON.stringify({ force }),
    });
    process.stdout.write(json ? `${JSON.stringify({ stopped: ids.length })}\n` : `Stopped ${ids.length} local inference service(s)\n`);
    return;
  }
  throw invalidInput("local requires plan, prepare, inspect, doctor, status, or stop");
}

function localDevice(value: string): LocalInferenceDevice {
  if (value !== "auto" && value !== "cpu" && value !== "cuda" && value !== "metal") {
    throw invalidInput("--device must be auto, cpu, cuda, or metal");
  }
  return value;
}

function localProfile(value: string): LocalInferenceProfile {
  if (value !== "baseline" && value !== "throughput") throw invalidInput("--profile must be baseline or throughput");
  return value;
}
