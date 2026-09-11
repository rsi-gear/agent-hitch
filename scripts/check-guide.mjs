import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { checkCliReference } from "./lib/check-cli-reference.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const directory = path.join(root, "docs/guide");
const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, packageJson.version, "Review the guide when changing the package version");
assert.equal(new Set(manifest.pages.map((page) => page.slug)).size, manifest.pages.length);
const documents = new Map();
for (const language of manifest.languages) for (const page of manifest.pages) {
  const file = path.join(directory, language.id, page.file);
  const markdown = await readFile(file, "utf8");
  assert.ok(markdown.startsWith(`# ${page.translations[language.id].title}\n`), `Title mismatch: ${file}`);
  documents.set(file, markdown);
}
for (const [file, markdown] of documents) {
  const withoutCode = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  for (const match of withoutCode.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^https:\/\//.test(href)) continue;
    const [target] = href.split("#");
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    assert.ok(resolved.startsWith(`${root}${path.sep}`), `Link escapes repository: ${href}`);
    await access(resolved).catch(() => { throw new Error(`Broken link in ${path.relative(root, file)}: ${href}`); });
  }
}
const example = path.join(directory, "examples/hello-hitch");
const config = parse(await readFile(path.join(example, "task.toml"), "utf8"));
assert.equal(config.schema_version, "1.4");
assert.equal(config.environment.workdir, "/app");
await Promise.all(["instruction.md", "environment/Dockerfile", "tests/test.sh"].map((file) => access(path.join(example, file))));
const references = manifest.languages.map((language) => {
  const file = path.join(directory, language.id, "cli-reference.md");
  assert.ok(documents.has(file), `Missing CLI reference: ${file}`);
  return [file, documents.get(file)];
});
const coverage = await checkCliReference(root, references);
console.log(`Checked ${documents.size} guide pages, repository links, package version, and the Harbor example.`);
console.log(`CLI reference covers ${coverage.commands} command paths/aliases and ${coverage.options} public option names in each language.`);
