import { gzipSync } from "node:zlib";
import { hash } from "../src/resources/protocol.js";
export function tarEntry(name: string, content: Buffer = Buffer.alloc(0), type = "0", link = "", size = content.length): Buffer {
  const header = Buffer.alloc(512);
  const field = (value: string, start: number, length: number) => header.write(value, start, length, "utf8");
  field(name, 0, 100); field("0000644\0", 100, 8); field("0000000\0", 108, 8); field("0000000\0", 116, 8);
  field(size.toString(8).padStart(11, "0") + "\0", 124, 12); field("00000000000\0", 136, 12);
  header.fill(32, 148, 156); field(type, 156, 1); field(link, 157, 100); field("ustar\0", 257, 6); field("00", 263, 2);
  field(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
export const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
export function pax(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`; let length = Buffer.byteLength(body) + 1;
  while (length !== Buffer.byteLength(String(length) + body)) length = Buffer.byteLength(String(length) + body);
  return Buffer.from(String(length) + body);
}
export function ociBundle(tars: Buffer[], types = tars.map(() => "application/vnd.oci.image.layer.v1.tar+gzip"), diffIds = tars.map(hash)) {
  const layers = tars.map((bytes, i) => types[i]!.endsWith("gzip") ? gzipSync(bytes) : bytes);
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: diffIds } }));
  const blobs = new Map([[hash(config), config], ...layers.map(b => [hash(b), b] as const)]);
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: hash(config), size: config.length }, layers: layers.map((b, i) => ({ digest: hash(b), size: b.length, mediaType: types[i] })) });
  const inventory = [...blobs].map(([digest, b]) => ({ digest, size: b.length })).sort((a, b) => a.digest.localeCompare(b.digest));
  const header = Buffer.from(JSON.stringify({ protocol: "hitch-oci-registry-bundle@1", manifest, blobs: inventory }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return { manifest, config, blobs, image: { kind: "oci-image" as const, manifestDigest: hash(manifest), platform: "linux/amd64" }, bytes: Buffer.concat([Buffer.from("HITCH-OCI-REGISTRY-1\n"), length, header, ...inventory.map(b => blobs.get(b.digest)!)]) };
}
