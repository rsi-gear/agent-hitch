/**
 * Controller runtime bundle: canonical hashing, manifest construction, and
 * integrity verification (spec §4).
 *
 * The runtime identity is a content-addressed SHA-256 over an explicit
 * allowlist of compiled payload files, excluding cache path, source path,
 * mtime, uid/gid, creation time, and host-specific metadata. The executable
 * bit is included.
 */

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ControllerRuntimeEntrypoints, ControllerRuntimeFile, ControllerRuntimeManifest } from "../domain/index.js";

export const RUNTIME_SCHEMA_VERSION = "2";
export const RUNTIME_NODE_RANGE = ">=22";

/**
 * Directories of the compiled payload that are part of every runtime. This is
 * the execution closure the Harbor bridge actually runs — not a mechanical
 * copy of the published package. Runtime tooling (`dist/scripts`, release
 * checkers) is deliberately excluded so editing a release script never changes
 * a controller `runtime_id` (spec §4.4).
 */
export const RUNTIME_PAYLOAD_DIRECTORIES = ["dist/bin", "dist/src", "node_modules/smol-toml"] as const;

/** Python modules imported by Harbor while it is constructing trial agents. */
export const RUNTIME_HARBOR_BRIDGE_FILES = [
  "integrations/harbor/hitch_harbor_agent.py",
  "integrations/harbor/hitch_harbor_environment.py",
  "integrations/harbor/hitch_harbor_task_resources.py",
  "integrations/harbor/hitch_harbor_verifier.py",
  "integrations/harbor/hitch_benchmark.py",
  "integrations/harbor/hitch_tool_client.mjs",
] as const;

/**
 * The declared CLI entrypoint, relative to the upload root (`/opt/hitch`).
 * The bridge reads this from the manifest instead of hardcoding the TypeScript
 * build layout (spec §4.3, §8.5).
 */
export const RUNTIME_CLI_ENTRYPOINT = "dist/bin/hitch.js";

/** An explicitly allowlisted payload file that will be part of every runtime. */
export interface RuntimePayloadRule {
  /** Path relative to the runtime payload root (the package root). */
  path?: string;
  executable?: boolean;
  /** Directory tree to allowlist recursively (paths inside are auto-declared). */
  directory?: string;
}

/** Include the pinned TOML parser's execution closure in transported runtimes. */
export const RUNTIME_PAYLOAD_RULES: RuntimePayloadRule[] = [
  { path: "package.json" },
  { path: "integrations/model-call/cli.js" },
  ...RUNTIME_PAYLOAD_DIRECTORIES.map((directory) => ({ directory })),
  ...RUNTIME_HARBOR_BRIDGE_FILES.map((bridge) => ({ path: bridge })),
];

export interface DeclaredFile {
  /** Normalized manifest path, NFC, `/` separators. */
  path: string;
  size: number;
  executable: boolean;
  sha256: string;
}

export interface RuntimeHashInput {
  /** Absolute path to the payload root (package root) being hashed. */
  payloadRoot: string;
  /** Rules for the explicit allowlist. */
  rules?: RuntimePayloadRule[];
}

export interface RuntimeHashResult {
  manifest: ControllerRuntimeManifest;
  /** Canonical encoding digest (the `runtime_id`). */
  runtimeId: string;
  /** Number of declared payload files. */
  fileCount: number;
  /** Total payload bytes. */
  totalBytes: number;
}

export class ControllerRuntimeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerRuntimeIntegrityError";
  }
}

/**
 * Compute the canonical runtime identity and manifest for a payload tree.
 * Validates the allowlist, rejects undeclared/special files, and hashes each
 * file's original bytes. The `entrypoints` declaration participates in the
 * canonical `runtime_id` hash (spec §4.4).
 */
export async function hashRuntimePayload(input: RuntimeHashInput): Promise<RuntimeHashResult> {
  const rules = input.rules || RUNTIME_PAYLOAD_RULES;
  const declared = await enumerateAllowlist(input.payloadRoot, rules);
  const files = await hashDeclaredFiles(input.payloadRoot, declared);

  // Entrypoints are recorded as executable regardless of the build-time mode;
  // promotion sets them to 0555 (spec §4.5). Any byte or executable-bit
  // change after promotion then fails integrity verification (spec §11.1).
  for (const file of files) {
    if (isEntrypointPath(file.path)) file.executable = true;
  }

  const entrypoints: ControllerRuntimeEntrypoints = {
    cli: { path: RUNTIME_CLI_ENTRYPOINT, launcher: "node" },
  };
  const canonical = canonicalEncodeManifest({ entrypoints, files });
  const runtimeId = createHash("sha256").update(canonical).digest("hex");
  const created_at = new Date().toISOString();
  const manifest: ControllerRuntimeManifest = {
    schema_version: RUNTIME_SCHEMA_VERSION,
    runtime_id: `sha256:${runtimeId}`,
    node_range: RUNTIME_NODE_RANGE,
    entrypoints,
    files,
    created_at,
  };
  return {
    manifest,
    runtimeId: `sha256:${runtimeId}`,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

/**
 * True when a payload path is THE declared CLI entrypoint. Only
 * `entrypoints.cli.path` is marked executable after promotion; sibling files
 * in the same directory (e.g. `.map` sources) stay non-executable (spec §4.5).
 */
export function isEntrypointPath(normalizedPath: string): boolean {
  return normalizedPath === RUNTIME_CLI_ENTRYPOINT;
}

/**
 * Enumerate the explicit allowlist into normalized declared paths, rejecting
 * symlinks, hardlinks, devices, FIFOs, sockets, path traversal, duplicate
 * paths, and undeclared files (spec §4.4.2).
 */
export async function enumerateAllowlist(payloadRoot: string, rules: RuntimePayloadRule[]): Promise<DeclaredFile[]> {
  const root = path.resolve(payloadRoot);
  const seen = new Set<string>();
  const declared: DeclaredFile[] = [];
  const push = (rawPath: string): void => {
    const normalized = normalizePath(rawPath);
    if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new ControllerRuntimeIntegrityError(`runtime payload path escapes the payload root: ${rawPath}`);
    }
    if (seen.has(normalized)) {
      throw new ControllerRuntimeIntegrityError(`duplicate runtime payload path: ${normalized}`);
    }
    seen.add(normalized);
  };
  const infoByPath = new Map<string, { size: number; executable: boolean }>();

  for (const rule of rules) {
    const rulePath = rule.path || rule.directory || "";
    const absolute = path.resolve(root, rulePath);
    if (absolute !== root && !isWithin(root, absolute)) {
      throw new ControllerRuntimeIntegrityError(`runtime payload rule escapes the payload root: ${rulePath}`);
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      throw new ControllerRuntimeIntegrityError(`runtime payload rule is missing: ${rulePath}`);
    }
    if (info.isDirectory()) {
      await walkDirectory(root, absolute, rulePath, push, infoByPath, rule.executable === true);
    } else if (info.isFile()) {
      push(rulePath);
      infoByPath.set(normalizePath(rulePath), { size: info.size, executable: rule.executable === true || isExecutableMode(info.mode) });
    } else if (info.isSymbolicLink()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${rulePath}`);
    } else {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain special files: ${rulePath}`);
    }
  }

  // Reject undeclared files inside the allowlisted payload trees. The payload
  // root itself may contain non-payload files (docs, tests, tooling) that are
  // not part of the runtime bundle, so only declared trees are scanned here;
  // the staged payload (which contains only allowlisted content) is scanned
  // again during verification (spec §4.4.2, §4.6).
  for (const rule of rules) {
    const rulePath = rule.path || rule.directory || "";
    if (!rulePath) continue;
    const absolute = path.resolve(root, ...rulePath.split("/"));
    const relative = normalizePath(rulePath);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      await rejectUndeclaredFiles(root, absolute, relative, seen, new Set());
    }
  }

  for (const normalized of [...seen].sort(compareUtf8)) {
    const meta = infoByPath.get(normalized);
    if (!meta) throw new ControllerRuntimeIntegrityError(`declared payload file has no metadata: ${normalized}`);
    declared.push({
      path: normalized,
      size: meta.size,
      executable: meta.executable,
      sha256: "",
    });
  }
  return declared;
}

async function walkDirectory(
  root: string,
  absolute: string,
  relative: string,
  push: (rawPath: string) => void,
  infoByPath: Map<string, { size: number; executable: boolean }>,
  forceExecutable: boolean,
): Promise<void> {
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const childAbsolute = path.join(absolute, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(childAbsolute);
    if (info.isDirectory()) {
      await walkDirectory(root, childAbsolute, childRelative, push, infoByPath, forceExecutable);
    } else if (info.isFile()) {
      push(childRelative);
      infoByPath.set(normalizePath(childRelative), {
        size: info.size,
        executable: forceExecutable || isExecutableMode(info.mode),
      });
    } else if (info.isSymbolicLink()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${childRelative}`);
    } else {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain special files: ${childRelative}`);
    }
  }
}

async function rejectUndeclaredFiles(
  root: string,
  absolute: string,
  relative: string,
  declared: Set<string>,
  visited: Set<string>,
): Promise<void> {
  const real = await realpathOrThrow(absolute);
  if (visited.has(real)) return; // A symlink-free tree cannot alias, but guard anyway.
  visited.add(real);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const childAbsolute = path.join(absolute, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const info = await lstat(childAbsolute);
    if (info.isDirectory()) {
      await rejectUndeclaredFiles(root, childAbsolute, childRelative, declared, visited);
    } else {
      const normalized = normalizePath(childRelative);
      if (!declared.has(normalized)) {
        throw new ControllerRuntimeIntegrityError(`undeclared file in runtime payload: ${childRelative}`);
      }
    }
  }
}

async function realpathOrThrow(file: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(file);
}

async function hashDeclaredFiles(payloadRoot: string, declared: DeclaredFile[]): Promise<ControllerRuntimeFile[]> {
  const root = path.resolve(payloadRoot);
  const files: ControllerRuntimeFile[] = [];
  for (const entry of declared) {
    const absolute = path.join(root, ...entry.path.split("/"));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      throw new ControllerRuntimeIntegrityError(`runtime payload file is not readable: ${entry.path}`);
    }
    if (info.isSymbolicLink()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${entry.path}`);
    }
    if (!info.isFile()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload entry is not a regular file: ${entry.path}`);
    }
    if (info.nlink > 1) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain hardlinks: ${entry.path}`);
    }
    const digest = await hashFile(absolute);
    files.push({
      path: entry.path,
      size: info.size,
      executable: entry.executable,
      sha256: `sha256:${digest}`,
    });
  }
  return files;
}

async function hashFile(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Verify a manifest against its payload tree: declared file set, sizes,
 * executable bits, and SHA-256 digests (spec §4.6).
 */
export async function verifyRuntimePayload(payloadRoot: string, manifest: ControllerRuntimeManifest): Promise<void> {
  const root = path.resolve(payloadRoot);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) {
      throw new ControllerRuntimeIntegrityError(`duplicate manifest path: ${file.path}`);
    }
    seen.add(file.path);
    const normalized = normalizePath(file.path);
    if (normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new ControllerRuntimeIntegrityError(`manifest path escapes the payload root: ${file.path}`);
    }
    const absolute = path.join(root, ...normalized.split("/"));
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      throw new ControllerRuntimeIntegrityError(`runtime payload file is missing: ${file.path}`);
    }
    if (info.isSymbolicLink()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${file.path}`);
    }
    if (!info.isFile()) {
      throw new ControllerRuntimeIntegrityError(`runtime payload entry is not a regular file: ${file.path}`);
    }
    if (info.nlink > 1) {
      throw new ControllerRuntimeIntegrityError(`runtime payload must not contain hardlinks: ${file.path}`);
    }
    if (info.size !== file.size) {
      throw new ControllerRuntimeIntegrityError(`runtime payload size mismatch for ${file.path}: expected ${file.size}, got ${info.size}`);
    }
    // NTFS does not expose a stable POSIX executable bit through Node. The
    // signed manifest remains authoritative on Windows and materializers set
    // its declared mode when the runtime is transported to a POSIX sandbox.
    if (process.platform !== "win32" && file.executable !== isExecutableMode(info.mode)) {
      throw new ControllerRuntimeIntegrityError(`runtime payload executable bit mismatch for ${file.path}`);
    }
    const digest = await hashFile(absolute);
    if (`sha256:${digest}` !== file.sha256) {
      throw new ControllerRuntimeIntegrityError(`runtime payload digest mismatch for ${file.path}`);
    }
  }
  // Reject undeclared files in the payload tree.
  await rejectUndeclaredFiles(root, root, "", seen, new Set());
}

/**
 * Canonically encode the runtime identity `{ schema_version, node_range,
 * entrypoints, files }` with sorted object keys and no insignificant
 * whitespace (spec §4.4.6). The `entrypoints` declaration participates in the
 * identity hash.
 */
export function canonicalEncodeManifest(input: {
  entrypoints: ControllerRuntimeEntrypoints;
  files: ControllerRuntimeFile[];
}): string {
  const sortedFiles = [...input.files].sort((left, right) => compareUtf8(left.path, right.path));
  const payload = {
    schema_version: RUNTIME_SCHEMA_VERSION,
    node_range: RUNTIME_NODE_RANGE,
    entrypoints: {
      cli: {
        path: input.entrypoints.cli.path,
        launcher: input.entrypoints.cli.launcher,
      },
    },
    files: sortedFiles.map((file) => ({
      path: file.path,
      size: file.size,
      executable: file.executable,
      sha256: file.sha256,
    })),
  };
  return canonicalStringify(payload);
}

/** Encode a full manifest (identity fields plus descriptive created_at) canonically. */
export function canonicalEncodeManifestWithCreatedAt(manifest: ControllerRuntimeManifest): string {
  return canonicalEncodeManifest({ entrypoints: manifest.entrypoints, files: manifest.files });
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Normalize a manifest path to NFC with `/` separators. */
export function normalizePath(rawPath: string): string {
  const withSeparators = rawPath.split("\\").join("/");
  const nfc = withSeparators.normalize("NFC");
  return path.posix.normalize(nfc).replace(/^\.\//, "");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
