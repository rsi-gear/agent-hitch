import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

const SECRET_NAME = "HITCH_CANARY_SECRET";
const MAX_SCAN_FILE_BYTES = 256 * 1024 * 1024;
const docker = process.env.HITCH_DOCKER_PATH || "docker";
const base = process.env.HITCH_DOCKER_CANARY_BASE || "alpine:3.20";
const platform = process.env.HITCH_DOCKER_CANARY_PLATFORM || "linux/amd64";
const temporary = await mkdtemp(path.join(tmpdir(), "hitch-buildkit-secret-canary-"));
const context = path.join(temporary, "context");
const cacheOne = path.join(temporary, "cache-one");
const cacheTwo = path.join(temporary, "cache-two");
const imageTar = path.join(temporary, "image.tar");
const metadataOne = path.join(temporary, "metadata-one.json");
const metadataTwo = path.join(temporary, "metadata-two.json");
const tag = `hitch-buildkit-secret-canary:${randomBytes(8).toString("hex")}`;
const secretOne = `hitch-canary-a-${randomBytes(24).toString("hex")}`;
const secretTwo = `hitch-canary-b-${randomBytes(24).toString("hex")}`;
const cacheMode = selectedBuilderDriver() === "docker" ? "inline" : "local";
let baseContainer: string | undefined;

try {
  await writeFile(path.join(temporary, ".keep"), "");
  await mkdir(context);
  const baseInspect = run(["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", base]);
  const [baseIdentity, basePlatform] = baseInspect.stdout.trim().split(" ");
  if (!baseIdentity || !/^sha256:[a-f0-9]{64}$/.test(baseIdentity) || basePlatform !== platform) {
    throw new Error(`local canary base platform does not match ${platform}`);
  }
  baseContainer = run(["create", "--platform", platform, base]).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(baseContainer)) throw new Error("Docker returned an invalid temporary container id");
  run(["export", "--output", path.join(context, "rootfs.tar"), baseContainer]);
  run(["container", "rm", baseContainer]);
  baseContainer = undefined;
  await writeFile(path.join(context, "Dockerfile"), [
    "FROM scratch",
    "ADD rootfs.tar /",
    `RUN --mount=type=secret,id=${SECRET_NAME},required=true test \"$(wc -c < /run/secrets/${SECRET_NAME})\" -ge 32` + " \\",
    "    && printf 'secret-mounted-not-copied\\n' > /hitch-secret-proof",
    "",
  ].join("\n"));

  const first = build(secretOne, metadataOne, cacheOne);
  const firstIdentity = imageIdentity(tag);
  const second = build(secretTwo, metadataTwo, cacheTwo, cacheOne);
  const secondIdentity = imageIdentity(tag);
  if (firstIdentity !== secondIdentity) throw new Error("rotating the secret changed the image config digest");
  if (!/\bCACHED\b/.test(`${second.stdout}\n${second.stderr}`)) throw new Error("rotated-secret build did not reuse the exported cache");

  const proof = run(["run", "--rm", "--entrypoint", "/bin/sh", tag, "-c", "cat /hitch-secret-proof"]);
  if (proof.stdout.trim() !== "secret-mounted-not-copied") throw new Error("built image did not prove the secret mount was readable");
  run(["save", "--output", imageTar, tag]);

  const secrets = [Buffer.from(secretOne), Buffer.from(secretTwo)];
  assertTextDoesNotContain(first.stdout + first.stderr + second.stdout + second.stderr, secrets, "BuildKit output");
  await scanTree(temporary, secrets);

  const metadata = JSON.parse(await readFile(metadataTwo, "utf8")) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    docker: run(["version", "--format", "{{.Server.Version}}" ]).stdout.trim(),
    buildx: run(["buildx", "version"]).stdout.trim(),
    base,
    platform,
    image_config_digest: secondIdentity,
    manifest_digest: metadata["containerimage.digest"],
    cache_export: cacheMode === "local" ? "local-directory" : "inline-image-metadata",
    rotated_secret_cache_hit: true,
    scanned: cacheMode === "local"
      ? ["docker-save image tar", "first exported local cache", "rotated-secret exported local cache", "BuildKit logs and metadata"]
      : ["docker-save image tar including inline cache metadata", "BuildKit logs and metadata"],
  }, null, 2)}\n`);
} finally {
  if (baseContainer) spawnSync(docker, ["container", "rm", "--force", baseContainer], { encoding: "utf8" });
  spawnSync(docker, ["image", "rm", tag], { encoding: "utf8" });
  await rm(temporary, { recursive: true, force: true });
}

function build(secret: string, metadataFile: string, cacheTo: string, cacheFrom?: string): ReturnType<typeof run> {
  return run([
    "buildx", "build",
    "--progress", "plain",
    "--load",
    "--provenance=false",
    "--platform", platform,
    "--file", path.join(context, "Dockerfile"),
    "--tag", tag,
    "--metadata-file", metadataFile,
    "--secret", `id=${SECRET_NAME},env=${SECRET_NAME}`,
    ...(cacheMode === "local" && cacheFrom ? ["--cache-from", `type=local,src=${cacheFrom}`] : []),
    "--cache-to", cacheMode === "local" ? `type=local,dest=${cacheTo},mode=max` : "type=inline",
    context,
  ], { [SECRET_NAME]: secret });
}

function selectedBuilderDriver(): string {
  const inspected = run(["buildx", "inspect"]).stdout;
  const driver = inspected.match(/^Driver:\s+(\S+)$/m)?.[1];
  if (!driver) throw new Error("cannot determine the selected Buildx driver");
  return driver;
}

function imageIdentity(reference: string): string {
  const identity = run(["image", "inspect", "--format", "{{.Id}}", reference]).stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(identity)) throw new Error("Docker returned an invalid image config digest");
  return identity;
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string } {
  const result = spawnSync(docker, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.slice(0, 64 * 1024);
    if ((secretOne && output.includes(secretOne)) || (secretTwo && output.includes(secretTwo))) {
      throw new Error(`Docker command failed and exposed ${SECRET_NAME}`);
    }
    throw new Error(`Docker command failed (${args.slice(0, 2).join(" ")}): ${output}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function scanTree(root: string, secrets: Buffer[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await scanTree(target, secrets);
    else if (entry.isFile()) await scanFile(target, secrets);
  }
}

async function scanFile(file: string, secrets: Buffer[]): Promise<void> {
  const raw = await readFile(file);
  if (raw.byteLength > MAX_SCAN_FILE_BYTES) throw new Error(`canary evidence file is too large to scan safely: ${path.basename(file)}`);
  assertBufferDoesNotContain(raw, secrets, file);
  for (const decoded of decodedCandidates(raw)) assertBufferDoesNotContain(decoded, secrets, `${file} (decompressed)`);
}

function decodedCandidates(value: Buffer): Buffer[] {
  const candidates: Buffer[] = [];
  try {
    if (value[0] === 0x1f && value[1] === 0x8b) candidates.push(gunzipSync(value));
    else if (value[0] === 0x78) candidates.push(inflateSync(value));
    else if (value[0] === 0x28 && value[1] === 0xb5 && value[2] === 0x2f && value[3] === 0xfd) candidates.push(zstdDecompressSync(value));
  } catch { throw new Error("canary could not decompress exported cache evidence"); }
  return candidates;
}

function assertTextDoesNotContain(value: string, secrets: Buffer[], label: string): void {
  assertBufferDoesNotContain(Buffer.from(value), secrets, label);
}

function assertBufferDoesNotContain(value: Buffer, secrets: Buffer[], label: string): void {
  for (const secret of secrets) if (value.includes(secret)) throw new Error(`${SECRET_NAME} leaked into ${label}`);
}
