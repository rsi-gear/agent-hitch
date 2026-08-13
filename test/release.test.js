import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../scripts/check-release.js", import.meta.url));
const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("release validation accepts matching metadata", () => {
  const isPrerelease = String(metadata.version.includes("-"));
  const result = spawnSync(process.execPath, [executable, `v${metadata.version}`, isPrerelease], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`matches package version ${metadata.version.replaceAll(".", "\\.")}`));
});

test("release validation rejects a tag that differs from the package version", () => {
  const isPrerelease = String(metadata.version.includes("-"));
  const result = spawnSync(process.execPath, [executable, "v999.0.0", isPrerelease], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version/);
});
