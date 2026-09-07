import { readFile } from "node:fs/promises";
import type { LocalInferenceBackend, LocalInferenceDevice } from "../domain/index.js";
import { HitchError, runCommand } from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";

export interface InferenceDoctorCheckV1 { status: "pass" | "fail"; message: string }
export interface InferenceGpuV1 {
  uuid: string; name: string; memory_mib: number; free_memory_mib: number;
  driver_version: string; compute_capability: string;
}
export interface InferenceDoctorResultV1 {
  schema_version: "1";
  backend: LocalInferenceBackend;
  ready: boolean;
  checks: Record<string, InferenceDoctorCheckV1>;
  gpu?: InferenceGpuV1;
}
export interface InferenceDoctorOptions {
  platform?: NodeJS.Platform;
  architecture?: string;
  dockerExecutable?: string;
  nvidiaSmiExecutable?: string;
  env?: NodeJS.ProcessEnv;
  readCpuInfo?: () => Promise<string>;
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
  requiredMemoryMiB?: number;
  deviceConstraint?: string;
}

/** Static eligibility only. Loading, CUDA visibility and the protocol are verified by prepare. */
export async function doctorLocalInference(backend: LocalInferenceBackend, options: InferenceDoctorOptions = {}): Promise<InferenceDoctorResultV1> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const env = options.env ?? process.env;
  const invoke = options.run ?? ((executable: string, args: string[]) => runCommand(executable, args, {
    env, timeoutMs: 10_000, failureCode: "inference_runtime_unavailable", failureExitCode: 3,
  }));
  const checks: Record<string, InferenceDoctorCheckV1> = {};
  checks.platform = platform === "linux" && architecture === "x64"
    ? pass("linux/amd64") : fail(`P0 requires linux/amd64; detected ${platform}/${architecture}`);
  if (backend === "metal") {
    checks.catalog = fail("Metal/MLX is a P1 backend and has no P0 runtime catalog entry");
    return result(backend, checks);
  }
  try {
    const docker = options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker";
    const server = await invoke(docker, ["info", "--format", "{{json .}}"]);
    const info = JSON.parse(server.stdout) as Record<string, unknown>;
    checks.docker = info.OSType === "linux" && ["x86_64", "amd64"].includes(String(info.Architecture))
      ? pass(`Docker ${String(info.ServerVersion)}`) : fail("Docker Engine must run linux/amd64");
    const context = await invoke(docker, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
    const endpoint = env.DOCKER_CONTEXT ? JSON.parse(context.stdout) : env.DOCKER_HOST || JSON.parse(context.stdout);
    checks.docker_endpoint = typeof endpoint === "string" && endpoint.startsWith("unix:///")
      ? pass("local Unix socket") : fail("managed inference requires a local Docker Unix socket");
  } catch (error) { checks.docker = fail(`Docker is unavailable: ${(error as Error).message}`); }
  if (backend === "cpu") {
    let info = "";
    try { info = await (options.readCpuInfo ?? (() => readFile("/proc/cpuinfo", "utf8")))(); } catch {}
    const flags = new Set(info.toLowerCase().split(/[^a-z0-9_]+/));
    const missing = ["amx_tile", "amx_int8", "amx_bf16"].filter((flag) => !flags.has(flag));
    checks.amx = missing.length ? fail(`missing CPU flags: ${missing.join(", ")}`) : pass("AMX tile/int8/bf16");
    return result(backend, checks);
  }
  let gpu: InferenceGpuV1 | undefined;
  try {
    const observed = await invoke(options.nvidiaSmiExecutable || env.HITCH_NVIDIA_SMI_PATH || "nvidia-smi", [
      "--query-gpu=uuid,name,memory.total,memory.free,driver_version,compute_cap", "--format=csv,noheader,nounits",
    ]);
    const candidates = observed.stdout.trim().split(/\r?\n/).map(parseGpu);
    // The pinned image uses CUDA 13.0. Require the native driver floor; do not
    // assume forward-compat packages work on an arbitrary device/driver pair.
    const eligible = candidates.filter((entry) => Number(entry.driver_version.split(".")[0]) >= 580
      && [8.0, 8.6, 8.9, 9.0, 10.0, 10.3, 12.0].includes(Number(entry.compute_capability))
      && entry.free_memory_mib >= (options.requiredMemoryMiB ?? 0)
      && (!options.deviceConstraint || entry.uuid === options.deviceConstraint));
    gpu = eligible[0];
    checks.cuda = gpu ? pass(`${gpu.name} (${gpu.uuid}), ${gpu.free_memory_mib} MiB free, driver ${gpu.driver_version}`)
      : fail(`no eligible CUDA 13 GPU: require driver >=580, supported SM, ${options.requiredMemoryMiB ?? 0} MiB free${options.deviceConstraint ? ` on ${options.deviceConstraint}` : ""}`);
  } catch (error) { checks.cuda = fail(`NVIDIA CUDA device is unavailable: ${(error as Error).message}`); }
  return { ...result(backend, checks), ...(gpu ? { gpu } : {}) };
}

export async function resolveLocalInferenceDevice(requested: LocalInferenceDevice, options: InferenceDoctorOptions = {}): Promise<{ backend: LocalInferenceBackend; doctor: InferenceDoctorResultV1 }> {
  for (const backend of requested === "auto" ? ["cuda", "cpu"] as const : [requested]) {
    const doctor = await doctorLocalInference(backend, options);
    if (doctor.ready) return { backend, doctor };
    if (requested !== "auto") throw unavailable(doctor);
  }
  throw new HitchError("no eligible local inference device is available; run hitch local doctor for diagnostics", {
    code: "inference_device_unsupported", exitCode: 3,
  });
}
function parseGpu(line: string): InferenceGpuV1 {
  const [uuid, name, total, free, driver, sm] = line.split(",").map((part) => part.trim());
  if (!uuid?.startsWith("GPU-") || !name || !driver || !sm || !Number.isFinite(Number(sm))
    || !Number.isFinite(Number(total)) || Number(total) <= 0 || !Number.isFinite(Number(free)) || Number(free) < 0) {
    throw new TypeError("nvidia-smi returned an invalid GPU record");
  }
  return { uuid, name, memory_mib: Number(total), free_memory_mib: Number(free), driver_version: driver, compute_capability: sm };
}
function result(backend: LocalInferenceBackend, checks: Record<string, InferenceDoctorCheckV1>): InferenceDoctorResultV1 {
  return { schema_version: "1", backend, ready: Object.values(checks).every((check) => check.status === "pass"), checks };
}
function pass(message: string): InferenceDoctorCheckV1 { return { status: "pass", message }; }
function fail(message: string): InferenceDoctorCheckV1 { return { status: "fail", message }; }
function unavailable(doctor: InferenceDoctorResultV1): HitchError {
  return new HitchError(`${doctor.backend} local inference is unavailable: ${Object.values(doctor.checks).filter((c) => c.status === "fail").map((c) => c.message).join("; ")}`, {
    code: "inference_device_unsupported", exitCode: 3,
  });
}
