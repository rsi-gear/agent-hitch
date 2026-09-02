import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sha256 } from "../domain/index.js";

const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const PINNED_IMAGE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/;

export async function inspectPinnedDockerfileBases(contextDirectory: string, dockerfile = "Dockerfile"): Promise<Array<{ reference: string; digest: Sha256 }>> {
  const contents = await readFile(path.join(contextDirectory, dockerfile));
  if (contents.byteLength > MAX_DOCKERFILE_BYTES || contents.includes(0)) throw unsupported("Dockerfile size or encoding is unsupported");
  const text = contents.toString("utf8");
  if (Buffer.from(text, "utf8").compare(contents) !== 0) throw unsupported("Dockerfile must be UTF-8");
  const aliases = new Set<string>();
  const bases = new Map<string, Sha256>();
  let stages = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      if (/^#\s*escape\s*=/i.test(line)) throw unsupported("Dockerfile escape directives are unsupported");
      continue;
    }
    if (line.endsWith("\\")) throw unsupported("Dockerfile continuation lines are unsupported");
    if (/^ARG\s/i.test(line) && stages === 0) throw unsupported("Dockerfile ARG before FROM is unsupported");
    if (/^FROM\s/i.test(line)) {
      const match = line.match(/^FROM(?:\s+--platform=\S+)?\s+(\S+?)(?:\s+AS\s+([A-Za-z0-9_.-]+))?$/i);
      if (!match) throw unsupported("Dockerfile FROM syntax is unsupported");
      const source = match[1] as string;
      if (source.toLowerCase() !== "scratch" && !aliases.has(source) && !/^\d+$/.test(source)) addPinnedBase(source, bases);
      if (match[2]) aliases.add((match[2] as string));
      stages += 1;
      continue;
    }
    if (/^(COPY|ADD)\s/i.test(line)) {
      const external = line.match(/(?:^|\s)--from=(\S+)/i)?.[1];
      if (external && !aliases.has(external) && !/^\d+$/.test(external)) addPinnedBase(external, bases);
    }
    if (/^RUN\s/i.test(line) && /--mount=[^\s]*\bfrom=/i.test(line)) throw unsupported("Dockerfile external RUN mounts are unsupported");
  }
  if (stages === 0) throw unsupported("Dockerfile has no FROM instruction");
  return [...bases.entries()].map(([reference, digest]) => ({ reference, digest })).sort((left, right) => Buffer.compare(Buffer.from(left.reference), Buffer.from(right.reference)));
}

function addPinnedBase(value: string, bases: Map<string, Sha256>): void {
  const match = value.match(PINNED_IMAGE);
  if (!match) throw unsupported(`Dockerfile base image is not digest-pinned: ${bounded(value)}`);
  const reference = match[1] as string;
  const digest = match[2] as Sha256;
  const previous = bases.get(reference);
  if (previous && previous !== digest) throw unsupported(`Dockerfile base image has conflicting digests: ${bounded(reference)}`);
  bases.set(reference, digest);
}

function unsupported(message: string): Error & { code: string } {
  return Object.assign(new TypeError(message), { code: "environment_build_context_unsupported" });
}

function bounded(value: string): string {
  return value.replace(/[\0\r\n]/g, " ").slice(0, 256);
}
