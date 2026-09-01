import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sha256 } from "../src/domain/index.js";
import { BuildSlotAdmission, ResourceLedger } from "../src/control-plane/index.js";
import { DockerBuildKitBuilder, DockerRegistryResolver, EnvironmentImageService, inspectEnvironmentBuild, inspectPinnedDockerfileBases, parseEnvironmentImageManifest, resolveBuildContext, resolveRegistryEnvironmentImage } from "../src/images/index.js";
import type { EnvironmentImageBuilder } from "../src/images/index.js";
import { delay, sha256JSON, statePaths } from "../src/foundation/index.js";

test("ten concurrent requests for one environment image invoke BuildKit once", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = path.join(root, "context");
  await mkdir(context);
  await writeFile(path.join(context, "Dockerfile"), "FROM example/base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nCOPY payload /payload\n");
  await writeFile(path.join(context, "payload"), "one\n");
  const built = new Map<string, Sha256>();
  let invocations = 0;
  let activeSlots = 0;
  let peakSlots = 0;
  const builder: EnvironmentImageBuilder = {
    id: "buildkit_test",
    probe: async (reference, digest) => built.get(reference) === digest,
    build: async (input) => {
      invocations += 1;
      await delay(25);
      const digest = sha256JSON({ cache_key: input.cacheKey, output: "manifest" });
      built.set(input.outputReference, digest);
      return { reference: input.outputReference, manifest_digest: digest, config_digest: sha256JSON({ cache_key: input.cacheKey, output: "config" }), platform: input.platform, buildkit_version: "0.24.0" };
    },
  };
  const acquireBuildSlot = async () => {
      activeSlots += 1;
      peakSlots = Math.max(peakSlots, activeSlots);
      return { release: () => { activeSlots -= 1; } };
    };
  const request = {
    benchmarkId: "bench",
    benchmarkRevision: "1.0",
    taskId: "task-a",
    contextDirectory: context,
    platform: "linux/amd64",
    buildArgs: { MODE: "top-build-arg-value" },
    secretNames: ["REGISTRY_TOKEN"],
    baseImages: [{ reference: "example/base", digest: `sha256:${"a".repeat(64)}` as Sha256 }],
  };
  const services = Array.from({ length: 10 }, () => new EnvironmentImageService({ root, builder, acquireBuildSlot }));
  const results = await Promise.all(services.map((service) => service.build(request)));
  assert.equal(invocations, 1);
  assert.equal(peakSlots, 1);
  assert.equal(activeSlots, 0);
  assert.equal(new Set(results.map((entry) => entry.manifest.image_id)).size, 1);
  assert.equal(results.filter((entry) => entry.cacheHit === false).length, 1);
  assert.equal(results.filter((entry) => entry.cacheHit === true).length, 9);
  const manifest = results[0]!.manifest;
  assert.deepEqual(manifest.build.secret_names, ["REGISTRY_TOKEN"]);
  assert.equal(JSON.stringify(manifest).includes("top-build-arg-value"), false, "build arg values must not be stored in the manifest");
  const persisted = parseEnvironmentImageManifest(JSON.parse(await readFile(path.join(
    statePaths(root).environmentImages,
    manifest.image_id.slice("sha256:".length),
    "manifest.json",
  ), "utf8")));
  assert.equal(persisted.image_id, manifest.image_id);
  const inspected = await inspectEnvironmentBuild(root, `build_${manifest.build.cache_key.slice("sha256:".length, "sha256:".length + 32)}`);
  assert.equal(inspected?.record.state, "succeeded");
  assert.equal(inspected?.manifest?.image_id, manifest.image_id);

  const restarted = new EnvironmentImageService({ root, builder });
  const cached = await restarted.build(request);
  assert.equal(cached.cacheHit, true);
  assert.equal(invocations, 1);

  await writeFile(path.join(context, "payload"), "two\n");
  const changed = await restarted.build(request);
  assert.equal(changed.cacheHit, false);
  assert.equal(invocations, 2);
  assert.notEqual(changed.manifest.image_id, manifest.image_id);
});

test("environment image context rejects symlinks and manifest identity drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-image-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Dockerfile"), "FROM scratch\n");
  await symlink(path.join(root, "Dockerfile"), path.join(root, "linked"));
  await assert.rejects(resolveBuildContext(root), /unsupported file/);
  const now = new Date().toISOString();
  assert.throws(() => parseEnvironmentImageManifest({
    schema_version: "1",
    image_id: `sha256:${"f".repeat(64)}`,
    source: {
      kind: "build-context",
      benchmark_id: "bench",
      benchmark_revision: "1",
      context_digest: `sha256:${"a".repeat(64)}`,
      dockerfile_digest: `sha256:${"b".repeat(64)}`,
    },
    platform: "linux/amd64",
    build: { builder: "buildkit", secret_names: ["Z", "A"], cache_key: `sha256:${"c".repeat(64)}` },
    output: { reference: "image:test", manifest_digest: `sha256:${"d".repeat(64)}` },
    base_images: [],
    created_at: now,
  }), /secret names/);
});

test("Dockerfile prebuild accepts only immutable external image inputs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-dockerfile-bases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = `registry.test/base@sha256:${"1".repeat(64)}`;
  const tool = `registry.test/tool@sha256:${"2".repeat(64)}`;
  await writeFile(path.join(root, "Dockerfile"), `FROM ${base} AS build\nCOPY --from=${tool} /tool /tool\nFROM build AS final\n`);
  assert.deepEqual(await inspectPinnedDockerfileBases(root), [
    { reference: "registry.test/base", digest: `sha256:${"1".repeat(64)}` },
    { reference: "registry.test/tool", digest: `sha256:${"2".repeat(64)}` },
  ]);
  await writeFile(path.join(root, "Dockerfile"), "FROM ubuntu:latest\n");
  await assert.rejects(inspectPinnedDockerfileBases(root), (error: unknown) => (error as { code?: string }).code === "environment_build_context_unsupported");
  await writeFile(path.join(root, "Dockerfile"), `ARG BASE=${base}\nFROM $BASE\n`);
  await assert.rejects(inspectPinnedDockerfileBases(root), /ARG before FROM/);
});

test("Docker BuildKit resolves secret handles without putting values in argv, state, or cache identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-buildkit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = path.join(root, "context");
  await mkdir(context);
  await writeFile(path.join(context, "Dockerfile"), "FROM scratch\n");
  const argvLog = path.join(root, "docker-argv.jsonl");
  const observationLog = path.join(root, "docker-observation.jsonl");
  const docker = path.join(root, "fake-docker");
  const manifestDigest = `sha256:${"d".repeat(64)}`;
  const configDigest = `sha256:${"e".repeat(64)}`;
  await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "buildx" && args[1] === "build") {
  if (args.includes("hitch-environment:fail")) {
    process.stderr.write("build failed with " + process.env.REGISTRY_TOKEN + "\\n");
    process.exit(9);
  }
  fs.appendFileSync(${JSON.stringify(observationLog)}, JSON.stringify({
    secret_present: typeof process.env.REGISTRY_TOKEN === "string" && process.env.REGISTRY_TOKEN.length > 0,
    secret_in_argv: args.some((value) => value.includes(process.env.REGISTRY_TOKEN || "__missing__"))
  }) + "\\n");
  const metadata = args[args.indexOf("--metadata-file") + 1];
  fs.writeFileSync(metadata, JSON.stringify({"containerimage.digest":${JSON.stringify(manifestDigest)},"containerimage.config.digest":${JSON.stringify(configDigest)}}));
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify({Id:${JSON.stringify(configDigest)},RepoDigests:["registry/image@${manifestDigest}"],Os:"linux",Architecture:"amd64"}));
  process.exit(0);
}
if (args[0] === "buildx" && args[1] === "version") {
  process.stdout.write("github.com/docker/buildx v0.24.0\\n");
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  const firstSecret = "never-write-this-secret";
  const builder = new DockerBuildKitBuilder({
    root,
    dockerExecutable: docker,
    env: { ...process.env, REGISTRY_TOKEN: firstSecret },
    registryCachePrefix: "registry.example/hitch-cache",
  });
  const request = {
    benchmarkId: "bench", benchmarkRevision: "1.0", taskId: "task-a",
    contextDirectory: context,
    platform: "linux/amd64",
    buildArgs: { MODE: "release" },
    secretNames: ["REGISTRY_TOKEN"],
  };
  const first = await new EnvironmentImageService({ root, builder }).build(request);
  assert.equal(first.cacheHit, false);
  assert.equal(first.manifest.output.manifest_digest, manifestDigest);
  assert.equal(first.manifest.output.config_digest, configDigest);
  assert.deepEqual(first.manifest.build.secret_names, ["REGISTRY_TOKEN"]);
  const secondSecret = "rotated-secret-must-not-change-cache";
  const restarted = new EnvironmentImageService({ root, builder: new DockerBuildKitBuilder({
    root, dockerExecutable: docker, env: { ...process.env, REGISTRY_TOKEN: secondSecret }, registryCachePrefix: "registry.example/hitch-cache",
  }) });
  const cached = await restarted.build(request);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.manifest.image_id, first.manifest.image_id);
  const argv = await readFile(argvLog, "utf8");
  assert.match(argv, /REGISTRY_TOKEN/);
  assert.match(argv, /registry\.example\/hitch-cache/);
  assert.match(argv, /io\.hitch\.environment-image-root-id/);
  assert.match(argv, /io\.hitch\.environment-image-cache-key/);
  assert.equal(argv.includes(firstSecret), false);
  assert.equal(argv.includes(secondSecret), false);
  const observations = (await readFile(observationLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(observations, [{ secret_present: true, secret_in_argv: false }], "cache hit must not start a second build");
  const argvBeforeMissing = await readFile(argvLog, "utf8");
  const missingEnv: NodeJS.ProcessEnv = { ...process.env };
  delete missingEnv.REGISTRY_TOKEN;
  const missing = new DockerBuildKitBuilder({ root, dockerExecutable: docker, env: missingEnv, registryCachePrefix: "registry.example/hitch-cache" });
  await assert.rejects(missing.build({
    contextDirectory: context, dockerfile: "Dockerfile", platform: "linux/amd64", buildArgs: {}, secretNames: ["REGISTRY_TOKEN"],
    outputReference: "hitch-environment:missing", cacheKey: `sha256:${"c".repeat(64)}`, cacheReference: "ignored",
  }), (error: unknown) => (error as { code?: string }).code === "credential_unavailable");
  assert.equal(await readFile(argvLog, "utf8"), argvBeforeMissing, "missing secret must fail before Docker starts");
  await assert.rejects(builder.build({
    contextDirectory: context, dockerfile: "Dockerfile", platform: "linux/amd64", buildArgs: {}, secretNames: ["REGISTRY_TOKEN"],
    outputReference: "hitch-environment:fail", cacheKey: `sha256:${"f".repeat(64)}`, cacheReference: "ignored",
  }), (error: unknown) => {
    assert.equal((error as Error).message.includes(firstSecret), false, "BuildKit errors must redact injected values");
    assert.match((error as Error).message, /\[REDACTED\]/);
    return true;
  });
  for (const file of await regularFiles(root)) {
    const persisted = await readFile(file);
    assert.equal(persisted.includes(Buffer.from(firstSecret)), false, `BuildKit secret leaked into ${path.relative(root, file)}`);
    assert.equal(persisted.includes(Buffer.from(secondSecret)), false, `rotated BuildKit secret leaked into ${path.relative(root, file)}`);
  }
});

test("image builds use a FIFO build lane independent from container slots", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-build-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new ResourceLedger({ cpu_millis: 2_000, memory_bytes: 2_048, container_slots: 1, build_slots: 1 });
  const runningTrial = ledger.tryAcquire("eval-a", "eval", { cpu_millis: 1_000, memory_bytes: 1_024, container_slots: 1, build_slots: 0 });
  assert.ok(runningTrial);
  const admission = new BuildSlotAdmission(ledger);
  t.after(() => admission.close());
  const first = await admission.acquire();
  assert.equal(ledger.snapshot().allocated.container_slots, 1);
  assert.equal(ledger.snapshot().allocated.build_slots, 1);
  let secondAdmitted = false;
  const secondPromise = admission.acquire().then((lease) => { secondAdmitted = true; return lease; });
  await delay(10);
  assert.equal(secondAdmitted, false);
  first.release();
  const second = await secondPromise;
  second.release();
  runningTrial.release();
  assert.deepEqual(ledger.snapshot().allocated, { cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 0 });
});

test("registry tags resolve to immutable platform-verified digests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-registry-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docker = path.join(root, "fake-docker-registry");
  const argvLog = path.join(root, "registry-argv.jsonl");
  const manifestDigest = `sha256:${"7".repeat(64)}`;
  const configDigest = `sha256:${"8".repeat(64)}`;
  await writeFile(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "pull") process.exit(0);
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify({Id:${JSON.stringify(configDigest)},RepoDigests:["registry.example/team/image@${manifestDigest}"],Os:"linux",Architecture:"amd64"}));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  const resolver = new DockerRegistryResolver({ dockerExecutable: docker, id: "registry-test" });
  const request = {
    root,
    benchmarkId: "bench",
    benchmarkRevision: "2",
    taskId: "task-registry",
    reference: "registry.example/team/image:latest",
    platform: "linux/amd64",
    resolver,
  };
  const first = await resolveRegistryEnvironmentImage(request);
  assert.equal(first.cacheHit, false);
  assert.equal(first.manifest.output.reference, `registry.example/team/image@${manifestDigest}`);
  assert.equal(first.manifest.output.manifest_digest, manifestDigest);
  assert.equal(first.manifest.output.config_digest, configDigest);
  const second = await resolveRegistryEnvironmentImage(request);
  assert.equal(second.cacheHit, true);
  assert.equal(second.manifest.image_id, first.manifest.image_id);
  const argv = await readFile(argvLog, "utf8");
  assert.match(argv, /"pull","--platform","linux\/amd64","registry\.example\/team\/image:latest"/);
  await assert.rejects(resolveRegistryEnvironmentImage({
    ...request,
    reference: `registry.example/team/image@sha256:${"9".repeat(64)}`,
  }), (error: unknown) => (error as { code?: string }).code === "image_digest_mismatch");
  await assert.rejects(resolveRegistryEnvironmentImage({
    ...request,
    resolver: { id: "forged", resolve: async () => ({ reference: "registry.example/other:latest", manifest_digest: manifestDigest as Sha256, platform: "linux/amd64" }) },
  }), (error: unknown) => (error as { code?: string }).code === "image_output_mismatch");
});

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
