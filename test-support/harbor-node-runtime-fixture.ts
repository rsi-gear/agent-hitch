import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactDirectoryIntegrity } from "../src/artifacts/index.js";
import type { ArtifactManifest } from "../src/artifacts/index.js";
import { atomicWriteJSON, digest, fingerprintExecutable } from "../src/foundation/index.js";

export async function nodeRuntimeHarnessFixture(root: string): Promise<{ directory: string; manifest: ArtifactManifest }> {
  const artifactId = digest("offline-node-harness-fixture");
  const directory = path.join(root, "staging", artifactId.slice("sha256:".length));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "entry.js"), "console.log('offline harness OK')\n");
  const revisionIdentity = digest("fixture revision");
  const manifest: ArtifactManifest = {
    schema_version: "1", artifact_id: artifactId, harness_id: "pi", revision_identity: revisionIdentity,
    source_type: "npm", adapter: "pi", adapter_version: "1", recipe_version: "1", platform: "linux-x64",
    entrypoint: "entry.js", launcher: "node", toolchain: { node: "v22.23.0" },
    entrypoint_integrity: await fingerprintExecutable(path.join(directory, "entry.js")),
    artifact_integrity: await artifactDirectoryIntegrity(directory), prepared_at: "2026-09-03T00:00:00.000Z",
    resolved_revision: {
      schema_version: "1", harness_id: "pi", requested_ref: "pi@version:1.2.3", canonical_ref: "pi@version:1.2.3",
      selector: { type: "version", value: "1.2.3" }, source: { type: "npm", package: "fixture" },
      revision: { type: "version", version: "1.2.3" }, identity: revisionIdentity, resolved_at: "2026-09-03T00:00:00.000Z",
    },
  };
  await atomicWriteJSON(path.join(directory, "artifact.json"), manifest);
  return { directory, manifest };
}
