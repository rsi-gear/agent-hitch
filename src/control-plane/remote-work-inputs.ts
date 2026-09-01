import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackendWorkItemV1, EvalExecutionPlanV1, EvalRequest, RemoteWorkInputRefV1, ResolvedRevision, Sha256 } from "../domain/index.js";
import { HitchError, ensureDir, statePaths, withFileLock } from "../foundation/index.js";
import type { EvalRemoteWorkExecutor } from "../evals/index.js";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 100_000;
const SHA256 = /^sha256:([a-f0-9]{64})$/;

interface RemoteTreeFileV1 { path: string; mode: 420 | 493; size: number; sha256: Sha256; content_base64: string }
export interface RemoteTreeEnvelopeV1 { schema_version: "1"; files: RemoteTreeFileV1[] }

export class RemoteWorkInputStore {
  private readonly directory: string;
  private readonly locks: string;

  constructor(root: string) {
    if (!root) throw new TypeError("remote work input root is required");
    const paths = statePaths(root);
    this.directory = paths.workerInputs;
    this.locks = paths.workerProtocolLocks;
  }

  async initialize(): Promise<void> { await Promise.all([ensureDir(this.directory), ensureDir(this.locks)]); }

  async put(kind: RemoteWorkInputRefV1["kind"], format: RemoteWorkInputRefV1["format"], content: Buffer): Promise<RemoteWorkInputRefV1> {
    if (content.length > MAX_INPUT_BYTES) throw inputError("remote work input exceeds its size limit");
    const digest = hash(content);
    const file = this.pathFor(digest);
    await withFileLock(this.locks, `input-${digest.slice("sha256:".length)}`, async () => {
      const existing = await readFile(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (hash(existing) !== digest || !existing.equals(content)) throw inputError("remote work input store identity conflict");
        return;
      }
      await ensureDir(path.dirname(file));
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
    }, { timeoutCode: "worker_input_locked", timeoutExitCode: 12 });
    return { kind, format, digest, size: content.length };
  }

  async verify(ref: RemoteWorkInputRefV1): Promise<{ path: string; size: number }> {
    validateRef(ref);
    const file = this.pathFor(ref.digest);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== ref.size) throw inputError("remote work input is missing or unsafe");
    if (hash(await readFile(file)) !== ref.digest) throw inputError("remote work input failed digest verification");
    return { path: file, size: ref.size };
  }

  pathFor(digest: Sha256): string {
    const match = digest.match(SHA256);
    if (!match) throw inputError("remote work input digest is invalid");
    return path.join(this.directory, `${match[1]}.blob`);
  }
}

export async function prepareRemoteWorkInputs(input: {
  root: string;
  request: EvalRequest;
  plan: EvalExecutionPlanV1;
  work: BackendWorkItemV1;
  resolvedRevision: ResolvedRevision;
  preparedArtifact: Parameters<EvalRemoteWorkExecutor>[0]["preparedArtifact"];
  runtimeDirectory: string;
  runtimeId: string;
}): Promise<RemoteWorkInputRefV1[]> {
  const store = new RemoteWorkInputStore(input.root);
  await store.initialize();
  const taskId = input.work.task_ids[0];
  if (!taskId || input.work.task_ids.length !== 1) throw inputError("remote work input requires exactly one task");
  const taskDirectory = await resolveTaskDirectory(input.request.dataset, taskId);
  const spec = Buffer.from(`${JSON.stringify({
    schema_version: "1", request: { ...input.request, dataset: "task-input" }, plan: input.plan,
    work: input.work, resolution: input.resolvedRevision,
    harness_artifact: { ...input.preparedArtifact, directory: "harness-artifact" },
    controller_runtime: { runtime_id: input.runtimeId, directory: "controller-runtime" },
    task: { task_id: taskId, directory: "task-input" },
  })}\n`);
  const [workSpec, harness, runtime, task] = await Promise.all([
    store.put("work-spec", "json", spec),
    encodeTree(input.preparedArtifact.directory).then((body) => store.put("harness-artifact", "hitch-tree-v1", body)),
    encodeTree(input.runtimeDirectory).then((body) => store.put("controller-runtime", "hitch-tree-v1", body)),
    encodeTree(taskDirectory).then((body) => store.put("task-input", "hitch-tree-v1", body)),
  ]);
  return [workSpec, harness, runtime, task];
}

export function parseRemoteTreeEnvelope(value: unknown): RemoteTreeEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inputError("remote tree envelope is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "schema_version" && key !== "files") || record.schema_version !== "1"
    || !Array.isArray(record.files) || record.files.length < 1 || record.files.length > MAX_FILES) throw inputError("remote tree envelope is invalid");
  const files = record.files.map(parseFile);
  const sorted = [...files].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  if (JSON.stringify(files) !== JSON.stringify(sorted) || new Set(files.map((file) => file.path)).size !== files.length) throw inputError("remote tree files are not canonical and unique");
  return { schema_version: "1", files };
}

export async function materializeRemoteTreeEnvelope(value: unknown, destination: string): Promise<void> {
  const envelope = parseRemoteTreeEnvelope(value);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    for (const file of envelope.files) {
      const target = path.join(destination, ...file.path.split("/"));
      await ensureDir(path.dirname(target));
      await writeFile(target, Buffer.from(file.content_base64, "base64"), { flag: "wx", mode: file.mode });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function validateRef(ref: RemoteWorkInputRefV1): void {
  if (!new Set(["work-spec", "harness-artifact", "controller-runtime", "task-input"]).has(ref.kind)
    || !new Set(["json", "hitch-tree-v1"]).has(ref.format) || !SHA256.test(ref.digest)
    || !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > MAX_INPUT_BYTES) throw inputError("remote work input ref is invalid");
}

async function encodeTree(root: string): Promise<Buffer> {
  const files = await walk(root);
  const body = Buffer.from(`${JSON.stringify({ schema_version: "1", files })}\n`);
  if (body.length > MAX_INPUT_BYTES) throw inputError("remote work input tree exceeds its size limit");
  return body;
}

async function walk(root: string, relative = ""): Promise<RemoteTreeFileV1[]> {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: RemoteTreeFileV1[] = [];
  for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    safePath(child);
    const target = path.join(root, ...child.split("/"));
    const info = await lstat(target);
    if (info.isDirectory()) files.push(...await walk(root, child));
    else if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) {
      const content = await readFile(target);
      files.push({ path: child, mode: info.mode & 0o111 ? 0o755 : 0o644, size: content.length, sha256: hash(content), content_base64: content.toString("base64") });
    } else throw inputError(`remote work input contains an unsafe entry: ${child}`);
    if (files.length > MAX_FILES) throw inputError("remote work input has too many files");
  }
  return files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

function parseFile(value: unknown): RemoteTreeFileV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inputError("remote tree file is invalid");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !["path", "mode", "size", "sha256", "content_base64"].includes(key))) throw inputError("remote tree file is invalid");
  const relative = safePath(file.path);
  if (file.mode !== 0o644 && file.mode !== 0o755 || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_INPUT_BYTES
    || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)
    || typeof file.content_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) throw inputError("remote tree file is invalid");
  const content = Buffer.from(file.content_base64, "base64");
  if (content.length !== file.size || hash(content) !== file.sha256) throw inputError(`remote tree file integrity failed: ${relative}`);
  return { path: relative, mode: file.mode, size: file.size as number, sha256: file.sha256 as Sha256, content_base64: file.content_base64 };
}

async function resolveTaskDirectory(dataset: string, taskId: string): Promise<string> {
  if (!taskId || taskId.includes("/") || taskId.includes("\\") || taskId === "." || taskId === "..") throw inputError("remote task id is unsafe");
  const root = path.resolve(dataset);
  const rootTask = path.join(root, "task.toml");
  const directory = (await lstat(rootTask).catch(() => null))?.isFile() && path.basename(root) === taskId ? root : path.join(root, taskId);
  if (!(await lstat(path.join(directory, "task.toml")).catch(() => null))?.isFile()) throw inputError("remote task input is missing task.toml");
  return directory;
}

function safePath(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw inputError("remote tree path is unsafe");
  return value;
}
function hash(value: Buffer): Sha256 { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function inputError(message: string): HitchError { return new HitchError(message, { code: "remote_input_invalid", exitCode: 12 }); }
