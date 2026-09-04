import { readFile } from "node:fs/promises";
import type { LocalInferenceBackend, LocalInferenceDevice } from "../domain/index.js";
import { HitchError, runCommand } from "../foundation/index.js";
import type { CommandResult } from "../foundation/index.js";

export interface InferenceDoctorCheckV1 {
  status: "pass" | "fail";
  message: string;
}

export interface InferenceDoctorResultV1 {
  schema_version: "1";
  backend: LocalInferenceBackend;
  ready: boolean;
  checks: Record<string, InferenceDoctorCheckV1>;
  gpu?: { uuid: string; name: string; memory_mib: number; driver_version: string };
}

export interface InferenceDoctorOptions {
  platform?: NodeJS.Platform;
  architecture?: string;
  dockerExecutable?: string;
  nvidiaSmiExecutable?: string;
  env?: NodeJS.ProcessEnv;
  readCpuInfo?: () => Promise<string>;
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
}

export async function doctorLocalInference(
  backend: LocalInferenceBackend,
  options: InferenceDoctorOptions = {},
): Promise<InferenceDoctorResultV1> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const env = options.env ?? process.env;
  const invoke = options.run ?? ((executable: string, args: string[]) => runCommand(executable, args, {
    env, timeoutMs: 10_000, failureCode: "inference_runtime_unavailable", failureExitCode: 3,
  }));
  const checks: Record<string, InferenceDoctorCheckV1> = {};
  checks.platform = platform === "linux" && architecture === "x64"
    ? pass("linux/amd64")
    : fail(`P0 requires linux/amd64; detected ${platform}/${architecture}`);
  if (backend === "metal") {
    checks.catalog = fail("Metal/MLX is a P1 backend and has no P0 runtime catalog entry");
    return result(backend, checks);
  }
  try {
    const docker = await invoke(options.dockerExecutable || env.HITCH_DOCKER_PATH || "docker", ["version", "--format", "{{.Server.Version}}"]);
    checks.docker = docker.stdout.trim() ? pass(`Docker ${docker.stdout.trim()}`) : fail("Docker server version is empty");
  } catch (error) {
    checks.docker = fail(`Docker is unavailable: ${(error as Error).message}`);
  }
  if (backend === "cpu") {
    let cpuInfo = "";
    try { cpuInfo = await (options.readCpuInfo ?? (() => readFile("/proc/cpuinfo", "utf8")))(); } catch {}
    const flags = new Set(cpuInfo.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
    const missing = ["amx_tile", "amx_int8", "amx_bf16"].filter((flag) => !flags.has(flag));
    checks.amx = missing.length === 0 ? pass("AMX tile/int8/bf16") : fail(`missing CPU flags: ${missing.join(", ")}`);
    return result(backend, checks);
  }
  let gpu: InferenceDoctorResultV1["gpu"];
  try {
    const observed = await invoke(options.nvidiaSmiExecutable || env.HITCH_NVIDIA_SMI_PATH || "nvidia-smi", [
      "--query-gpu=uuid,name,memory.total,driver_version", "--format=csv,noheader,nounits",
    ]);
    const first = observed.stdout.trim().split(/\r?\n/)[0] || "";
    const fields = first.split(",").map((field) => field.trim());
    const memory = Number(fields[2]);
    if (fields.length < 4 || !fields[0] || !fields[1] || !Number.isFinite(memory) || memory <= 0 || !fields[3]) {
      throw new TypeError("nvidia-smi returned an invalid GPU record");
    }
    gpu = { uuid: fields[0], name: fields[1], memory_mib: memory, driver_version: fields[3] };
    checks.cuda = pass(`${gpu.name} (${gpu.uuid}), ${gpu.memory_mib} MiB, driver ${gpu.driver_version}`);
  } catch (error) {
    checks.cuda = fail(`NVIDIA CUDA device is unavailable: ${(error as Error).message}`);
  }
  const output = result(backend, checks);
  return gpu ? { ...output, gpu } : output;
}

export async function resolveLocalInferenceDevice(
  requested: LocalInferenceDevice,
  options: InferenceDoctorOptions = {},
): Promise<{ backend: LocalInferenceBackend; doctor: InferenceDoctorResultV1 }> {
  if (requested !== "auto") {
    const doctor = await doctorLocalInference(requested, options);
    if (!doctor.ready) throw unavailable(doctor);
    return { backend: requested, doctor };
  }
  const cuda = await doctorLocalInference("cuda", options);
  if (cuda.ready) return { backend: "cuda", doctor: cuda };
  const cpu = await doctorLocalInference("cpu", options);
  if (cpu.ready) return { backend: "cpu", doctor: cpu };
  throw new HitchError("no certified local inference device is available", {
    code: "inference_device_unsupported", exitCode: 3,
    cause: { cuda: cuda.checks, cpu: cpu.checks },
  });
}

function result(backend: LocalInferenceBackend, checks: Record<string, InferenceDoctorCheckV1>): InferenceDoctorResultV1 {
  return { schema_version: "1", backend, ready: Object.values(checks).every((check) => check.status === "pass"), checks };
}

function pass(message: string): InferenceDoctorCheckV1 { return { status: "pass", message }; }
function fail(message: string): InferenceDoctorCheckV1 { return { status: "fail", message }; }

function unavailable(doctor: InferenceDoctorResultV1): HitchError {
  const detail = Object.values(doctor.checks).filter((check) => check.status === "fail").map((check) => check.message).join("; ");
  return new HitchError(`${doctor.backend} local inference is unavailable: ${detail}`, {
    code: "inference_device_unsupported", exitCode: 3,
  });
}
