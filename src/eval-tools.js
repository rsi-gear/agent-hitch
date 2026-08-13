import { constants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SCHEMA_VERSION, statePaths } from "./config.js";
import { HitchError, invalidInput } from "./errors.js";
import { atomicWriteJSON, ensureDir, readJSON } from "./fs.js";
import { terminateProcess } from "./process.js";
import { detectVersion, resolveExecutable } from "./registry.js";

export const DEFAULT_HARBOR_VERSION = "0.21.0";
export const HARBOR_CREDENTIAL_ENV = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_VERSION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];
const PROVIDER_CREDENTIAL_ENV = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
];

export async function setupHarbor({
  root,
  version = DEFAULT_HARBOR_VERSION,
  python,
  force = false,
  env = process.env,
  onProgress = () => {},
} = {}) {
  if (!root) throw invalidInput("a Hitch state root is required for Harbor setup");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw invalidInput("Harbor version must be an exact semantic version");
  }
  const pythonInfo = await findPython({ explicit: python, env });
  if (!pythonInfo.executable) {
    throw new HitchError("Python 3.12 or newer was not found; install it or pass --python <path>", {
      code: "python_unavailable",
      exitCode: 3,
    });
  }
  if (!pythonInfo.supported) {
    throw new HitchError(`Harbor requires Python 3.12 or newer; found ${pythonInfo.version || "an unknown version"}`, {
      code: "python_unsupported",
      exitCode: 3,
    });
  }

  const toolsDirectory = statePaths(root).tools;
  const installDirectory = path.join(toolsDirectory, `harbor-${version}`);
  const harborExecutable = venvExecutable(installDirectory, "harbor");
  const currentPath = path.join(toolsDirectory, "harbor.json");
  const installedVersion = await installedHarborVersion(harborExecutable);
  if (installedVersion === version && !force) {
    const manifest = await writeHarborSelection(currentPath, {
      version,
      pythonInfo,
      installDirectory,
      harborExecutable,
      cacheHit: true,
    });
    return manifest;
  }
  if (installedVersion && !force) {
    throw new HitchError(`managed Harbor at ${installDirectory} reports ${installedVersion}; rerun with --force to replace it`, {
      code: "harbor_setup_conflict",
      exitCode: 3,
    });
  }

  await ensureDir(toolsDirectory);
  if (force) await rm(installDirectory, { recursive: true, force: true });
  try {
    await mkdir(installDirectory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new HitchError(`incomplete Harbor installation already exists at ${installDirectory}; rerun with --force`, {
        code: "harbor_setup_incomplete",
        exitCode: 3,
      });
    }
    throw error;
  }

  try {
    onProgress(`Creating an isolated Python environment with ${pythonInfo.version}`);
    await requireCommand(pythonInfo.executable, ["-m", "venv", installDirectory], {
      env,
      code: "harbor_setup_failed",
      timeoutMs: 5 * 60_000,
    });
    const environmentPython = venvExecutable(installDirectory, "python");
    onProgress(`Installing harbor==${version}`);
    await requireCommand(environmentPython, [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-input", `harbor==${version}`,
    ], {
      env,
      code: "harbor_setup_failed",
      timeoutMs: 20 * 60_000,
    });
    const observedVersion = await installedHarborVersion(harborExecutable);
    if (observedVersion !== version) {
      throw new HitchError(`installed Harbor reported ${observedVersion || "no version"}; expected ${version}`, {
        code: "harbor_setup_failed",
        exitCode: 13,
      });
    }
    return await writeHarborSelection(currentPath, {
      version,
      pythonInfo,
      installDirectory,
      harborExecutable,
      cacheHit: false,
    });
  } catch (error) {
    await rm(installDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function doctorHarbor({ root, python, harbor, docker, env = process.env } = {}) {
  if (!root) throw invalidInput("a Hitch state root is required for eval doctor");
  const pythonInfo = await findPython({ explicit: python, env });
  const harborInfo = await locateHarbor({ root, explicit: harbor, env });
  const dockerConfigured = docker || env.HITCH_DOCKER_PATH || "docker";
  const dockerExecutable = await resolveExecutable(dockerConfigured, env.PATH || "");

  let dockerVersion = "";
  let dockerDiagnostic = "";
  if (dockerExecutable) {
    const result = await captureCommand(dockerExecutable, ["version", "--format", "{{.Server.Version}}"], {
      env,
      timeoutMs: 10_000,
    });
    dockerVersion = result.code === 0 ? result.stdout.trim() : "";
    dockerDiagnostic = result.code === 0 ? "" : (result.stderr.trim() || result.stdout.trim() || "Docker daemon is unavailable");
  }

  const credentials = PROVIDER_CREDENTIAL_ENV.filter((name) => typeof env[name] === "string" && env[name].trim());
  const checks = {
    python: pythonInfo.executable && pythonInfo.supported
      ? { status: "ok", executable: pythonInfo.executable, version: pythonInfo.version, required: ">=3.12" }
      : { status: "error", executable: pythonInfo.executable || null, version: pythonInfo.version || null, required: ">=3.12", message: "Python 3.12 or newer is required to install Harbor" },
    harbor: harborInfo.executable
      ? { status: "ok", executable: harborInfo.executable, version: harborInfo.version || null, source: harborInfo.source }
      : { status: "error", executable: null, version: null, source: harborInfo.source, message: `Harbor executable not found: ${harborInfo.requested}` },
    docker: dockerExecutable && dockerVersion
      ? { status: "ok", executable: dockerExecutable, version: dockerVersion, daemon: "running" }
      : { status: "error", executable: dockerExecutable || null, version: null, daemon: dockerExecutable ? "unavailable" : "not_checked", message: dockerExecutable ? dockerDiagnostic : `Docker executable not found: ${dockerConfigured}` },
    credentials: credentials.length > 0
      ? { status: "ok", present: credentials }
      : { status: "warning", present: [], message: "No common provider credential is set; pass credentials before running a hosted-model eval" },
  };
  const ready = [checks.python, checks.harbor, checks.docker].every((check) => check.status === "ok");
  return {
    schema_version: SCHEMA_VERSION,
    backend: "harbor",
    status: ready ? (checks.credentials.status === "ok" ? "ready" : "ready_with_warnings") : "action_required",
    ready,
    checks,
  };
}

export async function locateHarbor({ root, explicit, env = process.env } = {}) {
  const configured = explicit || env.HITCH_HARBOR_PATH;
  if (configured) {
    const executable = await resolveExecutable(configured, env.PATH || "");
    return {
      executable,
      version: executable ? await installedHarborVersion(executable) : "",
      source: explicit ? "option" : "environment",
      requested: configured,
    };
  }
  const managed = root ? await managedHarborExecutable(root) : null;
  if (managed) {
    return {
      executable: managed,
      version: await installedHarborVersion(managed),
      source: "managed",
      requested: managed,
    };
  }
  const executable = await resolveExecutable("harbor", env.PATH || "");
  return {
    executable,
    version: executable ? await installedHarborVersion(executable) : "",
    source: "path",
    requested: "harbor",
  };
}

export async function managedHarborExecutable(root) {
  const toolsDirectory = statePaths(root).tools;
  const current = await readJSON(path.join(toolsDirectory, "harbor.json"), null).catch(() => null);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(current?.version || "")) return null;
  const executable = venvExecutable(path.join(toolsDirectory, `harbor-${current.version}`), "harbor");
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    return null;
  }
}

async function findPython({ explicit, env }) {
  const requested = explicit || env.HITCH_PYTHON_PATH;
  const candidates = requested ? [requested] : ["python3.13", "python3.12", "python3"];
  let firstFound = null;
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate, env.PATH || "");
    if (!executable) continue;
    const result = await captureCommand(executable, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
      env,
      timeoutMs: 5_000,
    });
    const version = result.code === 0 ? result.stdout.trim().split(/\s+/)[0] : "";
    const supported = pythonVersionSupported(version);
    const info = { executable, version, supported };
    firstFound ||= info;
    if (supported || requested) return info;
  }
  return firstFound || { executable: null, version: "", supported: false };
}

function pythonVersionSupported(version) {
  const match = String(version).match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 12);
}

async function installedHarborVersion(executable) {
  try {
    await access(executable, constants.X_OK);
  } catch {
    return "";
  }
  const value = await detectVersion(executable, ["--version"]);
  return value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] || "";
}

async function writeHarborSelection(currentPath, {
  version,
  pythonInfo,
  installDirectory,
  harborExecutable,
  cacheHit,
}) {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    tool: "harbor",
    version,
    executable: harborExecutable,
    install_directory: installDirectory,
    python: { executable: pythonInfo.executable, version: pythonInfo.version },
    cache_hit: cacheHit,
    selected_at: new Date().toISOString(),
  };
  await atomicWriteJSON(currentPath, manifest);
  return manifest;
}

function venvExecutable(directory, name) {
  return process.platform === "win32"
    ? path.join(directory, "Scripts", `${name}.exe`)
    : path.join(directory, "bin", name);
}

async function requireCommand(executable, args, { env, code, timeoutMs }) {
  const result = await captureCommand(executable, args, { env, timeoutMs });
  if (result.code === 0) return result;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new HitchError(`${path.basename(executable)} exited with code ${result.code ?? "null"}${detail ? `: ${detail}` : ""}`, {
    code,
    exitCode: 13,
  });
}

function captureCommand(executable, args, { env = process.env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child).catch(() => {});
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timed_out: timedOut });
    });
  });
}
