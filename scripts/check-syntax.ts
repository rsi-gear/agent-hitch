import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Validates the compiled dist output (bin/src/scripts), the JSON schemas, and
// that every compiled module resolves. Run after `npm run build`.
const roots = ["dist/bin", "dist/src", "dist/scripts"];
const files: string[] = [];
for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(root, entry.name));
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

// Verify the compiled CLI entrypoint loads and reports a version.
const version = spawnSync(process.execPath, ["dist/bin/hitch.js", "--version"], {
  encoding: "utf8",
});
if (version.status !== 0) {
  process.stderr.write(`compiled hitch CLI failed to start: ${version.stderr || version.stdout}\n`);
  process.exit(version.status || 1);
}

for (const entry of await readdir("docs/schemas", { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".json")) {
    JSON.parse(await readFile(path.join("docs/schemas", entry.name), "utf8"));
  }
}
