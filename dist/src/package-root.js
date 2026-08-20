/**
 * Resolve the Hitch package root and version from the module location,
 * tolerating both the source layout (`src/cli.ts`) and the compiled layout
 * (`dist/src/cli.js`). Walks up until a `package.json` with a `name` is found.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
let cachedRoot;
let cachedVersion;
export function packageRoot() {
    if (cachedRoot)
        return cachedRoot;
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(directory, "package.json");
        try {
            const metadata = JSON.parse(readFileSync(candidate, "utf8"));
            if (metadata.name === "agent-hitch") {
                cachedRoot = directory;
                return directory;
            }
        }
        catch {
            // Keep walking up.
        }
        const parent = dirname(directory);
        if (parent === directory)
            throw new Error("could not locate the Hitch package root");
        directory = parent;
    }
}
export function packageVersion() {
    if (cachedVersion)
        return cachedVersion;
    const metadata = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
    cachedVersion = metadata.version;
    return cachedVersion;
}
//# sourceMappingURL=package-root.js.map