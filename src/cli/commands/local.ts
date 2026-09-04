import type { LocalInferenceDevice, LocalInferenceProfile } from "../../domain/index.js";
import { invalidInput } from "../../foundation/index.js";
import { doctorLocalInference, prepareLocalInference, resolveLocalInferenceDevice } from "../../inference/index.js";
import { daemonClient, probeDaemonHealth } from "../../daemon/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function localCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "prepare") {
    const model = args.shift();
    const device = localDevice(takeOption(args, "--device") || "auto");
    const profile = localProfile(takeOption(args, "--profile") || "baseline");
    const offline = takeFlag(args, "--offline");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    if (!model) throw invalidInput("local prepare requires local/<name>");
    const prepared = await prepareLocalInference({
      root,
      selection: { model, device, profile, offline },
      ...(json ? {} : { onProgress: (message) => process.stderr.write(`${message}\n`) }),
    });
    if (json) process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    else process.stdout.write(`Prepared ${model} for ${prepared.lock.execution.platform.backend} (${prepared.lock.inference_id})\n`);
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
      process.stdout.write(`Local inference ${doctor.backend}: ${doctor.ready ? "ready" : "unavailable"}\n`);
      for (const [name, check] of Object.entries(doctor.checks)) process.stdout.write(`  ${name.padEnd(10)} ${check.status}  ${check.message}\n`);
    }
    if (!doctor.ready) process.exitCode = 3;
    return;
  }
  if (action === "status") {
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    const health = await probeDaemonHealth(root);
    const services = health ? ((await (await daemonClient(root)).request("/v1/inference/services")).services ?? []) : [];
    if (json) process.stdout.write(`${JSON.stringify({ schema_version: "1", services }, null, 2)}\n`);
    else process.stdout.write(services instanceof Array && services.length ? `${services.length} local inference service(s)\n` : "No local inference services\n");
    return;
  }
  if (action === "stop") {
    const serviceId = args[0]?.startsWith("--") ? undefined : args.shift();
    const force = takeFlag(args, "--force");
    assertNoArgs(args);
    const health = await probeDaemonHealth(root);
    if (!health) { process.stdout.write("No local inference services\n"); return; }
    const client = await daemonClient(root);
    const listing = await client.request("/v1/inference/services");
    const services = (listing.services instanceof Array ? listing.services : []) as Array<{ service_id?: unknown; state?: unknown }>;
    const ids = serviceId ? [serviceId] : services.filter((service) => service.state !== "stopped" && service.state !== "failed")
      .map((service) => service.service_id).filter((value): value is string => typeof value === "string");
    for (const id of ids) await client.request(`/v1/inference/services/${id}/stop`, {
      method: "POST", body: JSON.stringify({ force }),
    });
    process.stdout.write(`Stopped ${ids.length} local inference service(s)\n`);
    return;
  }
  throw invalidInput("local requires prepare, doctor, status, or stop");
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
