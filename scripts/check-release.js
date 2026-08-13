#!/usr/bin/env node

import { readFileSync } from "node:fs";

const [tag, prereleaseValue] = process.argv.slice(2);
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${metadata.version}`;

if (tag !== expectedTag) {
  process.stderr.write(`release tag ${tag || "<missing>"} does not match package version ${metadata.version}; expected ${expectedTag}\n`);
  process.exitCode = 1;
} else if (!new Set(["true", "false"]).has(prereleaseValue)) {
  process.stderr.write("release prerelease state must be true or false\n");
  process.exitCode = 1;
} else {
  const packageIsPrerelease = metadata.version.includes("-");
  const releaseIsPrerelease = prereleaseValue === "true";
  if (packageIsPrerelease !== releaseIsPrerelease) {
    process.stderr.write(`package version ${metadata.version} and GitHub prerelease state do not match\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`release ${tag} matches package version ${metadata.version}\n`);
  }
}
