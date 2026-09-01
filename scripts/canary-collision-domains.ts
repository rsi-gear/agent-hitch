import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runCommand } from "../src/foundation/index.js";

const docker = process.env.HITCH_DOCKER_PATH || "docker";
const base = process.env.HITCH_COLLISION_CANARY_BASE || "ubuntu:24.04";
const endpoints = (process.env.HITCH_COLLISION_DOMAIN_DOCKER_HOSTS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);

if (endpoints.length !== 2) {
  process.stdout.write(`${JSON.stringify({
    schema_version: "1", status: "unsupported", code: "two_docker_endpoints_required",
    message: "set HITCH_COLLISION_DOMAIN_DOCKER_HOSTS to two comma-separated Docker endpoints",
  }, null, 2)}\n`);
  process.exitCode = 3;
} else {
  await runCanary(endpoints as [string, string]);
}

async function runCanary(hosts: [string, string]): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const name = `hitch-collision-domain-${nonce}`;
  const containers = new Map<string, string>();
  const startedAt = Date.now();
  try {
    const engines = await Promise.all(hosts.map(async (host) => {
      const [id, version] = (await command(host, ["info", "--format", "{{.ID}} {{.ServerVersion}}"])).stdout.trim().split(/\s+/);
      if (!id || !version) throw new Error(`Docker endpoint did not expose a stable engine identity: ${host}`);
      return { host, id, version };
    }));
    if (engines[0]!.id === engines[1]!.id) {
      process.stdout.write(`${JSON.stringify({
        schema_version: "1", status: "unsupported", code: "collision_domains_not_independent",
        engines,
      }, null, 2)}\n`);
      process.exitCode = 3;
      return;
    }
    await Promise.all(engines.map((engine) => command(engine.host, ["image", "inspect", base])));
    const launches = await Promise.all(engines.map(async (engine) => {
      const id = (await command(engine.host, [
        "container", "run", "--detach", "--name", name,
        "--label", "io.hitch.canary=collision-domain-v1",
        "--label", "io.hitch.task-id=same-task",
        "--label", `io.hitch.collision-domain-id=${engine.id}`,
        base, "/bin/sh", "-c", "sleep 3",
      ])).stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker endpoint returned an invalid container id: ${engine.host}`);
      containers.set(engine.host, id);
      return { ...engine, container_id: id };
    }));
    const running = await Promise.all(launches.map(async (entry) => ({
      ...entry,
      running: (await command(entry.host, ["container", "inspect", "--format", "{{.State.Running}}", entry.container_id])).stdout.trim() === "true",
    })));
    if (running.some((entry) => !entry.running)) throw new Error("same-task containers did not overlap across independent collision domains");
    const exitCodes = await Promise.all(running.map(async (entry) => Number((await command(entry.host, ["container", "wait", entry.container_id], 10_000)).stdout.trim())));
    if (exitCodes.some((code) => code !== 0)) throw new Error(`collision-domain container failed: ${exitCodes.join(",")}`);
    process.stdout.write(`${JSON.stringify({
      schema_version: "1", status: "passed", task_id: "same-task", identical_container_name: name,
      engines: running.map(({ host, id, version, container_id }) => ({ host, collision_domain_id: id, docker_version: version, container_id })),
      overlap_observed: true, duration_ms: Date.now() - startedAt,
    }, null, 2)}\n`);
  } finally {
    for (const [host, id] of containers) spawnSync(docker, ["--host", host, "container", "rm", "--force", id], { encoding: "utf8" });
  }
}

function command(host: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return runCommand(docker, ["--host", host, ...args], {
    env: process.env, timeoutMs, failureCode: "collision_domain_canary_failed",
  });
}
