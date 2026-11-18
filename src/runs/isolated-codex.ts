import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { ProcessSpecification } from "../adapters/index.js";
import { HitchError } from "../foundation/index.js";

const npmTargets: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/** Run npm Codex's native entrypoint without giving its JavaScript launcher or
 * Node installation access inside the model sandbox. Installed launchers are
 * direct executables; prepared npm artifacts carry a Node + entrypoint prefix.
 */
export async function isolatedCodexInvocation(specification: ProcessSpecification): Promise<{ executable: string; args: string[] }> {
  const executable = await realpath(specification.executable);
  const direct = await npmCodexBinary(executable);
  if (direct) return { executable: direct, args: [...specification.args] };
  const entrypoint = specification.args[0];
  if (entrypoint && path.isAbsolute(entrypoint) && executable === await realpath(process.execPath)) {
    const native = await npmCodexBinary(await realpath(entrypoint));
    if (native) return { executable: native, args: specification.args.slice(1) };
  }
  return { executable, args: [...specification.args] };
}

async function npmCodexBinary(entrypoint: string): Promise<string | undefined> {
  const packageRoot = path.resolve(path.dirname(entrypoint), "..");
  let manifest: { name?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (manifest?.name !== "@openai/codex") return undefined;
  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin
    : bin && typeof bin === "object" ? (bin as Record<string, unknown>).codex : undefined;
  if (typeof relative !== "string" || path.resolve(packageRoot, relative) !== entrypoint) return undefined;

  const platform = `${process.platform}-${process.arch}`, target = npmTargets[platform];
  if (!target) throw nativeUnavailable();
  const roots: string[] = [];
  try {
    const dependency = createRequire(entrypoint).resolve(`@openai/codex-${platform}/package.json`);
    roots.push(path.join(path.dirname(dependency), "vendor"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  roots.push(path.join(packageRoot, "vendor"));
  const filename = process.platform === "win32" ? "codex.exe" : "codex";
  for (const root of roots) for (const layout of ["bin", "codex"]) {
    const candidate = path.join(root, target, layout, filename);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw nativeUnavailable();
}

function nativeUnavailable(): HitchError {
  return new HitchError("Codex npm installation has no supported native binary; repair it or configure a native Codex executable", {
    code: "codex_native_unavailable", exitCode: 5,
  });
}
