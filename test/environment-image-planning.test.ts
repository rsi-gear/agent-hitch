import test from "node:test";
import assert from "node:assert/strict";
import { planEnvironmentImages, resolvedImageMapping } from "../src/evals/environment-image-planning.js";
import type { LocalTaskPlanningInputV1 } from "../src/evals/task-resources.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const imageId = `sha256:${"b".repeat(64)}` as const;

function task(overrides: Partial<LocalTaskPlanningInputV1> = {}): LocalTaskPlanningInputV1 {
  return {
    task_id: "task-a",
    resources: {} as LocalTaskPlanningInputV1["resources"],
    environment_images: [{ source: "task", service: "main", reference: "registry.test/task:latest" }],
    environment_image_fallbacks: [],
    environment_builds: [],
    ...overrides,
  };
}

test("environment image planning pins registry references and exposes an execution mapping", async () => {
  const requests: string[] = [];
  const result = await planEnvironmentImages({
    tasks: [task()],
    mode: "prebuild-preferred",
    benchmarkId: "demo",
    benchmarkRevision: "1",
    resolver: async (input) => {
      requests.push(`${input.taskId}:${input.reference}:${input.platform}`);
      return {
        image_id: imageId,
        reference: `registry.test/task@${digest}`,
        manifest_digest: digest,
        platform: input.platform,
        cache_hit: false,
      };
    },
  });
  assert.deepEqual(requests, ["task-a:registry.test/task:latest:linux/amd64"]);
  assert.deepEqual(result.fallbacks, []);
  assert.equal(result.uses[0]?.requested_reference, "registry.test/task:latest");
  assert.deepEqual(resolvedImageMapping(result.uses), {
    "registry.test/task:latest": `registry.test/task@${digest}`,
  });
});

test("preferred prebuild records fallback while required prebuild rejects it", async () => {
  const unavailable = task({
    environment_images: [],
    environment_image_fallbacks: [{ source: "compose", service: "database", code: "backend-build" }],
    environment_builds: [],
  });
  const preferred = await planEnvironmentImages({
    tasks: [unavailable], mode: "prebuild-preferred", benchmarkId: "demo", benchmarkRevision: "1",
  });
  assert.deepEqual(preferred.fallbacks, [{ task_id: "task-a", source: "compose", service: "database", code: "backend-build" }]);
  await assert.rejects(planEnvironmentImages({
    tasks: [unavailable], mode: "prebuild-required", benchmarkId: "demo", benchmarkRevision: "1",
  }), (error: unknown) => (error as { code?: string }).code === "environment_prebuild_unavailable");
});

test("backend build policy does not invoke the registry resolver", async () => {
  let calls = 0;
  const result = await planEnvironmentImages({
    tasks: [task()], mode: "backend", benchmarkId: "demo", benchmarkRevision: "1",
    resolver: async () => { calls += 1; throw new Error("must not run"); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.uses, []);
  assert.equal(result.fallbacks[0]?.code, "policy-backend");
});

test("main and simulator builds complete during planning and retain service identity and platform", async () => {
  const calls: Array<{ dockerfile: string; platform: string; sourceKind?: string }> = [];
  const result = await planEnvironmentImages({
    tasks: [task({ environment_images: [], environment_builds: [
      { source: "task", service: "main", context: "environment", context_directory: "/task/environment", dockerfile: "Dockerfile" },
      { source: "compose", service: "simulator", context: "environment", context_directory: "/task/environment", dockerfile: "Dockerfile.simulator", platform: "linux/arm64" },
    ] })], mode: "prebuild-required", benchmarkId: "demo", benchmarkRevision: "1",
    builder: async (input) => {
      calls.push(input);
      const requested = `hitch-environment:${input.dockerfile === "Dockerfile" ? "main" : "simulator"}`;
      return { image_id: imageId, requested_reference: requested, reference: `${requested}@${digest}`,
        manifest_digest: digest, platform: input.platform, cache_hit: false };
    },
  });
  assert.deepEqual(calls.map(({ dockerfile, platform, sourceKind }) => ({ dockerfile, platform, sourceKind })), [
    { dockerfile: "Dockerfile", platform: "linux/amd64", sourceKind: undefined },
    { dockerfile: "Dockerfile.simulator", platform: "linux/arm64", sourceKind: "compose-build" },
  ]);
  assert.deepEqual(result.uses.map((entry) => entry.service), [undefined, "simulator"]);
  assert.deepEqual(result.fallbacks, []);
  assert.deepEqual(resolvedImageMapping(result.uses), {});
});

test("task Dockerfile planning records an immutable prebuilt image without registry overlay mapping", async () => {
  const requested = "hitch-environment:0123456789abcdef0123456789abcdef";
  const result = await planEnvironmentImages({
    tasks: [task({
      environment_images: [],
      environment_builds: [{ source: "task", service: "main", context: "environment", dockerfile: "Dockerfile", context_directory: "/dataset/task-a/environment" }],
    })],
    mode: "prebuild-preferred",
    benchmarkId: "demo",
    benchmarkRevision: "1",
    builder: async (input) => ({
      image_id: imageId,
      requested_reference: requested,
      reference: `${requested}@${digest}`,
      manifest_digest: digest,
      platform: input.platform,
      cache_hit: false,
    }),
  });
  assert.deepEqual(result.fallbacks, []);
  assert.equal(result.uses[0]?.resolution, "prebuilt");
  assert.equal(result.uses[0]?.reference, `${requested}@${digest}`);
  assert.deepEqual(resolvedImageMapping(result.uses), {});
});

test("environment planning resolves each task for its declared runtime platform", async () => {
  const requests: string[] = [];
  const result = await planEnvironmentImages({
    tasks: [
      task({ task_id: "x64", runtime_platform: "linux/amd64" }),
      task({ task_id: "arm64", runtime_platform: "linux/arm64" }),
    ],
    mode: "prebuild-preferred",
    benchmarkId: "demo",
    benchmarkRevision: "1",
    resolver: async (input) => {
      requests.push(`${input.taskId}:${input.platform}`);
      const suffix = input.platform === "linux/amd64" ? "c" : "d";
      const manifest = `sha256:${suffix.repeat(64)}` as `sha256:${string}`;
      return {
        image_id: `sha256:${(suffix === "c" ? "e" : "f").repeat(64)}` as `sha256:${string}`,
        reference: `registry.test/task@${manifest}`,
        manifest_digest: manifest,
        platform: input.platform,
        cache_hit: false,
      };
    },
  });
  assert.deepEqual(requests, ["arm64:linux/arm64", "x64:linux/amd64"]);
  assert.deepEqual(result.uses.map((entry) => `${entry.task_ids[0]}:${entry.platform}`), [
    "arm64:linux/arm64",
    "x64:linux/amd64",
  ]);
});

test("candidate and verifier registry bindings retain distinct roles even for the same reference", async () => {
  const result = await planEnvironmentImages({ tasks: [task({ environment_images: [
    { source: "task", service: "main", reference: "registry.test/shared:latest" },
    { source: "verifier", service: "main", reference: "registry.test/shared:latest" },
  ] })], mode: "prebuild-required", benchmarkId: "demo", benchmarkRevision: "1",
  resolver: async (input) => ({ image_id: imageId, reference: `registry.test/shared@${digest}`,
    manifest_digest: digest, platform: input.platform, cache_hit: true }) });
  assert.deepEqual(result.uses.map((use) => use.role), ["candidate", "verifier"]);
  assert.deepEqual(resolvedImageMapping(result.uses, "verifier"), { "registry.test/shared:latest": `registry.test/shared@${digest}` });
  const candidateOnly = result.uses.filter((use) => use.role === "candidate");
  assert.deepEqual(resolvedImageMapping(candidateOnly, "verifier"), {});
  const { role: _role, ...legacy } = result.uses[0]!;
  assert.deepEqual(resolvedImageMapping([legacy], "verifier"), resolvedImageMapping([legacy]));
  assert.equal("role" in legacy, false);
});

test("independent verifier tests builds are prepared separately and keep preferred failure policy", async () => {
  const tasks = [task({ environment_images: [], environment_builds: [
    { source: "task", service: "main", context: "environment", context_directory: "/task/environment", dockerfile: "Dockerfile" },
    { source: "verifier", service: "main", context: "tests", context_directory: "/task/tests", dockerfile: "Dockerfile" },
  ] })];
  const calls: string[] = [];
  const builder = async (input: { contextDirectory: string; platform: string }) => {
    calls.push(input.contextDirectory);
    const requested = `hitch-environment:${input.contextDirectory.endsWith("tests") ? "verifier" : "candidate"}`;
    return { image_id: imageId, requested_reference: requested, reference: `${requested}@${digest}`,
      manifest_digest: digest, platform: input.platform, cache_hit: false };
  };
  const result = await planEnvironmentImages({ tasks, mode: "prebuild-required", benchmarkId: "demo", benchmarkRevision: "1", builder });
  assert.deepEqual(calls, ["/task/environment", "/task/tests"]);
  assert.deepEqual(result.uses.map((use) => use.role), ["candidate", "verifier"]);
  const failing = async (input: Parameters<typeof builder>[0]) => {
    if (input.contextDirectory.endsWith("tests")) throw new Error("verifier build failed");
    return builder(input);
  };
  const preferred = await planEnvironmentImages({ tasks, mode: "prebuild-preferred", benchmarkId: "demo", benchmarkRevision: "1", builder: failing });
  assert.deepEqual(preferred.uses.map((use) => use.role), ["candidate"]);
  assert.deepEqual(preferred.fallbacks, [{ task_id: "task-a", source: "verifier", service: "main", code: "resolution-failed" }]);
  await assert.rejects(planEnvironmentImages({ tasks, mode: "prebuild-required", benchmarkId: "demo", benchmarkRevision: "1", builder: failing }), { code: "environment_prebuild_unavailable" });
});
