import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvironmentImageManifestV1, EnvironmentImageUseV1, Sha256 } from "../src/domain/index.js";
import { dockerOwnershipLabelMap, startDockerResourceObserver } from "../src/evals/index.js";
import { verifyTrialEnvironmentImageExecution } from "../src/evals/trial-environment-evidence.js";

const docker = process.env.HITCH_DOCKER_PATH || "docker";
const base = process.env.HITCH_DOCKER_CANARY_BASE || "ubuntu:24.04";
const platform = process.env.HITCH_DOCKER_CANARY_PLATFORM || "linux/amd64";
const nonce = randomBytes(8).toString("hex");
const temporary = await mkdtemp(path.join(tmpdir(), "hitch-docker-image-canary-"));
const context = path.join(temporary, "context");
const roles = ["main", "sidecar", "verifier"] as const;
const tags = Object.fromEntries(roles.map((role) => [role, `hitch-image-observation-canary-${role}:${nonce}`])) as Record<typeof roles[number], string>;
const containers: string[] = [];
let exportContainer: string | undefined;

const ownership = {
  root_id: randomBytes(12).toString("hex"),
  provider: "local-docker" as const,
  eval_id: `eval_${randomBytes(16).toString("hex")}`,
  work_id: `work_${randomBytes(16).toString("hex")}`,
  lease_id: `lease_${randomBytes(16).toString("hex")}`,
  lease_epoch: 1,
  task_id: "docker-image-observation-canary",
};

try {
  await mkdir(context);
  const baseInspect = run(["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", base]);
  const [baseIdentity, basePlatform] = baseInspect.stdout.trim().split(" ");
  if (!baseIdentity || !/^sha256:[a-f0-9]{64}$/.test(baseIdentity) || basePlatform !== platform) {
    throw new Error(`local canary base platform does not match ${platform}`);
  }
  exportContainer = run(["create", "--platform", platform, base]).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(exportContainer)) throw new Error("Docker returned an invalid temporary container id");
  run(["export", "--output", path.join(context, "rootfs.tar"), exportContainer]);
  run(["container", "rm", exportContainer]);
  exportContainer = undefined;
  await writeFile(path.join(context, "Dockerfile"), [
    "FROM scratch",
    "ADD rootfs.tar /",
    "ARG HITCH_CANARY_ROLE",
    "LABEL io.hitch.canary-role=$HITCH_CANARY_ROLE",
    "ENTRYPOINT [\"/bin/sh\", \"-c\", \"i=0; while [ \\\"$i\\\" -lt 50000 ]; do i=$((i+1)); done; while :; do sleep 1; done\"]",
    "",
  ].join("\n"));

  const expected = new Map<string, Sha256>();
  for (const role of roles) {
    run([
      "buildx", "build", "--load", "--provenance=false", "--progress", "plain",
      "--platform", platform,
      "--build-arg", `HITCH_CANARY_ROLE=${role}`,
      "--tag", tags[role],
      context,
    ]);
    const digest = run(["image", "inspect", "--format", "{{.Id}}", tags[role]]).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Docker returned an invalid ${role} config digest`);
    expected.set(role, digest as Sha256);
  }
  if (new Set(expected.values()).size !== roles.length) throw new Error("canary role images do not have distinct config digests");

  const labels = dockerOwnershipLabelMap(ownership);
  for (const role of roles) {
    const args = ["container", "run", "--detach", "--name", `hitch-image-canary-${role}-${nonce}`];
    for (const [name, value] of Object.entries(labels)) args.push("--label", `${name}=${value}`);
    args.push(tags[role]);
    const id = run(args).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker returned an invalid ${role} container id`);
    containers.push(id);
  }

  const observer = startDockerResourceObserver({
    ownership,
    workerId: "canary-worker",
    collisionDomainId: "canary-docker-engine",
    reservation: { cpu_millis: 1_000, memory_bytes: 128 * 1024 * 1024, container_slots: 3, build_slots: 0 },
    mainLimits: { cpu_millis: 500, memory_bytes: 64 * 1024 * 1024, container_slots: 1, build_slots: 0 },
    sidecarLimits: { sidecar: { cpu_millis: 250, memory_bytes: 32 * 1024 * 1024 }, verifier: { cpu_millis: 250, memory_bytes: 32 * 1024 * 1024 } },
    intervalMs: 60_000,
  });
  const execution = await observer.capture();
  await observer.stop();
  if (execution.observed.containers.length !== roles.length) throw new Error("observer did not capture all canary containers");

  const actual = new Map<string, Sha256>();
  const cpuTimes = new Map<string, number>();
  const peakMemory = new Map<string, number>();
  for (const container of execution.observed.containers) {
    const role = roles.find((entry) => container.name?.includes(`-${entry}-${nonce}`));
    if (!role || !container.image_config_digest) throw new Error("observer returned incomplete role image evidence");
    if (!Number.isSafeInteger(container.cpu_time_ns) || (container.cpu_time_ns as number) <= 0) throw new Error(`observer did not record cumulative ${role} CPU time`);
    if (!Number.isSafeInteger(container.peak_memory_bytes) || (container.peak_memory_bytes as number) <= 0) throw new Error(`observer did not record peak ${role} memory`);
    actual.set(role, container.image_config_digest);
    cpuTimes.set(role, container.cpu_time_ns as number);
    peakMemory.set(role, container.peak_memory_bytes as number);
  }
  for (const role of roles) if (actual.get(role) !== expected.get(role)) throw new Error(`observer recorded the wrong ${role} config digest`);

  const evidence = trialEvidence(expected);
  verifyTrialEnvironmentImageExecution(execution, evidence);
  const forged = structuredClone(evidence);
  const verifier = forged.manifests.find((entry) => entry.output.reference.includes("verifier"));
  if (!verifier) throw new Error("canary verifier manifest is missing");
  verifier.output.config_digest = sha256("forged-verifier-config");
  let rejected = false;
  try { verifyTrialEnvironmentImageExecution(execution, forged); }
  catch (error) { rejected = (error as { code?: string }).code === "environment_image_mismatch"; }
  if (!rejected) throw new Error("forged verifier image digest was not rejected");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    docker: run(["version", "--format", "{{.Server.Version}}"]).stdout.trim(),
    compose: run(["compose", "version", "--short"]).stdout.trim(),
    platform,
    observed_config_digests: Object.fromEntries(roles.map((role) => [role, expected.get(role)])),
    observed_cpu_time_ns: Object.fromEntries(roles.map((role) => [role, cpuTimes.get(role)])),
    observed_peak_memory_bytes: Object.fromEntries(roles.map((role) => [role, peakMemory.get(role)])),
    forged_verifier_digest_rejected: true,
  }, null, 2)}\n`);
} finally {
  for (const id of containers) spawnSync(docker, ["container", "rm", "--force", id], { encoding: "utf8" });
  if (exportContainer) spawnSync(docker, ["container", "rm", "--force", exportContainer], { encoding: "utf8" });
  for (const role of roles) spawnSync(docker, ["image", "rm", tags[role]], { encoding: "utf8" });
  await rm(temporary, { recursive: true, force: true });
}

function trialEvidence(configs: ReadonlyMap<string, Sha256>): { uses: EnvironmentImageUseV1[]; manifests: EnvironmentImageManifestV1[] } {
  const createdAt = new Date().toISOString();
  const manifests = roles.map((role): EnvironmentImageManifestV1 => {
    const manifestDigest = sha256(`manifest:${role}`);
    return {
      schema_version: "1",
      image_id: sha256(`image:${role}`),
      source: { kind: "registry", benchmark_id: "canary", benchmark_revision: "1", task_id: ownership.task_id },
      platform,
      build: { builder: "buildkit", frontend: "registry-resolution", secret_names: [], cache_key: sha256(`cache:${role}`) },
      output: { reference: `canary/${role}@${manifestDigest}`, manifest_digest: manifestDigest, config_digest: configs.get(role) as Sha256 },
      base_images: [],
      created_at: createdAt,
    };
  });
  return {
    manifests,
    uses: manifests.map((manifest, index): EnvironmentImageUseV1 => ({
      task_ids: [ownership.task_id],
      image_id: manifest.image_id,
      requested_reference: `canary/${roles[index]}:mutable`,
      reference: manifest.output.reference,
      manifest_digest: manifest.output.manifest_digest,
      platform,
      resolution: "registry",
      cache_hit: false,
    })),
  };
}

function sha256(value: string): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function run(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(docker, args, { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Docker command failed (${args.slice(0, 2).join(" ")}): ${`${result.stderr || ""}\n${result.stdout || ""}`.slice(0, 64 * 1024)}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}
