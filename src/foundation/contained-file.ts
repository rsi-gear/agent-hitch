import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface ContainedRegularFile {
  handle: FileHandle;
  size: number;
  assertUnchanged(): Promise<void>;
}

/** Open an untrusted relative file without following any directory or file symlink. */
export async function openContainedRegularFile(
  root: string,
  relative: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<ContainedRegularFile> {
  const segments = normalizedSegments(relative);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) throw new TypeError("contained file root must be canonical");
  const parents: Array<{ path: string; stats: Stats }> = [];
  let directory = canonicalRoot;
  parents.push({ path: directory, stats: await safeDirectory(directory) });
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    const info = await safeDirectory(directory);
    if (!isWithin(canonicalRoot, await realpath(directory))) throw new TypeError("contained file parent escapes its root");
    parents.push({ path: directory, stats: info });
  }
  const target = path.join(canonicalRoot, ...segments);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new TypeError("contained file is not a safe regular file");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const after = await lstat(target);
    await assertParentsUnchanged(parents);
    if (!sameFile(opened, before) || !sameFile(opened, after) || !isWithin(canonicalRoot, await realpath(target))) {
      throw new TypeError("contained file identity changed while opening");
    }
    await assertParentsUnchanged(parents);
    if (opened.size > maximumBytes) throw new TypeError("contained file exceeds its limit");
    return {
      handle,
      size: opened.size,
      assertUnchanged: async (): Promise<void> => {
        const current = await handle.stat();
        const pathname = await lstat(target);
        await assertParentsUnchanged(parents);
        if (!sameFile(opened, current) || !sameFile(opened, pathname)
          || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs
          || !isWithin(canonicalRoot, await realpath(target))) {
          throw new TypeError("contained file changed while being read");
        }
        await assertParentsUnchanged(parents);
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function safeDirectory(directory: string): Promise<Stats> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("contained file parent is unsafe");
  return info;
}

async function assertParentsUnchanged(parents: Array<{ path: string; stats: Stats }>): Promise<void> {
  for (const parent of parents) {
    const current = await safeDirectory(parent.path);
    if (current.dev !== parent.stats.dev || current.ino !== parent.stats.ino) {
      throw new TypeError("contained file parent changed while opening");
    }
  }
}

function normalizedSegments(relative: string): string[] {
  if (!relative || relative.includes("\\") || relative.startsWith("/")) throw new TypeError("contained file path is invalid");
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new TypeError("contained file path is invalid");
  return segments;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile() && right.nlink === 1;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
