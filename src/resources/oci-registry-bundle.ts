import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { canonical, hash, natural, object, parseStrictJson, sha, type Resource } from "./protocol.js";
import { DEFAULT_IMAGE_IMPORT_BUDGET, validateOciLayer, type ImageImportBudget, type ImageImportUsage } from "./oci-layer-validation.js";

// Exact registry bytes, not a tar extraction or a reconstructed manifest.
// API: https://distribution.github.io/distribution/spec/api/
const MAGIC = Buffer.from("HITCH-OCI-REGISTRY-1\n"), MAX_HEADER = 4 * 1024 ** 2;
const ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const FETCH_ACCEPT = `${ACCEPT}, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json`;
type Image = Extract<Resource, { kind: "oci-image" }>;
type Descriptor = { digest: `sha256:${string}`; size: number };
type Budget = { maxBytes: number; minFreeBytes: number };
export interface OfflineImageOptions { exportFormat?: "docker-archive" | "registry-bundle"; registry?: string }
export function registryLocation(reference: string) {
  const [name, digest] = reference.split("@"); sha(digest);
  const components = name!.split("/"), explicit = /[.:]/.test(components[0]!) || components[0] === "localhost";
  const host = explicit ? components.shift()! : "registry-1.docker.io";
  if (components.length === 1 && !explicit) components.unshift("library");
  const repository = components.join("/");
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) throw new Error("invalid registry repository");
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return { origin: `${local ? "http" : "https"}://${host === "docker.io" ? "registry-1.docker.io" : host}`, repository, digest: digest! };
}
export function localRegistry(value: string): URL {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("offline registry must be an explicitly configured loopback origin");
  return url;
}
async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`OCI registry request failed: HTTP ${response.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > maximum) throw new Error("OCI response byte budget exceeded"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function descriptors(manifest: string, image: Image): { blobs: Descriptor[]; layers: Array<Descriptor & { mediaType: string }>; mediaType: string; config: Descriptor } {
  if (hash(manifest) !== image.manifestDigest) throw new Error("offline OCI manifest digest mismatch");
  const m = parseStrictJson(manifest) as Record<string, unknown>;
  if (m.schemaVersion !== 2 || !Array.isArray(m.layers) || !ACCEPT.split(", ").includes(String(m.mediaType))) throw new Error("offline registry format requires a platform image manifest, not an index");
  const parse = (v: unknown): Descriptor => { const d = v as Record<string, unknown>; if (!d || typeof d !== "object" || d.urls !== undefined) throw new Error("foreign OCI blobs are unsupported"); return { digest: sha(d.digest), size: natural(d.size) }; };
  const layers = m.layers.map(v => ({ ...parse(v), mediaType: String((v as Record<string, unknown>).mediaType) }));
  const config = parse(m.config), entries = [config, ...layers], unique = new Map<string, Descriptor>();
  for (const e of entries) { if (unique.has(e.digest) && unique.get(e.digest)!.size !== e.size) throw new Error("conflicting OCI descriptor sizes"); unique.set(e.digest, e); }
  return { blobs: [...unique.values()].map(({ digest, size }) => ({ digest, size })).sort((a, b) => a.digest.localeCompare(b.digest)), layers, mediaType: String(m.mediaType), config };
}
async function registryReader(reference: string, signal: AbortSignal) {
  const location = registryLocation(reference); let token: string | undefined;
  return async (suffix: string, accept?: string) => {
    const url = `${location.origin}/v2/${location.repository}/${suffix}`;
    const request = () => fetch(url, { signal, headers: { ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    let response = await request();
    if (response.status === 401 && !token) {
      const challenge = response.headers.get("www-authenticate") ?? ""; await response.body?.cancel();
      const realm = challenge.match(/realm="([^"]+)"/)?.[1], service = challenge.match(/service="([^"]+)"/)?.[1];
      if (!challenge.startsWith("Bearer ") || !realm) throw new Error("registry bundle export supports anonymous bearer authentication only");
      const auth = new URL(realm); if (auth.protocol !== "https:" || auth.username || auth.password) throw new Error("unsafe registry authentication endpoint");
      if (service) auth.searchParams.set("service", service); auth.searchParams.set("scope", `repository:${location.repository}:pull`);
      const value = parseStrictJson((await boundedBody(await fetch(auth, { signal }), 64 * 1024)).toString()) as Record<string, unknown>;
      token = typeof value.token === "string" ? value.token : typeof value.access_token === "string" ? value.access_token : undefined;
      if (!token) throw new Error("registry authentication unavailable"); response = await request();
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OCI registry request failed: HTTP ${response.status}`); } return response;
  };
}
export async function fetchRegistryManifest(image: Image, reference: string, signal?: AbortSignal): Promise<string> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const get = await registryReader(reference, bounded), manifest = (await boundedBody(await get(`manifests/${image.manifestDigest}`, FETCH_ACCEPT), MAX_HEADER)).toString();
  descriptors(manifest, image); return manifest;
}
export function verifyRegistryManifest(manifest: string, image: Image, configDigest: string): void {
  if (descriptors(manifest, image).config.digest !== configDigest) throw new Error("OCI manifest config differs from actual Docker image");
}
export async function exportRegistryBundle(image: Image, reference: string, file: string, budget: Budget, signal?: AbortSignal): Promise<void> {
  const bounded = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
  const get = await registryReader(reference, bounded), manifest = (await boundedBody(await get(`manifests/${image.manifestDigest}`, FETCH_ACCEPT), MAX_HEADER)).toString();
  const { blobs } = descriptors(manifest, image), header = Buffer.from(JSON.stringify({ protocol: "hitch-oci-registry-bundle@1", manifest, blobs })), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const total = MAGIC.length + 4 + header.length + blobs.reduce((n, b) => n + b.size, 0);
  if (header.length > MAX_HEADER || total > budget.maxBytes) throw new Error("offline OCI archive budget exceeded");
  const space = await statfs(path.dirname(file), { bigint: true }); if (space.bavail * space.bsize < BigInt(total + budget.minFreeBytes)) throw new Error("offline OCI free-space reserve exceeded");
  const output = await open(file, "wx", 0o600);
  try {
    await output.writeFile(Buffer.concat([MAGIC, length, header]));
    for (const blob of blobs) {
      let size = 0; const digest = createHash("sha256"), response = await get(`blobs/${blob.digest}`);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bounded.throwIfAborted(); size += chunk.length; if (size > blob.size) throw new Error("OCI blob exceeds its manifest size"); digest.update(chunk); await output.writeFile(chunk);
      }
      if (size !== blob.size || `sha256:${digest.digest("hex")}` !== blob.digest) throw new Error("OCI blob integrity mismatch");
    }
    await output.sync();
  } catch (error) { await rm(file, { force: true }); throw error; } finally { await output.close(); }
}
export async function isRegistryBundle(file: string): Promise<boolean> {
  const handle = await open(file, "r"); try { const buffer = Buffer.alloc(MAGIC.length); await handle.read(buffer, 0, buffer.length, 0); return buffer.equals(MAGIC); } finally { await handle.close(); }
}
/** Validates digests, expanded bytes, entry counts and tar paths without extraction. */
export async function validateRegistryBundle(image: Image, file: string, signal?: AbortSignal, budget: ImageImportBudget = DEFAULT_IMAGE_IMPORT_BUDGET) {
  natural(budget.maxExpandedBytes); natural(budget.maxFiles);
  const bounded = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]), handle = await open(file, "r");
  let manifest: string, blobs: Descriptor[], layers: Array<Descriptor & { mediaType: string }>, mediaType: string, config: Descriptor, offset: number;
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4); await handle.read(prefix, 0, prefix.length, 0);
    const length = prefix.readUInt32BE(MAGIC.length); if (!prefix.subarray(0, MAGIC.length).equals(MAGIC) || length > MAX_HEADER) throw new Error("invalid OCI bundle header");
    const header = Buffer.alloc(length); if ((await handle.read(header, 0, length, prefix.length)).bytesRead !== length) throw new Error("truncated OCI header");
    const raw = object(parseStrictJson(header.toString()), ["protocol", "manifest", "blobs"]);
    if (raw.protocol !== "hitch-oci-registry-bundle@1" || typeof raw.manifest !== "string") throw new Error("invalid OCI bundle protocol");
    manifest = raw.manifest; ({ blobs, layers, mediaType, config } = descriptors(manifest, image));
    if (canonical(raw.blobs) !== canonical(blobs)) throw new Error("OCI bundle inventory mismatch");
    offset = prefix.length + length;
    if ((await handle.stat()).size !== offset + blobs.reduce((n, b) => n + b.size, 0)) throw new Error("OCI bundle size mismatch");
  } finally { await handle.close(); }
  let position = offset!; const positions = new Map<string, number>(); let diffIds: string[] = [];
  for (const blob of blobs!) {
    positions.set(blob.digest, position);
    const digest = createHash("sha256"), chunks: Buffer[] = [];
    if (blob.size) for await (const chunk of createReadStream(file, { start: position, end: position + blob.size - 1 })) { bounded.throwIfAborted(); digest.update(chunk); if (blob.digest === config!.digest) { if (blob.size > MAX_HEADER) throw new Error("OCI config size budget exceeded"); chunks.push(chunk); } }
    if (`sha256:${digest.digest("hex")}` !== blob.digest) throw new Error("offline OCI blob digest mismatch");
    if (blob.digest === config!.digest) {
      const c = parseStrictJson(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (`${c.os}/${c.architecture}${c.variant ? `/${c.variant}` : ""}` !== image.platform) throw new Error("offline OCI config platform mismatch");
      const rootfs = c.rootfs as Record<string, unknown> | undefined;
      if (!rootfs || rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids) || rootfs.diff_ids.length !== layers!.length) throw new Error("offline OCI config layer inventory mismatch");
      diffIds = rootfs.diff_ids.map(sha);
    }
    position += blob.size;
  }
  const usage: ImageImportUsage = { expandedBytes: 0, files: 0 };
  for (const [i, layer] of layers!.entries()) {
    const observed = await validateOciLayer(file, positions.get(layer.digest)!, layer.size, layer.mediaType, { maxExpandedBytes: budget.maxExpandedBytes - usage.expandedBytes, maxFiles: budget.maxFiles - usage.files }, bounded);
    if (observed.diffId !== diffIds[i]) throw new Error("offline OCI uncompressed layer digest mismatch");
    usage.expandedBytes += observed.expandedBytes; usage.files += observed.files;
  }
  return { manifest: manifest!, blobs: blobs!, mediaType: mediaType!, offset: offset!, usage };
}
/** Validates every layer before any local registry or Docker mutation. */
export async function importRegistryBundle(image: Image, file: string, reference: string, registry: string, signal?: AbortSignal, budget: ImageImportBudget = DEFAULT_IMAGE_IMPORT_BUDGET): Promise<string> {
  const origin = localRegistry(registry), location = registryLocation(reference);
  if (new URL(location.origin).host !== origin.host) throw new Error("offline image transport must name the configured local registry");
  const bounded = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
  const { manifest, blobs, mediaType, offset } = await validateRegistryBundle(image, file, bounded, budget);
  let position = offset;
  const api = `${origin.origin}/v2/${location.repository}`;
  for (const blob of blobs!) {
    const head = await fetch(`${api}/blobs/${blob.digest}`, { method: "HEAD", signal: bounded, redirect: "error" });
    if (head.status !== 200) {
      if (head.status !== 404) throw new Error(`offline registry probe failed: ${head.status}`);
      const start = await fetch(`${api}/blobs/uploads/`, { method: "POST", signal: bounded, redirect: "error" }); await start.body?.cancel();
      const upload = new URL(start.headers.get("location") ?? "", api);
      if (start.status !== 202 || upload.origin !== origin.origin || !upload.pathname.startsWith(`/v2/${location.repository}/blobs/uploads/`)) throw new Error("unsafe local registry upload location");
      upload.searchParams.set("digest", blob.digest);
      const response = await fetch(upload, { method: "PUT", signal: bounded, redirect: "error", headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) }, body: blob.size ? createReadStream(file, { start: position, end: position + blob.size - 1 }) : Buffer.alloc(0), duplex: "half" } as RequestInit);
      await response.body?.cancel(); if (response.status !== 201) throw new Error(`offline registry blob upload failed: ${response.status}`);
    }
    position += blob.size;
  }
  const result = await fetch(`${api}/manifests/${image.manifestDigest}`, { method: "PUT", signal: bounded, redirect: "error", headers: { "content-type": mediaType! }, body: manifest! });
  await result.body?.cancel(); if (result.status !== 201) throw new Error(`offline registry manifest publication failed: ${result.status}`);
  return manifest!;
}
