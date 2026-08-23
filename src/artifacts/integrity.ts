import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { HitchError, digest, fingerprintExecutable } from "../foundation/index.js";
import type { ResolvedRevision } from "../revisions/index.js";
import type { ArtifactInvocation, ArtifactManifest } from "./types.js";

export async function npmPackageEntrypoint(
  directory: string,
  packageName: string,
  binName: string,
  nodeModulesDirectory = "node_modules",
): Promise<string> {
  const packageDirectory = path.join(directory, nodeModulesDirectory, ...packageName.split("/"));
  let metadata: { bin?: string | Record<string, unknown> };
  try {
    metadata = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { bin?: string | Record<string, unknown> };
  } catch (error) {
    throw new HitchError(`installed package has no readable package.json: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  const binTarget = typeof metadata.bin === "string" ? metadata.bin : (metadata.bin as Record<string, unknown> | undefined)?.[binName];
  if (typeof binTarget !== "string" || !binTarget) {
    throw new HitchError(`installed package does not declare the ${binName} executable: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
    });
  }
  const absolute = path.resolve(packageDirectory, binTarget);
  if (absolute !== packageDirectory && !absolute.startsWith(`${packageDirectory}${path.sep}`)) {
    throw new HitchError(`package executable escapes its installation directory: ${packageName}`, {
      code: "artifact_invalid",
      exitCode: 5,
    });
  }
  return path.relative(directory, absolute);
}

export function entrypointLauncher(entrypoint: string): string {
  return /\.(?:cjs|mjs|js)$/i.test(entrypoint) ? "node" : "direct";
}

export function artifactInvocation(manifest: { entrypoint: string; launcher?: string }, directory: string): ArtifactInvocation {
  const entrypoint = path.join(directory, manifest.entrypoint);
  return manifest.launcher === "node"
    ? { executable: process.execPath, entrypoint_args: [entrypoint] }
    : { executable: entrypoint, entrypoint_args: [] };
}

export async function assertEntrypoint(file: string, launcher: string, reference: string): Promise<void> {
  try {
    await access(file, launcher === "node" ? constants.R_OK : constants.X_OK);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("entrypoint is not a file");
  } catch (error) {
    throw new HitchError(`prepared artifact has no executable entrypoint for ${reference}: ${file}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
}

export async function optionalFileDigest(file: string): Promise<string | null> {
  try {
    return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertNpmResolution(directory: string, resolved: ResolvedRevision): Promise<void> {
  let lock: { packages?: Record<string, { version?: string; integrity?: string }> };
  try {
    lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8")) as typeof lock;
  } catch (error) {
    throw new HitchError(`npm did not produce a readable dependency lock for ${resolved.canonical_ref}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  const packageName = resolved.source.package;
  const installed = packageName ? lock.packages?.[`node_modules/${packageName}`] : undefined;
  if (installed?.version !== resolved.revision.version || installed?.integrity !== resolved.source.integrity) {
    throw new HitchError(`installed package integrity does not match the resolution for ${resolved.canonical_ref}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
}

export async function assertGlobalNpmResolution(directory: string, resolved: ResolvedRevision): Promise<void> {
  const packageName = resolved.source.package;
  let metadata: { name?: string; version?: string };
  try {
    metadata = JSON.parse(await readFile(path.join(
      directory,
      "lib",
      "node_modules",
      ...(packageName || "").split("/"),
      "package.json",
    ), "utf8")) as typeof metadata;
  } catch (error) {
    throw new HitchError(`npm did not produce a readable global package for ${resolved.canonical_ref}`, {
      code: "artifact_invalid",
      exitCode: 5,
      cause: error,
    });
  }
  if (metadata.name !== packageName || metadata.version !== resolved.revision.version) {
    throw new HitchError(`installed package version does not match the resolution for ${resolved.canonical_ref}`, {
      code: "artifact_integrity_mismatch",
      exitCode: 5,
    });
  }
}

export async function sourceLockIdentity(directory: string): Promise<string | null> {
  const candidates = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock", path.join("codex-rs", "Cargo.lock")];
  const locks: Record<string, string> = {};
  for (const candidate of candidates) {
    const identity = await optionalFileDigest(path.join(directory, candidate));
    if (identity) locks[candidate] = identity;
  }
  return Object.keys(locks).length > 0 ? digest(locks) : null;
}

export async function executableMatches(executable: string, identity: string): Promise<boolean> {
  try {
    return await fingerprintExecutable(executable) === identity;
  } catch {
    return false;
  }
}

export async function artifactMatches(directory: string, manifest: ArtifactManifest): Promise<boolean> {
  if (!manifest?.entrypoint || !manifest.entrypoint_integrity || !manifest.artifact_integrity) return false;
  const root = path.resolve(directory);
  const executable = path.resolve(root, manifest.entrypoint);
  if (executable !== root && !executable.startsWith(`${root}${path.sep}`)) return false;
  if (!await executableMatches(executable, manifest.entrypoint_integrity)) return false;
  try {
    return await artifactDirectoryIntegrity(directory) === manifest.artifact_integrity;
  } catch {
    return false;
  }
}

export async function artifactDirectoryIntegrity(directory: string): Promise<string> {
  const root = path.resolve(directory);
  const hash = createHash("sha256");
  await digestArtifactDirectory(hash, root, root, "", true);
  return `sha256:${hash.digest("hex")}`;
}

async function digestArtifactDirectory(hash: ReturnType<typeof createHash>, root: string, directory: string, relative: string, topLevel: boolean): Promise<void> {
  const entries = await readdir(directory);
  entries.sort();
  for (const name of entries) {
    if (topLevel && name === "artifact.json") continue;
    const absolute = path.join(directory, name);
    const childRelative = relative ? path.join(relative, name) : name;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${childRelative}\0${info.mode & 0o7777}\0`);
      await digestArtifactDirectory(hash, root, absolute, childRelative, false);
    } else if (info.isFile()) {
      hash.update(`f\0${childRelative}\0${info.mode & 0o7777}\0${info.size}\0`);
      for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
      hash.update("\0");
    } else if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${path.sep}`)) {
        throw new HitchError(`artifact symlink escapes its installation directory: ${absolute}`, {
          code: "artifact_invalid",
          exitCode: 5,
        });
      }
      hash.update(`l\0${childRelative}\0${target}\0`);
    } else {
      throw new HitchError(`unsupported special file in prepared artifact: ${absolute}`, {
        code: "artifact_invalid",
        exitCode: 5,
      });
    }
  }
}
