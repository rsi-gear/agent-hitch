import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { harborEnvironmentConfig, harborPreparationOptions } from "../src/backends/harbor/environment-config.js";

test("generic image preparation identity, concurrent reuse and failures", () => {
  const result = spawnSync("python3", ["test-support/image_preparation_test.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Compose preparation preserves shared image names and task lifecycle declarations", () => {
  const result = spawnSync("python3", ["test-support/compose_preparation_test.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Docker command supervision preserves lifetime and build locks across cancellation and parent death", () => {
  const result = spawnSync("python3", ["test-support/build_process_test.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Harbor preparation is opt-in and validates host configuration", () => {
  assert.deepEqual(harborPreparationOptions({}), {});
  assert.deepEqual(harborEnvironmentConfig(), { type: "docker", delete: true });
  const options = harborPreparationOptions({ HITCH_HARBOR_IMAGE_CACHE_DIR: "/cache/images", HITCH_HARBOR_IMAGE_BUILD_SLOTS: "3", HITCH_HARBOR_MANAGED_KEEPALIVE: "1" });
  const config = harborEnvironmentConfig(undefined, undefined, undefined, undefined, undefined, false, false, undefined, options);
  assert.deepEqual(config.kwargs, { hitch_image_cache_dir: "/cache/images", hitch_image_build_slots: 3, hitch_managed_keepalive: true });
  for (const env of [{ HITCH_HARBOR_IMAGE_CACHE_DIR: "relative" }, { HITCH_HARBOR_IMAGE_BUILD_SLOTS: "0" }, { HITCH_HARBOR_IMAGE_BUILD_SLOTS: "65" }, { HITCH_HARBOR_MANAGED_KEEPALIVE: "yes" }]) {
    assert.throws(() => harborEnvironmentConfig(undefined, undefined, undefined, undefined, undefined, false, false, undefined, harborPreparationOptions(env)));
  }
});

test("Harbor config keeps verifier image kwargs independent and preserves the legacy absent contract", () => {
  const candidate = { "candidate:v1": `candidate@sha256:${"a".repeat(64)}` };
  const verifier = { "grader:v1": `grader@sha256:${"b".repeat(64)}` };
  const legacy = harborEnvironmentConfig(undefined, undefined, undefined, candidate);
  assert.deepEqual(legacy.kwargs, { hitch_resolved_images: candidate });
  const config = harborEnvironmentConfig(undefined, undefined, undefined, candidate, undefined, false, false, undefined, {}, {},
    { prebuiltImage: `sha256:${"c".repeat(64)}`, resolvedImages: verifier });
  assert.deepEqual(config.kwargs, { hitch_resolved_images: candidate, hitch_prebuilt_verifier_image: `sha256:${"c".repeat(64)}`, hitch_verifier_resolved_images: verifier });
  const isolated = harborEnvironmentConfig(undefined, undefined, undefined, candidate, undefined, false, false, undefined, {}, {}, { resolvedImages: {} });
  assert.deepEqual(isolated.kwargs, { hitch_resolved_images: candidate, hitch_verifier_resolved_images: {} });
  for (const binding of [{ prebuiltImage: "mutable:tag", resolvedImages: {} }, { resolvedImages: { "grader:v1": "mutable:tag" } }]) {
    assert.throws(() => harborEnvironmentConfig(undefined, undefined, undefined, candidate, undefined, false, false, undefined, {}, {}, binding), { code: "invalid_input" });
  }
});
