import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "src", "scripts", "test", "test-support"];
const files = [];
for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(root, entry.name));
  }
}

for (const file of files) {
  if (file === "scripts/check-syntax.js") continue;
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const entry of await readdir("docs/schemas", { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".json")) {
    JSON.parse(await readFile(path.join("docs/schemas", entry.name), "utf8"));
  }
}
