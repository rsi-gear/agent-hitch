#!/usr/bin/env node
import { packageVersion } from "../src/package-root.js";
const [tag, prereleaseValue] = process.argv.slice(2);
const version = packageVersion();
const expectedTag = `v${version}`;
if (tag !== expectedTag) {
    process.stderr.write(`release tag ${tag || "<missing>"} does not match package version ${version}; expected ${expectedTag}\n`);
    process.exitCode = 1;
}
else if (!new Set(["true", "false"]).has(prereleaseValue || "")) {
    process.stderr.write("release prerelease state must be true or false\n");
    process.exitCode = 1;
}
else {
    const packageIsPrerelease = version.includes("-");
    const releaseIsPrerelease = prereleaseValue === "true";
    if (packageIsPrerelease !== releaseIsPrerelease) {
        process.stderr.write(`package version ${version} and GitHub prerelease state do not match\n`);
        process.exitCode = 1;
    }
    else {
        process.stdout.write(`release ${tag} matches package version ${version}\n`);
    }
}
//# sourceMappingURL=check-release.js.map