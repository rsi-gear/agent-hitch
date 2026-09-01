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
