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
  const ledger = new ResourceLedger({ cpu_millis: 2_000, memory_bytes: 2 * 1024 ** 3, container_slots: 1, build_slots: 0, gpu_count: 1 });
  const reports: Array<{ role: string; container_id: string; gpu_inventory: string[]; device_request: unknown }> = [];
  try {
    await command(["image", "inspect", image]);
    for (const role of ["candidate", "separate-verifier"] as const) {
      const allocation = ledger.tryAcquire(`gpu-${role}`, "eval", {
        cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 0, gpu_count: 1,
      });
      if (!allocation) throw new Error(`GPU admission did not reserve ${role}`);
      try {
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
        if (logs.length < 1 || logs.some((line) => !/^GPU-[A-Fa-f0-9-]+,\s*.+/.test(line))) throw new Error(`${role} returned invalid GPU inventory`);
        const inspected = JSON.parse((await command(["container", "inspect", "--format", "{{json .HostConfig.DeviceRequests}}", id])).stdout) as unknown;
        if (!Array.isArray(inspected) || inspected.length < 1 || !JSON.stringify(inspected).toLowerCase().includes("gpu")) {
          throw new Error(`${role} did not receive an explicit Docker GPU device request`);
        }
        reports.push({ role, container_id: id, gpu_inventory: logs, device_request: inspected });
      } finally {
        allocation.release();
      }
    }
    if (Object.values(ledger.snapshot().allocated).some((value) => value !== 0)) throw new Error("GPU canary leaked a scheduler reservation");
    if (reports[0]?.gpu_inventory[0]?.split(",")[0] !== reports[1]?.gpu_inventory[0]?.split(",")[0]) {
      throw new Error("Candidate and separate Verifier did not observe the same reserved GPU device");
    }
    process.stdout.write(`${JSON.stringify({
      schema_version: "1", status: "passed", docker: (await command(["version", "--format", "{{.Server.Version}}"])).stdout.trim(),
      image, gpu_count: reports[0]?.gpu_inventory.length ?? 0, roles: reports, ledger_released: true,
    }, null, 2)}\n`);
  } finally {
    for (const id of containers) spawnSync(docker, ["container", "rm", "--force", id], { encoding: "utf8" });
  }
}

function command(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return runCommand(docker, args, { env: process.env, timeoutMs, failureCode: "gpu_hardware_canary_failed" });
}
