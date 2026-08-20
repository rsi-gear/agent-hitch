import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../src/package-root.js";

const executable = fileURLToPath(new URL("../scripts/check-release.js", import.meta.url));
const version = packageVersion();

test("release validation accepts matching metadata", () => {
  const isPrerelease = String(version.includes("-"));
  const result = spawnSync(process.execPath, [executable, `v${version}`, isPrerelease], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || undefined);
  assert.match(result.stdout, new RegExp(`matches package version ${version.replaceAll(".", "\\.")}`));
});

test("release validation rejects a tag that differs from the package version", () => {
  const isPrerelease = String(version.includes("-"));
  const result = spawnSync(process.execPath, [executable, "v999.0.0", isPrerelease], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version/);
});
