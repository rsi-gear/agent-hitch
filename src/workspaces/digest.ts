import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { HitchError } from "../foundation/index.js";
import { throwIfAborted } from "./utils.js";

export async function workspaceDigest(directory: string, { signal, excludedTopLevel = new Set<string>() }: { signal?: AbortSignal | undefined; excludedTopLevel?: Set<string> } = {}): Promise<string> {
  const hash = createHash("sha256");
  await digestDirectory(hash, directory, "", { signal, excludedTopLevel, topLevel: true });
  return `sha256:${hash.digest("hex")}`;
}

async function digestDirectory(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relative: string,
  { signal, excludedTopLevel, topLevel }: { signal?: AbortSignal | undefined; excludedTopLevel: Set<string>; topLevel: boolean },
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(directory);
  entries.sort();
  for (const name of entries) {
    if (topLevel && excludedTopLevel.has(name)) continue;
    throwIfAborted(signal);
    const absolute = path.join(directory, name);
    const childRelative = relative ? path.join(relative, name) : name;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${childRelative}\0${info.mode & 0o7777}\0`);
      await digestDirectory(hash, absolute, childRelative, { signal, excludedTopLevel, topLevel: false });
    } else if (info.isFile()) {
      hash.update(`f\0${childRelative}\0${info.mode & 0o7777}\0${info.size}\0`);
      const stream = createReadStream(absolute);
      for await (const chunk of stream) {
        throwIfAborted(signal);
        hash.update(chunk as Buffer);
      }
      hash.update("\0");
    } else if (info.isSymbolicLink()) {
      hash.update(`l\0${childRelative}\0${await readlink(absolute)}\0`);
    } else {
      throw new HitchError(`unsupported special file in workspace: ${absolute}`, {
        code: "workspace_special_file",
        exitCode: 5,
      });
    }
  }
}
