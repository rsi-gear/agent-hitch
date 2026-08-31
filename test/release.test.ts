import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot, packageVersion } from "../src/foundation/index.js";

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

test("package exports contain only module facades", () => {
  const metadata = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { exports: Record<string, string> };
  assert.deepEqual(Object.keys(metadata.exports), [
    "./adapters",
    "./artifacts",
    "./backends",
    "./controller-runtime",
    "./control-plane",
    "./daemon",
    "./domain",
    "./evals",
    "./feedback",
    "./images",
    "./model-access",
    "./foundation",
    "./revisions",
    "./runs",
    "./trajectories",
    "./workspaces",
    "./cli",
    "./package.json",
  ]);
});
