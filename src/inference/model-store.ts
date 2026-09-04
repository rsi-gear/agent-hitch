import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalModelFileV1, LocalModelManifestV1, Sha256 } from "../domain/index.js";
import {
  HitchError,
  atomicWriteJSON,
  ensureDir,
  invalidInput,
  readJSON,
  sha256Bytes,
  sha256JSON,
  statePaths,
  withFileLock,
} from "../foundation/index.js";
import { localModelIdentity, parseLocalModelManifest } from "./manifest.js";

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FORBIDDEN = /(?:^|\/)(?:[^/]+\.(?:bin|pt|pth|pkl|pickle|py|so|dylib|dll))$/i;
const MAX_FILES = 100_000;

interface ModelAliasIndexV1 {
  schema_version: "1";
  aliases: Record<string, Sha256>;
}

export interface AddLocalModelOptions {
  root: string;
  directory: string;
  name: string;
  force?: boolean;
}

export async function addLocalModel(options: AddLocalModelOptions): Promise<LocalModelManifestV1> {
  return withFileLock(statePaths(options.root).inferenceOperationLocks, "model-store", () => addLocalModelLocked(options));
}

async function addLocalModelLocked(options: AddLocalModelOptions): Promise<LocalModelManifestV1> {
  if (!ALIAS.test(options.name)) throw invalidInput("model name must use lowercase letters, digits, '.', '_' or '-'");
  const source = path.resolve(options.directory);
  const paths = statePaths(options.root);
  const rootRelative = path.relative(paths.root, source);
  if (rootRelative === "" || (!rootRelative.startsWith("..") && !path.isAbsolute(rootRelative))) {
    throw invalidInput("model source directory must be outside HITCH_ROOT");
  }
  let sourceStat;
  try { sourceStat = await stat(source); } catch (error) {
    throw new HitchError(`local model directory does not exist: ${source}`, { code: "local_model_not_found", exitCode: 2, cause: error });
  }
  if (!sourceStat.isDirectory()) throw invalidInput("local model source must be a directory");

  const relativeFiles = await walkModelFiles(source);
  validateRequiredFiles(relativeFiles);
  const config = await readModelJSON(path.join(source, "config.json"), "config.json");
  rejectDynamicModelCode(config);
  validateSafetensorsIndex(source, relativeFiles, await optionalModelJSON(path.join(source, "model.safetensors.index.json")));
  for (const relative of relativeFiles.filter((file) => file.endsWith(".safetensors"))) {
    await validateSafetensorsFile(path.join(source, ...relative.split("/")), relative);
  }

  await ensureDir(paths.modelFiles);
  const files: LocalModelFileV1[] = [];
  for (const relative of relativeFiles) files.push(await importFile(paths.modelFiles, source, relative));
  const tokenizerFiles = files.filter((file) => /(?:^|\/)(?:tokenizer|special_tokens_map|added_tokens|tokenizer_config)(?:\.|$)/.test(file.path));
  const template = await discoverTemplate(source, relativeFiles);
  const quantization = modelQuantization(config);
  const identityInput = {
    schema_version: "1" as const,
    format: "hf-safetensors" as const,
    files,
    architecture: firstString(config.architectures) || "unknown",
    model_type: stringValue(config.model_type) || "unknown",
    dtype: stringValue(config.torch_dtype) || "unknown",
    quantization,
    context_tokens: positiveIntegerValue(config.max_position_embeddings),
    tokenizer_digest: sha256JSON(tokenizerFiles.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 }))),
    template_digest: template === null ? null : sha256Bytes(template),
  };
  const manifest: LocalModelManifestV1 = {
    ...identityInput,
    model_id: localModelIdentity(identityInput),
    source: {
      kind: "local-directory",
      label: path.basename(source),
      license: stringValue(config.license),
    },
    created_at: new Date().toISOString(),
  };
  const modelDirectory = path.join(paths.models, manifest.model_id.slice("sha256:".length));
  await ensureDir(modelDirectory);
  await atomicWriteJSON(path.join(modelDirectory, "manifest.json"), manifest);
  await writeAlias(paths.modelAliases, paths.inferenceOperationLocks, options.name, manifest.model_id, options.force === true);
  return manifest;
}

export interface LocalModelGcResultV1 {
  schema_version: "1";
  applied: boolean;
  models: Sha256[];
  files: Sha256[];
  reclaimed_bytes: number;
}

export async function gcLocalModels(root: string, apply = false): Promise<LocalModelGcResultV1> {
  const paths = statePaths(root);
  return withFileLock(paths.inferenceOperationLocks, "model-store", async () => {
    const aliases = await loadAliasIndex(paths.modelAliases);
    const referenced = new Set<Sha256>(Object.values(aliases.aliases));
    await collectLockedModelIds(paths.inferenceLocks, referenced);
    const manifests = await listStoredModels(paths.models);
    const removed = manifests.filter((manifest) => !referenced.has(manifest.model_id));
    const keptFiles = new Set(manifests.filter((manifest) => referenced.has(manifest.model_id))
      .flatMap((manifest) => manifest.files.map((file) => file.sha256)));
    const files = new Map<Sha256, number>();
    for (const manifest of removed) for (const file of manifest.files) {
      if (!keptFiles.has(file.sha256)) files.set(file.sha256, file.size);
    }
    if (apply) {
      for (const manifest of removed) {
        await rm(path.join(paths.models, manifest.model_id.slice("sha256:".length)), { recursive: true, force: true });
      }
      for (const digest of files.keys()) await rm(path.join(paths.modelFiles, digest.slice("sha256:".length)), { force: true });
    }
    return {
      schema_version: "1",
      applied: apply,
      models: removed.map((manifest) => manifest.model_id).sort(),
      files: [...files.keys()].sort(),
      reclaimed_bytes: [...files.values()].reduce((total, size) => total + size, 0),
    };
  });
}

async function collectLockedModelIds(directory: string, referenced: Set<Sha256>): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const value = await readJSON<unknown>(path.join(directory, entry.name, "lock.json"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw integrityError("inference lock index is invalid");
    const record = value as Record<string, unknown>;
    if (record.inference_id !== `sha256:${entry.name}` || typeof record.model_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.model_id)) {
      throw integrityError("inference lock index is invalid");
    }
    referenced.add(record.model_id as Sha256);
  }
}

async function listStoredModels(directory: string): Promise<LocalModelManifestV1[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests: LocalModelManifestV1[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const manifest = parseLocalModelManifest(await readJSON(path.join(directory, entry.name, "manifest.json")));
    if (manifest.model_id !== `sha256:${entry.name}`) throw integrityError("model directory identity is invalid");
    manifests.push(manifest);
  }
  return manifests;
}

export async function resolveLocalModel(root: string, reference: string): Promise<LocalModelManifestV1> {
  const paths = statePaths(root);
  let modelId: Sha256;
  if (/^local\/sha256:[a-f0-9]{64}$/.test(reference)) {
    modelId = reference.slice("local/".length) as Sha256;
  } else {
    const match = reference.match(/^local\/([a-z0-9][a-z0-9._-]{0,63})$/);
    if (!match) throw invalidInput("local model must be local/<name> or local/sha256:<digest>");
    const index = await loadAliasIndex(paths.modelAliases);
    const resolved = index.aliases[match[1] as string];
    if (!resolved) throw new HitchError(`local model is not registered: ${reference}`, { code: "local_model_not_found", exitCode: 2 });
    modelId = resolved;
  }
  try {
    return parseLocalModelManifest(await readJSON(path.join(paths.models, modelId.slice("sha256:".length), "manifest.json")));
  } catch (error) {
    if (error instanceof HitchError) throw error;
    throw new HitchError(`local model manifest is unavailable or invalid: ${modelId}`, {
      code: "local_model_integrity_failed", exitCode: 5, cause: error,
    });
  }
}

export async function verifyLocalModel(root: string, manifest: LocalModelManifestV1): Promise<void> {
  const paths = statePaths(root);
  for (const file of manifest.files) {
    const stored = path.join(paths.modelFiles, file.sha256.slice("sha256:".length));
    let fileStat;
    try { fileStat = await stat(stored); } catch (error) {
      throw integrityError(`model content is missing: ${file.path}`, error);
    }
    if (!fileStat.isFile() || fileStat.size !== file.size || await hashFile(stored) !== file.sha256) {
      throw integrityError(`model content failed verification: ${file.path}`);
    }
  }
}

async function walkModelFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const candidate = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw invalidInput(`model directory contains a symbolic link: ${candidate}`);
    if (entry.isDirectory()) result.push(...await walkModelFiles(root, candidate));
    else if (entry.isFile()) {
      if (FORBIDDEN.test(candidate)) throw invalidInput(`model directory contains an unsafe executable or pickle file: ${candidate}`);
      result.push(candidate);
    } else throw invalidInput(`model directory contains a non-regular entry: ${candidate}`);
    if (result.length > MAX_FILES) throw invalidInput(`model directory exceeds ${MAX_FILES} files`);
  }
  return result;
}

function validateRequiredFiles(files: string[]): void {
  if (!files.includes("config.json")) throw invalidInput("model directory must contain config.json");
  if (!files.some((file) => file.endsWith(".safetensors"))) throw invalidInput("model directory must contain safetensors weights");
  if (!files.some((file) => /^(?:.*\/)?tokenizer(?:\.json|\.model)$/.test(file))) {
    throw invalidInput("model directory must contain tokenizer.json or tokenizer.model");
  }
}

async function importFile(store: string, sourceRoot: string, relative: string): Promise<LocalModelFileV1> {
  const source = path.join(sourceRoot, ...relative.split("/"));
  const before = await lstat(source);
  if (!before.isFile()) throw invalidInput(`model entry changed during import: ${relative}`);
  const temporary = path.join(store, `.import-${process.pid}-${Date.now()}-${createHash("sha256").update(relative).digest("hex").slice(0, 12)}`);
  try {
    await copyFile(source, temporary);
    const copied = await stat(temporary);
    const fileDigest = await hashFile(temporary);
    const after = await lstat(source);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || copied.size !== after.size) {
      throw new HitchError(`model source changed during import: ${relative}`, { code: "local_model_integrity_failed", exitCode: 5 });
    }
    const target = path.join(store, fileDigest.slice("sha256:".length));
    try {
      const existing = await stat(target);
      if (!existing.isFile() || existing.size !== copied.size || await hashFile(target) !== fileDigest) {
        throw integrityError(`existing model CAS object is corrupt: ${fileDigest}`);
      }
      await rm(temporary, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      await rename(temporary, target);
      await chmod(target, 0o444);
    }
    return { path: relative, size: copied.size, sha256: fileDigest };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function hashFile(file: string): Promise<Sha256> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

async function writeAlias(file: string, locks: string, name: string, modelId: Sha256, force: boolean): Promise<void> {
  await withFileLock(locks, "model-alias-index", async () => {
    const index = await loadAliasIndex(file);
    const current = index.aliases[name];
    if (current && current !== modelId && !force) throw invalidInput(`model name already refers to ${current}; use --force to replace it`);
    await atomicWriteJSON(file, { schema_version: "1", aliases: { ...index.aliases, [name]: modelId } });
  });
}

async function loadAliasIndex(file: string): Promise<ModelAliasIndexV1> {
  const value = await readJSON<unknown>(file, { schema_version: "1", aliases: {} });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw integrityError("model alias index is invalid");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1" || !record.aliases || typeof record.aliases !== "object" || Array.isArray(record.aliases)) {
    throw integrityError("model alias index is invalid");
  }
  const aliases: Record<string, Sha256> = {};
  for (const [name, modelId] of Object.entries(record.aliases as Record<string, unknown>)) {
    if (!ALIAS.test(name) || typeof modelId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(modelId)) {
      throw integrityError("model alias index contains an invalid entry");
    }
    aliases[name] = modelId as Sha256;
  }
  return { schema_version: "1", aliases };
}

async function readModelJSON(file: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch (error) {
    throw invalidInput(`${label} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`${label} must contain a JSON object`);
  return value as Record<string, unknown>;
}

async function optionalModelJSON(file: string): Promise<Record<string, unknown> | null> {
  try { return await readModelJSON(file, path.basename(file)); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as Error).cause && ((error as Error).cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rejectDynamicModelCode(config: Record<string, unknown>): void {
  if (config.auto_map !== undefined || config.trust_remote_code === true) {
    throw invalidInput("models requiring trust_remote_code or auto_map are not supported");
  }
}

function validateSafetensorsIndex(source: string, files: string[], index: Record<string, unknown> | null): void {
  if (!index) return;
  const weights = index.weight_map;
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) throw invalidInput("safetensors index weight_map is invalid");
  for (const target of Object.values(weights as Record<string, unknown>)) {
    if (typeof target !== "string" || !target.endsWith(".safetensors") || target.includes("\\") || path.isAbsolute(target)
      || target.split("/").some((part) => !part || part === "." || part === "..") || !files.includes(target)) {
      throw invalidInput("safetensors index references a missing or unsafe shard");
    }
    if (!path.resolve(source, target).startsWith(`${source}${path.sep}`)) throw invalidInput("safetensors index escapes the model directory");
  }
}

async function validateSafetensorsFile(file: string, label: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 11) throw invalidInput(`safetensors file is truncated: ${label}`);
    const prefix = Buffer.alloc(8);
    if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length) throw invalidInput(`safetensors header is truncated: ${label}`);
    const headerLength = prefix.readBigUInt64LE();
    if (headerLength < 2n || headerLength > 100n * 1024n * 1024n || headerLength > BigInt(fileStat.size - 8)) {
      throw invalidInput(`safetensors header length is invalid: ${label}`);
    }
    const header = Buffer.alloc(Number(headerLength));
    if ((await handle.read(header, 0, header.length, 8)).bytesRead !== header.length) throw invalidInput(`safetensors header is truncated: ${label}`);
    let value: unknown;
    try { value = JSON.parse(header.toString("utf8").trimEnd()); } catch (error) {
      throw invalidInput(`safetensors header is not valid JSON: ${label}`, { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`safetensors header must be an object: ${label}`);
    const dataBytes = fileStat.size - 8 - header.length;
    let tensors = 0;
    for (const [name, descriptor] of Object.entries(value as Record<string, unknown>)) {
      if (name === "__metadata__") {
        if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw invalidInput(`safetensors metadata is invalid: ${label}`);
        continue;
      }
      tensors += 1;
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw invalidInput(`safetensors tensor descriptor is invalid: ${label}`);
      const record = descriptor as Record<string, unknown>;
      if (typeof record.dtype !== "string" || !record.dtype || !Array.isArray(record.shape)
        || record.shape.some((dimension) => !Number.isSafeInteger(dimension) || (dimension as number) < 0)
        || !Array.isArray(record.data_offsets) || record.data_offsets.length !== 2
        || record.data_offsets.some((offset) => !Number.isSafeInteger(offset) || (offset as number) < 0)
        || (record.data_offsets[0] as number) > (record.data_offsets[1] as number)
        || (record.data_offsets[1] as number) > dataBytes) {
        throw invalidInput(`safetensors tensor descriptor is invalid: ${label}`);
      }
    }
    if (tensors === 0) throw invalidInput(`safetensors file contains no tensors: ${label}`);
  } finally {
    await handle.close();
  }
}

async function discoverTemplate(source: string, files: string[]): Promise<string | null> {
  if (files.includes("chat_template.jinja")) return readFile(path.join(source, "chat_template.jinja"), "utf8");
  if (!files.includes("tokenizer_config.json")) return null;
  const config = await readModelJSON(path.join(source, "tokenizer_config.json"), "tokenizer_config.json");
  return typeof config.chat_template === "string" ? config.chat_template : null;
}

function modelQuantization(config: Record<string, unknown>): string | null {
  const quantization = config.quantization_config;
  if (!quantization || typeof quantization !== "object" || Array.isArray(quantization)) return null;
  return stringValue((quantization as Record<string, unknown>).quant_method);
}

function firstString(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" && value[0] ? value[0] : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveIntegerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function integrityError(message: string, cause?: unknown): HitchError {
  return new HitchError(message, { code: "local_model_integrity_failed", exitCode: 5, cause });
}
