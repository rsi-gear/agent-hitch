import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { harborEnvironmentConfig, harborPreparationOptions } from "../src/backends/harbor/environment-config.js";

test("generic image preparation identity, concurrent reuse, failures and keepalive semantics", () => {
  const result = spawnSync("python3", ["test-support/image_preparation_test.py"], { encoding: "utf8", timeout: 30_000 });
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
