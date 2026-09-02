import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";
import { sha256Bytes, sha256JSON } from "../foundation/index.js";

export interface ResolvedBuildContextV1 {
  context_directory: string;
  dockerfile: string;
  context_digest: Sha256;
  dockerfile_digest: Sha256;
}

export async function resolveBuildContext(contextDirectory: string, dockerfile = "Dockerfile"): Promise<ResolvedBuildContextV1> {
  const root = path.resolve(contextDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError("image build context must be a real directory");
  if (!dockerfile || path.isAbsolute(dockerfile) || dockerfile.includes("\\")) throw new TypeError("image Dockerfile path is invalid");
  const dockerfileParts = dockerfile.split("/");
  if (dockerfileParts.some((part) => !part || part === "." || part === "..")) throw new TypeError("image Dockerfile path is invalid");
  const files = await contextFiles(root);
  const dockerfileEntry = files.find((entry) => entry.path === dockerfile);
  if (!dockerfileEntry) throw new TypeError("image Dockerfile is not a regular context file");
  return {
    context_directory: root,
    dockerfile,
    context_digest: sha256JSON(files),
    dockerfile_digest: dockerfileEntry.digest,
  };
}

async function contextFiles(root: string): Promise<Array<{ path: string; digest: Sha256; executable: boolean }>> {
  const files: Array<{ path: string; digest: Sha256; executable: boolean }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new TypeError(`image build context contains unsupported file: ${entry.name}`);
      if (stat.isDirectory()) await visit(absolute);
      else files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        digest: sha256Bytes(await readFile(absolute)),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };
  await visit(root);
  return files;
}
