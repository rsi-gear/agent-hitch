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
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
export const RUNTIME_SCHEMA_VERSION = "1";
export const RUNTIME_NODE_RANGE = ">=22";
export const RUNTIME_PAYLOAD_DIRECTORY = "dist";
/** The compiled payload allowlist. V1 keeps zero runtime npm dependencies. */
export const RUNTIME_PAYLOAD_RULES = [
    { path: "package.json" },
    { directory: RUNTIME_PAYLOAD_DIRECTORY },
];
export class ControllerRuntimeIntegrityError extends Error {
    constructor(message) {
        super(message);
        this.name = "ControllerRuntimeIntegrityError";
    }
}
/**
 * Compute the canonical runtime identity and manifest for a payload tree.
 * Validates the allowlist, rejects undeclared/special files, and hashes each
 * file's original bytes.
 */
export async function hashRuntimePayload(input) {
    const rules = input.rules || RUNTIME_PAYLOAD_RULES;
    const declared = await enumerateAllowlist(input.payloadRoot, rules);
    const files = await hashDeclaredFiles(input.payloadRoot, declared);
    // Entrypoints are recorded as executable regardless of the build-time mode;
    // promotion sets them to 0555 (spec §4.5). Any byte or executable-bit
    // change after promotion then fails integrity verification (spec §11.1).
    for (const file of files) {
        if (isEntrypointPath(file.path))
            file.executable = true;
    }
    const canonical = canonicalEncodeManifest(files);
    const runtimeId = createHash("sha256").update(canonical).digest("hex");
    const created_at = new Date().toISOString();
    const manifest = {
        schema_version: RUNTIME_SCHEMA_VERSION,
        runtime_id: `sha256:${runtimeId}`,
        node_range: RUNTIME_NODE_RANGE,
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
/** True when a payload path is a runtime entrypoint (executable after promotion). */
export function isEntrypointPath(normalizedPath) {
    return normalizedPath === "dist/bin/hitch.js" || normalizedPath.startsWith("dist/bin/");
}
/**
 * Enumerate the explicit allowlist into normalized declared paths, rejecting
 * symlinks, hardlinks, devices, FIFOs, sockets, path traversal, duplicate
 * paths, and undeclared files (spec §4.4.2).
 */
export async function enumerateAllowlist(payloadRoot, rules) {
    const root = path.resolve(payloadRoot);
    const seen = new Set();
    const declared = [];
    const push = (rawPath) => {
        const normalized = normalizePath(rawPath);
        if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.startsWith("/")) {
            throw new ControllerRuntimeIntegrityError(`runtime payload path escapes the payload root: ${rawPath}`);
        }
        if (seen.has(normalized)) {
            throw new ControllerRuntimeIntegrityError(`duplicate runtime payload path: ${normalized}`);
        }
        seen.add(normalized);
    };
    const infoByPath = new Map();
    for (const rule of rules) {
        const rulePath = rule.path || rule.directory || "";
        const absolute = path.resolve(root, rulePath);
        if (absolute !== root && !isWithin(root, absolute)) {
            throw new ControllerRuntimeIntegrityError(`runtime payload rule escapes the payload root: ${rulePath}`);
        }
        let info;
        try {
            info = await lstat(absolute);
        }
        catch (error) {
            throw new ControllerRuntimeIntegrityError(`runtime payload rule is missing: ${rulePath}`);
        }
        if (info.isDirectory()) {
            await walkDirectory(root, absolute, rulePath, push, infoByPath, rule.executable === true);
        }
        else if (info.isFile()) {
            push(rulePath);
            infoByPath.set(normalizePath(rulePath), { size: info.size, executable: rule.executable === true || isExecutableMode(info.mode) });
        }
        else if (info.isSymbolicLink()) {
            throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${rulePath}`);
        }
        else {
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
        if (!rulePath)
            continue;
        const absolute = path.resolve(root, ...rulePath.split("/"));
        const relative = normalizePath(rulePath);
        const info = await lstat(absolute);
        if (info.isDirectory()) {
            await rejectUndeclaredFiles(root, absolute, relative, seen, new Set());
        }
    }
    for (const normalized of [...seen].sort(compareUtf8)) {
        const meta = infoByPath.get(normalized);
        if (!meta)
            throw new ControllerRuntimeIntegrityError(`declared payload file has no metadata: ${normalized}`);
        declared.push({
            path: normalized,
            size: meta.size,
            executable: meta.executable,
            sha256: "",
        });
    }
    return declared;
}
async function walkDirectory(root, absolute, relative, push, infoByPath, forceExecutable) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
        const childAbsolute = path.join(absolute, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const info = await lstat(childAbsolute);
        if (info.isDirectory()) {
            await walkDirectory(root, childAbsolute, childRelative, push, infoByPath, forceExecutable);
        }
        else if (info.isFile()) {
            push(childRelative);
            infoByPath.set(normalizePath(childRelative), {
                size: info.size,
                executable: forceExecutable || isExecutableMode(info.mode),
            });
        }
        else if (info.isSymbolicLink()) {
            throw new ControllerRuntimeIntegrityError(`runtime payload must not contain symlinks: ${childRelative}`);
        }
        else {
            throw new ControllerRuntimeIntegrityError(`runtime payload must not contain special files: ${childRelative}`);
        }
    }
}
async function rejectUndeclaredFiles(root, absolute, relative, declared, visited) {
    const real = await realpathOrThrow(absolute);
    if (visited.has(real))
        return; // A symlink-free tree cannot alias, but guard anyway.
    visited.add(real);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
        const childAbsolute = path.join(absolute, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const info = await lstat(childAbsolute);
        if (info.isDirectory()) {
            await rejectUndeclaredFiles(root, childAbsolute, childRelative, declared, visited);
        }
        else {
            const normalized = normalizePath(childRelative);
            if (!declared.has(normalized)) {
                throw new ControllerRuntimeIntegrityError(`undeclared file in runtime payload: ${childRelative}`);
            }
        }
    }
}
async function realpathOrThrow(file) {
    const { realpath } = await import("node:fs/promises");
    return realpath(file);
}
async function hashDeclaredFiles(payloadRoot, declared) {
    const root = path.resolve(payloadRoot);
    const files = [];
    for (const entry of declared) {
        const absolute = path.join(root, ...entry.path.split("/"));
        let info;
        try {
            info = await stat(absolute);
        }
        catch (error) {
            throw new ControllerRuntimeIntegrityError(`runtime payload file is not readable: ${entry.path}`);
        }
        if (!info.isFile()) {
            throw new ControllerRuntimeIntegrityError(`runtime payload entry is not a regular file: ${entry.path}`);
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
async function hashFile(file) {
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file))
        hash.update(chunk);
    return hash.digest("hex");
}
/**
 * Verify a manifest against its payload tree: declared file set, sizes,
 * executable bits, and SHA-256 digests (spec §4.6).
 */
export async function verifyRuntimePayload(payloadRoot, manifest) {
    const root = path.resolve(payloadRoot);
    const seen = new Set();
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
            info = await stat(absolute);
        }
        catch {
            throw new ControllerRuntimeIntegrityError(`runtime payload file is missing: ${file.path}`);
        }
        if (!info.isFile()) {
            throw new ControllerRuntimeIntegrityError(`runtime payload entry is not a regular file: ${file.path}`);
        }
        if (info.size !== file.size) {
            throw new ControllerRuntimeIntegrityError(`runtime payload size mismatch for ${file.path}: expected ${file.size}, got ${info.size}`);
        }
        if (file.executable !== isExecutableMode(info.mode)) {
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
 * Canonically encode `{ schema_version, node_range, files }` with sorted
 * object keys and no insignificant whitespace (spec §4.4.6).
 */
export function canonicalEncodeManifest(files) {
    const sortedFiles = [...files].sort((left, right) => compareUtf8(left.path, right.path));
    const payload = {
        schema_version: RUNTIME_SCHEMA_VERSION,
        node_range: RUNTIME_NODE_RANGE,
        files: sortedFiles.map((file) => ({
            path: file.path,
            size: file.size,
            executable: file.executable,
            sha256: file.sha256,
        })),
    };
    return canonicalStringify(payload);
}
function canonicalStringify(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalStringify).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value;
        const keys = Object.keys(record).sort(compareUtf8);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
/** Normalize a manifest path to NFC with `/` separators. */
export function normalizePath(rawPath) {
    const withSeparators = rawPath.split("\\").join("/");
    const nfc = withSeparators.normalize("NFC");
    return path.posix.normalize(nfc).replace(/^\.\//, "");
}
function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function isExecutableMode(mode) {
    return (mode & 0o111) !== 0;
}
function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
//# sourceMappingURL=hash.js.map