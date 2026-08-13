import { constants, createReadStream } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getAdapter, listDefinitions, publicDefinition } from "./adapters.js";

export async function discoverAgents({ env = process.env, probeVersions = true } = {}) {
  return Promise.all(listDefinitions().map((definition) => inspectDefinition(definition, { env, probeVersions })));
}

export async function inspectAgent(id, { env = process.env, probeVersions = true } = {}) {
  const definition = publicDefinition(getAdapter(id));
  return inspectDefinition(definition, { env, probeVersions });
}

async function inspectDefinition(definition, { env, probeVersions }) {
  const configured = env[definition.path_env]?.trim() || definition.command;
  const executable = await resolveExecutable(configured, env.PATH || "");
  if (!executable) return { ...definition, status: "unavailable" };

  const version = probeVersions
    ? await detectVersion(executable, getAdapter(definition.id).version_args)
    : "";
  const identity = await fingerprintExecutable(executable);
  return { ...definition, status: "available", executable, version, identity };
}

export async function resolveExecutable(command, searchPath) {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : searchPath.split(delimiter).filter(Boolean).map((directory) => join(directory, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const info = await lstat(candidate);
      if (info.isDirectory()) continue;
      return await realpath(candidate);
    } catch {
      // Keep probing PATH entries.
    }
  }
  return null;
}

export async function detectVersion(executable, args, timeoutMs = 5_000) {
  return new Promise((resolveVersion) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", () => {
      clearTimeout(timer);
      resolveVersion("");
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolveVersion(selectVersionLine(stdout, stderr));
    });
  });
}

export async function fingerprintExecutable(executable) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const digest = hash.digest("hex");
  return `sha256:${digest}`;
}

export function selectVersionLine(stdout, stderr) {
  const streams = [stdout, stderr];
  const versionPattern = /(?:^|\s)v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;
  for (const stream of streams) {
    const match = String(stream || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => versionPattern.test(line));
    if (match) return match;
  }
  return "";
}
