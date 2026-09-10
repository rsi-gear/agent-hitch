import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { packageRoot, runCommand } from "../foundation/index.js";
import { hashRuntimePayload } from "./hash.js";
import type { ControllerRuntimeObservationV2 } from "../domain/index.js";

export type { ControllerRuntimeObservationV2 } from "../domain/index.js";

/** Observe this package on disk, not the caller's cwd. This does not attest cached JS modules. */
export async function observeControllerRuntime(payloadRoot = packageRoot()): Promise<ControllerRuntimeObservationV2> {
  const root = await realpath(payloadRoot);
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || !metadata.version) throw new TypeError("Hitch package version is unavailable");
  const runtime = await hashRuntimePayload({ payloadRoot: root });
  let source: ControllerRuntimeObservationV2["source"] = { kind: "unavailable", commit: null, dirty: null };
  try {
    const git = async (args: string[]) => (await runCommand("git", args, { cwd: root, timeoutMs: 10_000 })).stdout.trim();
    const checkout = await realpath(await git(["rev-parse", "--show-toplevel"]));
    if (checkout === root) {
      const commit = await git(["rev-parse", "HEAD"]);
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new TypeError("Hitch checkout commit is invalid");
      const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--", "package.json", "src", "bin", "dist/bin", "dist/src", "integrations"]);
      if (await git(["rev-parse", "HEAD"]) !== commit) throw new TypeError("Hitch checkout changed during observation");
      source = { kind: "git-checkout", commit, dirty: status.length > 0 };
    }
  } catch { /* A source-less package must not borrow a parent repository's identity. */ }
  return { schema_version: "2", package_version: metadata.version, node_version: process.version, runtime_id: runtime.runtimeId, source };
}
