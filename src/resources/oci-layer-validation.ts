import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";

export interface ImageImportBudget { maxExpandedBytes: number; maxFiles: number }
export interface ImageImportUsage { expandedBytes: number; files: number }
export const DEFAULT_IMAGE_IMPORT_BUDGET: ImageImportBudget = { maxExpandedBytes: 8 * 1024 ** 3, maxFiles: 100_000 };
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Buffer) => utf8.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
function number(bytes: Buffer): number {
  const value = text(bytes).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("unsupported OCI tar numeric encoding");
  const parsed = parseInt(value || "0", 8);
  if (!Number.isSafeInteger(parsed)) throw new Error("OCI tar size overflow");
  return parsed;
}
function safePath(value: string): string {
  if (!value || Buffer.byteLength(value) > 4096 || value.startsWith("/") || /[\\\0]/.test(value) || value.split("/").some(part => part === ".." || Buffer.byteLength(part) > 255)) throw new Error("unsafe OCI layer path");
  return path.posix.normalize(value).replace(/\/$/, "");
}

/** Inspects an uncompressed tar stream without writing any entry to disk.
 * Supports regular entries, directories, links, PAX metadata and GNU long names.
 * Sparse files and unknown entry/metadata formats fail closed before Docker runs. */
class TarBudget {
  files = 0;
  private header = Buffer.alloc(512);
  private fill = 0;
  private remaining = 0;
  private content = 0;
  private extension = "";
  private metadata: Buffer[] = [];
  private zeros = 0;
  private pending: Record<string, string> = {};
  private paths = new Map<string, string>();
  private parents = new Set<string>();
  constructor(private readonly budget: ImageImportBudget) {}
  accept(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.remaining) {
        const size = Math.min(this.remaining, bytes.length - offset);
        if (this.extension && this.content) this.metadata.push(Buffer.from(bytes.subarray(offset, offset + Math.min(size, this.content))));
        this.content = Math.max(0, this.content - size); this.remaining -= size; offset += size;
        if (!this.remaining && this.extension) this.finishExtension();
        continue;
      }
      const headerBytes = Math.min(512 - this.fill, bytes.length - offset);
      bytes.copy(this.header, this.fill, offset, offset + headerBytes); this.fill += headerBytes; offset += headerBytes;
      if (this.fill !== 512) continue;
      this.fill = 0;
      if (this.header.every(n => n === 0)) { this.zeros++; continue; }
      if (this.zeros) throw new Error("OCI tar data after end marker");
      const sum = this.header.reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (sum !== number(this.header.subarray(148, 156))) throw new Error("OCI tar checksum mismatch");
      if (++this.files > this.budget.maxFiles) throw new Error("OCI layer entry budget exceeded");
      const type = String.fromCharCode(this.header[156] || 48), rawSize = number(this.header.subarray(124, 136));
      const magic = this.header.subarray(257, 263).toString("latin1");
      if (!["ustar\0", "ustar ", "\0\0\0\0\0\0"].includes(magic)) throw new Error("unsupported OCI tar header format");
      if (["x", "g", "L", "K"].includes(type)) {
        if (rawSize < 1 || rawSize > 64 * 1024) throw new Error("OCI tar metadata budget exceeded");
        this.extension = type; this.content = rawSize; this.remaining = Math.ceil(rawSize / 512) * 512; continue;
      }
      if (!["0", "1", "2", "5"].includes(type)) throw new Error(`unsupported OCI tar entry type: ${type}`);
      const metadata = this.pending; this.pending = {};
      const prefix = magic === "ustar\0" ? text(this.header.subarray(345, 500)) : "", name = safePath(metadata.path ?? `${prefix ? `${prefix}/` : ""}${text(this.header.subarray(0, 100))}`);
      if (name === "." && type !== "5") throw new Error("invalid OCI root entry");
      if (this.paths.has(name)) throw new Error("duplicate OCI layer path");
      if (type !== "5" && this.parents.has(name)) throw new Error("OCI layer path replaces a parent directory");
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parentPath = parts.slice(0, i).join("/"); this.parents.add(parentPath);
        const parent = this.paths.get(parentPath);
        if (parent && parent !== "5") throw new Error("OCI layer path traverses a non-directory entry");
      }
      this.paths.set(name, type);
      const size = metadata.size === undefined ? rawSize : Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > this.budget.maxExpandedBytes) throw new Error("OCI layer expanded byte budget exceeded");
      if (type !== "0" && size !== 0) throw new Error("OCI non-file entry contains data");
      if (type === "1" || type === "2") {
        const target = metadata.linkpath ?? text(this.header.subarray(157, 257));
        if (!target || Buffer.byteLength(target) > 4096 || /[\\\0]/.test(target)) throw new Error("unsafe OCI layer link");
        if (type === "1") safePath(target);
        else {
          // Absolute symlinks are container-root relative. Relative links must
          // stay within that root; no host path is ever opened by this scanner.
          const resolved = path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(name), target));
          if (resolved === ".." || resolved.startsWith("../")) throw new Error("unsafe OCI layer link escape");
        }
      }
      this.remaining = Math.ceil(size / 512) * 512;
    }
  }
  private finishExtension(): void {
    const bytes = Buffer.concat(this.metadata); this.metadata = [];
    const type = this.extension; this.extension = "";
    if (type === "L" || type === "K") { this.pending[type === "L" ? "path" : "linkpath"] = text(bytes); return; }
    const values: Record<string, string> = {};
    for (let offset = 0; offset < bytes.length;) {
      const space = bytes.indexOf(32, offset), lengthText = bytes.subarray(offset, space).toString();
      const length = Number(lengthText);
      if (space < offset || !/^[1-9][0-9]*$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error("invalid OCI PAX record");
      const value = utf8.decode(bytes.subarray(space + 1, offset + length - 1)), equals = value.indexOf("="), key = value.slice(0, equals);
      if (equals < 1 || Object.hasOwn(values, key)) throw new Error("invalid OCI PAX key");
      if (!["path", "linkpath", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset", "comment", "LIBARCHIVE.creationtime"].includes(key) && !key.startsWith("SCHILY.xattr.")) throw new Error(`unsupported OCI PAX metadata: ${key}`);
      values[key] = value.slice(equals + 1); offset += length;
    }
    if (values.size !== undefined && !/^(0|[1-9][0-9]*)$/.test(values.size)) throw new Error("invalid OCI PAX size");
    if (type === "g") {
      if (["path", "linkpath", "size"].some(key => key in values)) throw new Error("unsupported OCI global path/size override");
    } else for (const key of ["path", "linkpath", "size"]) if (values[key] !== undefined) this.pending[key] = values[key]!;
  }
  finish(): void {
    if (this.fill || this.remaining || this.zeros < 2 || Object.keys(this.pending).length) throw new Error("truncated OCI layer tar");
  }
}

export async function validateOciLayer(file: string, start: number, size: number, mediaType: string, budget: ImageImportBudget, signal?: AbortSignal): Promise<ImageImportUsage & { diffId: string }> {
  const gzip = ["application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"].includes(mediaType);
  if (!gzip && mediaType !== "application/vnd.oci.image.layer.v1.tar" && mediaType !== "application/vnd.docker.image.rootfs.diff.tar") throw new Error(`unsupported OCI layer media type: ${mediaType}`);
  if (!size) throw new Error("empty OCI layer blob");
  const parser = new TarBudget(budget), hash = createHash("sha256"); let expandedBytes = 0;
  // A Writable preserves the parser failure across pipeline teardown on Node 22;
  // throwing from an async-iterator sink can replace it with an AbortError.
  const consume = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        signal?.throwIfAborted(); expandedBytes += chunk.length;
        if (expandedBytes > budget.maxExpandedBytes) throw new Error("OCI layer expanded byte budget exceeded");
        hash.update(chunk); parser.accept(chunk); callback();
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    }
  });
  const input = createReadStream(file, { start, end: start + size - 1 });
  if (gzip) await pipeline(input, createGunzip(), consume, { signal });
  else await pipeline(input, consume, { signal });
  parser.finish(); return { expandedBytes, files: parser.files, diffId: `sha256:${hash.digest("hex")}` };
}
