/**
 * Controller runtime store: staging, promotion, cache lookup, and verified
 * use of shared read-only controller runtime bundles (spec §4).
 *
 * New eval directories do not contain a complete Hitch runtime; they hold a
 * durable `runtime.ref.json` reference. The shared bundle lives under
 * `<hitch-root>/store/controller-runtimes/sha256/<64-hex>/`.
 */

import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, chmod, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { statePaths, SCHEMA_VERSION } from "../config.js";
import type { StatePaths } from "../config.js";
import { HitchError } from "../errors.js";
import { atomicWriteJSON, ensureDir, readJSON, removeIfExists } from "../fs.js";
import { delay } from "../process.js";
import { reclaimStaleLock } from "../locks.js";
import { packageRoot } from "../package-root.js";
import {
  ControllerRuntimeIntegrityError,
  RUNTIME_PAYLOAD_RULES,
  canonicalEncodeManifest,
  hashRuntimePayload,
  verifyRuntimePayload,
} from "./hash.js";
import type { RuntimePayloadRule } from "./hash.js";
import { validateControllerRuntimeManifest } from "../domain/validate.js";
import type { ControllerRuntimeManifest } from "../domain/types.js";

/** The Hitch package root whose compiled payload is packaged as a controller runtime. */
export const PACKAGE_ROOT = packageRoot();

export interface ControllerRuntimeUseResult {
  runtime_id: string;
  /** Local absolute cache path (machine-local diagnostic state, not identity — spec §4.2). */
  directory: string;
  manifest: ControllerRuntimeManifest;
  cache_hit: boolean;
  /** SHA-256 of the canonical manifest encoding. */
  manifest_digest: string;
}

export interface ControllerRuntimeOptions {
  root: string;
  payloadRoot?: string;
  rules?: RuntimePayloadRule[];
}

/**
 * Ensure the shared controller runtime bundle for the current Hitch payload
 * exists and is verified; returns its cache path and identity.
 */
export async function ensureControllerRuntime(
  { root, payloadRoot = PACKAGE_ROOT, rules = RUNTIME_PAYLOAD_RULES }: ControllerRuntimeOptions,
): Promise<ControllerRuntimeUseResult> {
  if (!root) throw new HitchError("a Hitch state root is required for the controller runtime", { code: "invalid_input", exitCode: 2 });
  const paths = statePaths(root);
  // Stage a fresh copy, hash it, and promote under a runtime-id lock.
  const staging = await stagePayload(payloadRoot, rules);
  try {
    return await withRuntimeLock(paths, staging.runtimeId, async () => {
      return promoteStagedRuntime(paths, staging);
    });
  } finally {
    await rm(staging.directory, { recursive: true, force: true }).catch(() => {});
  }
}

interface StagedRuntime {
  directory: string;
  runtimeId: string;
}

async function stagePayload(payloadRoot: string, rules: RuntimePayloadRule[]): Promise<StagedRuntime> {
  const payloadRootReal = path.resolve(payloadRoot);
  const hashResult = await hashRuntimePayload({ payloadRoot: payloadRootReal, rules });
  const runtimeId = hashResult.runtimeId.replace("sha256:", "");

  const stagingBase = await ensureRuntimeTemporaryDir();
  const staging = path.join(stagingBase, `runtime-staging-${runtimeId.slice(0, 12)}-${randomBytes(6).toString("hex")}`);
  await mkdir(staging, { recursive: true });

  // Copy the allowlisted payload into staging. Never hardlink from the
  // development or installed package tree (spec §4.5).
  const payloadDestination = path.join(staging, "payload");
  await mkdir(payloadDestination, { recursive: true });
  await copyPayload(payloadRootReal, payloadDestination, rules);

  // Hash the staged payload and write its manifest; the complete tree is
  // verified a second time during promotion.
  const stagedHash = await hashRuntimePayload({ payloadRoot: payloadDestination, rules });
  if (stagedHash.runtimeId !== hashResult.runtimeId) {
    throw new ControllerRuntimeIntegrityError("staged runtime payload hash changed during staging");
  }
  await atomicWriteJSON(path.join(staging, "manifest.json"), stagedHash.manifest);
  return { directory: staging, runtimeId };
}

async function ensureRuntimeTemporaryDir(): Promise<string> {
  const root = path.join(tmpdir(), "hitch", "controller-runtime");
  await ensureDir(root);
  return root;
}

async function copyPayload(sourceRoot: string, destinationRoot: string, rules: RuntimePayloadRule[]): Promise<void> {
  for (const rule of rules) {
    const relative = rule.path || rule.directory || "";
    const source = path.join(sourceRoot, ...relative.split("/"));
    const destination = path.join(destinationRoot, ...relative.split("/"));
    await ensureDir(path.dirname(destination));
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  }
}

async function promoteStagedRuntime(paths: StatePaths, staging: StagedRuntime): Promise<ControllerRuntimeUseResult> {
  await ensureDir(paths.controllerRuntimes);
  const destination = path.join(paths.controllerRuntimes, staging.runtimeId);
  let promoted = false;
  try {
    await rename(staging.directory, destination);
    promoted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    // A concurrent first use promoted first; validate the existing bundle.
  }
  if (promoted) {
    await applyReadOnlyPermissions(destination);
    // Verify the promoted tree a second time before it can be used.
    const manifest = await loadManifest(destination);
    await verifyRuntimePayload(path.join(destination, "payload"), manifest);
    return {
      runtime_id: `sha256:${staging.runtimeId}`,
      directory: destination,
      manifest,
      cache_hit: false,
      manifest_digest: manifestDigest(manifest),
    };
  }
  return useControllerRuntimeById(paths, staging.runtimeId);
}

async function applyReadOnlyPermissions(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const stack: string[] = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        const payloadRelative = relativeToPayload(directory, absolute);
        const isEntrypoint = /^dist[\\/]bin[\\/]/.test(payloadRelative);
        await chmod(absolute, isEntrypoint ? 0o555 : 0o444);
      }
    }
    await chmod(current, 0o555);
  }
}

function relativeToPayload(directory: string, absolute: string): string {
  return path.relative(path.join(directory, "payload"), absolute);
}

async function withRuntimeLock<T>(paths: StatePaths, runtimeId: string, operation: () => Promise<T>): Promise<T> {
  await ensureDir(paths.controllerRuntimeLocks);
  const file = path.join(paths.controllerRuntimeLocks, `${runtimeId}.lock`);
  const owner = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await removeIfExists(file);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (await staleRuntimeLock(file)) {
        if (!await reclaimStaleLock(file, staleRuntimeLock)) await delay(100);
        continue;
      }
      await delay(100);
    }
  }
  if (!handle) {
    throw new HitchError("timed out waiting for controller runtime lock", {
      code: "controller_runtime_locked",
      exitCode: 5,
    });
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJSON<{ owner?: unknown } | null>(file, null).catch(() => null);
    if (current?.owner === owner) await removeIfExists(file);
  }
}

async function staleRuntimeLock(file: string): Promise<boolean> {
  let lock: { pid?: unknown } | null;
  try {
    lock = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
  } catch {
    try {
      return Date.now() - (await stat(file)).mtimeMs > 2_000;
    } catch {
      return true;
    }
  }
  if (!Number.isInteger(lock?.pid)) return true;
  try {
    process.kill(lock.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

async function loadManifest(directory: string): Promise<ControllerRuntimeManifest> {
  const raw = await readJSON<unknown>(path.join(directory, "manifest.json"), null);
  if (raw === null) {
    throw new ControllerRuntimeIntegrityError(`controller runtime bundle is missing its manifest: ${directory}`);
  }
  return validateControllerRuntimeManifest(raw);
}

function manifestDigest(manifest: ControllerRuntimeManifest): string {
  const encoding = canonicalEncodeManifest(manifest.files);
  return `sha256:${createHash("sha256").update(encoding).digest("hex")}`;
}

/**
 * Verify and return a controller runtime bundle by id. A missing or corrupt
 * expected runtime must not silently fall back to the installed Hitch version
 * (spec §4.6) — it fails with `controller_runtime_integrity_mismatch`.
 */
export async function useControllerRuntimeById(paths: StatePaths, runtimeId: string): Promise<ControllerRuntimeUseResult> {
  const directory = path.join(paths.controllerRuntimes, runtimeId);
  const manifest = await loadManifest(directory).catch(() => {
    throw new HitchError(`controller runtime integrity mismatch for ${runtimeId}`, {
      code: "controller_runtime_integrity_mismatch",
      exitCode: 5,
    });
  });
  if (manifest.runtime_id !== `sha256:${runtimeId}`) {
    throw new HitchError(`controller runtime integrity mismatch for ${runtimeId}`, {
      code: "controller_runtime_integrity_mismatch",
      exitCode: 5,
    });
  }
  try {
    await verifyRuntimePayload(path.join(directory, "payload"), manifest);
  } catch (error) {
    throw new HitchError(`controller runtime integrity mismatch for ${runtimeId}: ${(error as Error).message}`, {
      code: "controller_runtime_integrity_mismatch",
      exitCode: 5,
      cause: error,
    });
  }
  return {
    runtime_id: `sha256:${runtimeId}`,
    directory,
    manifest,
    cache_hit: true,
    manifest_digest: manifestDigest(manifest),
  };
}

export interface ControllerRuntimeReference {
  schema_version: string;
  storage: "controller-runtime-ref-v1";
  runtime_id: string;
  manifest_digest: string;
  created_at: string;
}

export async function writeRuntimeReference(evalDirectory: string, use: ControllerRuntimeUseResult): Promise<string> {
  const ref: ControllerRuntimeReference = {
    schema_version: SCHEMA_VERSION,
    storage: "controller-runtime-ref-v1",
    runtime_id: use.runtime_id,
    manifest_digest: use.manifest_digest,
    created_at: new Date().toISOString(),
  };
  const file = path.join(evalDirectory, "runtime.ref.json");
  await atomicWriteJSON(file, ref);
  return file;
}

/** Detect which runtime storage kind an eval record uses (spec §4.7, §9). */
export async function inspectEvalRuntimeKind(evalDirectory: string): Promise<"controller-runtime-ref-v1" | "embedded-runtime-v1" | "none"> {
  const ref = await readJSON<{ storage?: unknown } | null>(path.join(evalDirectory, "runtime.ref.json"), null);
  if (ref?.storage === "controller-runtime-ref-v1") return "controller-runtime-ref-v1";
  try {
    const info = await stat(path.join(evalDirectory, "runtime"));
    if (info.isDirectory()) return "embedded-runtime-v1";
  } catch {
    // Not an embedded runtime.
  }
  return "none";
}
