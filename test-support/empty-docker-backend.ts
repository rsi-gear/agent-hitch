import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hitchRootId } from "../src/foundation/index.js";

/** Fake Harbor runs on the host and creates no Docker resources. Supply only
 * the backend identity and empty inventory needed by production cleanup fences;
 * unsupported commands fail so this cannot stand in for a real Docker test. */
export async function installEmptyDockerBackendForTest(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.HITCH_DOCKER_PATH) return;
  const directory = path.join(root, "test-support");
  await mkdir(directory, { recursive: true });
  const executable = path.join(directory, "empty-docker");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "context" && args[1] === "show") process.stdout.write("hitch-test-empty\\n");
else if (args[0] === "info" && args[1] === "--format" && args[2] === "{{.ID}}") process.stdout.write(${JSON.stringify(`test-empty-${hitchRootId(root)}\n`)});
else if (!["container", "network", "volume"].includes(args[0]) || args[1] !== "ls") {
  process.stderr.write("unsupported empty test Docker command\\n"); process.exitCode = 2;
}
`, { mode: 0o755 });
  env.HITCH_DOCKER_PATH = executable;
}
