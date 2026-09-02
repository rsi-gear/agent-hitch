import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPreparedArtifact, prepareHarness, preparedArtifactDirectory, resolveHarness } from "../src/artifacts/index.js";

const root = await mkdtemp(path.join(tmpdir(), "hitch-packaged-harness-canary-"));
try {
  const fakeNpm = await writePortableFakeNpm(root);
  const env = { ...process.env, HITCH_NPM_PATH: fakeNpm };
  const resolved = await resolveHarness("codex@version:1.2.3", { root, env });
  const prepared = await prepareHarness(resolved, { root, env });
  const cached = await prepareHarness(resolved, { root, env });
  const loaded = await loadPreparedArtifact(preparedArtifactDirectory(root, prepared.artifact_id), {
    artifact_id: prepared.artifact_id,
    artifact_integrity: prepared.artifact_integrity as string,
    entrypoint_integrity: prepared.entrypoint_integrity as string,
    harness_id: prepared.harness_id,
    revision_identity: prepared.revision_identity,
    platform: prepared.platform,
  });
  const entrypoint = loaded.entrypoint_args[0] ?? loaded.executable;
  const source = await readFile(entrypoint, "utf8");
  if (prepared.cache_hit || !cached.cache_hit || loaded.artifact_id !== prepared.artifact_id
    || prepared.platform !== `${process.platform}-${process.arch}` || !source.includes("canary-ready")) {
    throw new Error("packaged harness preparation evidence is inconsistent");
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: "1",
    status: "passed",
    platform: prepared.platform,
    node: process.version,
    harness_id: prepared.harness_id,
    revision_identity: prepared.revision_identity,
    artifact_id: prepared.artifact_id,
    artifact_integrity: prepared.artifact_integrity,
    entrypoint_integrity: prepared.entrypoint_integrity,
    first_cache_hit: prepared.cache_hit,
    second_cache_hit: cached.cache_hit,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function writePortableFakeNpm(directory: string): Promise<string> {
  const implementation = path.join(directory, "fake-npm.cjs");
  await writeFile(implementation, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("10.9.0\\n"); process.exit(0); }
if (args[0] === "view") {
  process.stdout.write(JSON.stringify({version:"1.2.3",dist:{integrity:"sha512-canary-integrity",tarball:"https://registry.invalid/codex-1.2.3.tgz"}}));
  process.exit(0);
}
if (args[0] === "install") {
  const packageRoot = path.join(process.cwd(), "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(packageRoot, "dist"), {recursive:true});
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({name:"@openai/codex",version:"1.2.3",bin:{codex:"dist/cli.js"}}));
  fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\\nif (process.argv.includes('--version')) process.stdout.write('codex 1.2.3\\\\n');\\nelse process.stdout.write('canary-ready\\\\n');\\n", {mode:0o755});
  fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({lockfileVersion:3,packages:{"node_modules/@openai/codex":{version:"1.2.3",integrity:"sha512-canary-integrity"}}}));
  process.exit(0);
}
process.stderr.write("unsupported fake npm invocation: " + args.join(" ") + "\\n");
process.exit(2);
`.trimStart());
  if (process.platform === "win32") {
    const wrapper = path.join(directory, "fake-npm.cmd");
    await writeFile(wrapper, `@echo off\r\nnode "%~dp0fake-npm.cjs" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(directory, "fake-npm");
  await writeFile(wrapper, `#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}
