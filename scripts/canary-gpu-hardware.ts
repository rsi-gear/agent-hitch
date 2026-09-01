import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ResourceLedger } from "../src/control-plane/index.js";
import { runCommand } from "../src/foundation/index.js";

const docker = process.env.HITCH_DOCKER_PATH || "docker";
const image = process.env.HITCH_GPU_CANARY_IMAGE;

if (!image) {
  process.stdout.write(`${JSON.stringify({
    schema_version: "1", status: "unsupported", code: "gpu_canary_image_required",
    message: "set HITCH_GPU_CANARY_IMAGE to a locally available CUDA image containing nvidia-smi",
  }, null, 2)}\n`);
  process.exitCode = 3;
} else {
  await runCanary(image);
}

async function runCanary(image: string): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const containers: string[] = [];
  const ledger = new ResourceLedger({ cpu_millis: 2_000, memory_bytes: 2 * 1024 ** 3, container_slots: 2, build_slots: 0, gpu_count: 1 });
  const reports: Array<{ role: string; container_id: string; gpu_inventory: string[]; device_request: unknown }> = [];
  let gpuContentionBlocked = false;
  try {
    const imageInspection = JSON.parse((await command(["image", "inspect", "--format", "{{json .}}", image])).stdout) as { Id?: unknown; RepoDigests?: unknown };
    if (typeof imageInspection.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageInspection.Id)) throw new Error("GPU canary image identity is invalid");
    for (const role of ["candidate", "separate-verifier"] as const) {
      const allocation = ledger.tryAcquire(`gpu-${role}`, "eval", {
        cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0, gpu_count: 1,
      });
      if (!allocation) throw new Error(`GPU admission did not reserve ${role}`);
      try {
        if (role === "candidate") {
          const competing = ledger.tryAcquire("gpu-competing-trial", "eval", {
            cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0, gpu_count: 1,
          });
          gpuContentionBlocked = competing === null;
          competing?.release();
          if (!gpuContentionBlocked) throw new Error("GPU admission allowed two trials to consume one declared device");
        }
        const name = `hitch-gpu-${role}-${nonce}`;
        const id = (await command([
          "container", "run", "--detach", "--name", name, "--gpus", "1",
          "--label", "io.hitch.canary=gpu-hardware-v1", "--label", `io.hitch.role=${role}`,
          image, "/bin/sh", "-c", "nvidia-smi --query-gpu=uuid,name --format=csv,noheader; sleep 1",
        ], 30_000)).stdout.trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker returned an invalid ${role} container id`);
        containers.push(id);
        const exitCode = Number((await command(["container", "wait", id], 30_000)).stdout.trim());
        if (exitCode !== 0) throw new Error(`${role} could not execute nvidia-smi (exit ${exitCode})`);
        const logs = (await command(["container", "logs", id])).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (logs.length !== 1 || logs.some((line) => !/^GPU-[A-Fa-f0-9-]+,\s*.+/.test(line))) throw new Error(`${role} did not receive exactly one usable GPU`);
        const inspected = JSON.parse((await command(["container", "inspect", "--format", "{{json .HostConfig.DeviceRequests}}", id])).stdout) as unknown;
        if (!validSingleGpuDeviceRequest(inspected)) {
          throw new Error(`${role} did not receive an explicit Docker GPU device request`);
        }
        reports.push({ role, container_id: id, gpu_inventory: logs, device_request: inspected });
      } finally {
        allocation.release();
      }
    }
    if (Object.values(ledger.snapshot().allocated).some((value) => value !== 0)) throw new Error("GPU canary leaked a scheduler reservation");
    process.stdout.write(`${JSON.stringify({
      schema_version: "1", status: "passed", docker: (await command(["version", "--format", "{{.Server.Version}}"])).stdout.trim(),
      image, image_id: imageInspection.Id, repo_digests: Array.isArray(imageInspection.RepoDigests) ? imageInspection.RepoDigests : [],
      declared_gpu_capacity: 1, gpu_contention_blocked: gpuContentionBlocked,
      gpu_count_per_role: reports[0]?.gpu_inventory.length ?? 0, roles: reports, ledger_released: true,
    }, null, 2)}\n`);
  } finally {
    for (const id of containers) spawnSync(docker, ["container", "rm", "--force", id], { encoding: "utf8" });
  }
}

function validSingleGpuDeviceRequest(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const request = value[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const record = request as Record<string, unknown>;
  const exactlyOne = record.Count === 1 || Array.isArray(record.DeviceIDs) && record.DeviceIDs.length === 1;
  return exactlyOne && JSON.stringify(record.Capabilities).toLowerCase().includes("gpu");
}

function command(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return runCommand(docker, args, { env: process.env, timeoutMs, failureCode: "gpu_hardware_canary_failed" });
}
