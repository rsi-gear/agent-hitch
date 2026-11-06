import path from "node:path";
import { readFile } from "node:fs/promises";
import { HitchError, invalidInput, packageRoot, runCommand } from "../../foundation/index.js";
import { DEFAULT_EVALUATION_BINDING_TIMEOUT_MS, MAX_EVALUATION_BINDING_TIMEOUT_MS } from "../../domain/index.js";
import { locateHarborLauncher } from "./tools.js";

export interface HarborPythonRuntimeV1 {
  schema_version: "1";
  integrity: string;
  python_version: string;
  file_count: number;
}

const TIMEOUT_ENV = "HITCH_HARBOR_PYTHON_RUNTIME_TIMEOUT_MS";
// Private to this executor process. Never load a verdict from mutable disk or
// reuse a runtime observation: the probe rehashes the full input on every call.
const verifiedBytecode = new Set<string>();

function inventoryTimeout(env: NodeJS.ProcessEnv): number {
  const value = env[TIMEOUT_ENV];
  if (value === undefined) return DEFAULT_EVALUATION_BINDING_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_EVALUATION_BINDING_TIMEOUT_MS) {
    throw invalidInput(`${TIMEOUT_ENV} must be a positive integer no greater than ${MAX_EVALUATION_BINDING_TIMEOUT_MS}`);
  }
  return Number(value);
}

/** Inspect the actual launcher interpreter, preserving its virtualenv symlink. */
export async function observeHarborPythonRuntime(input: {
  root: string; env: NodeJS.ProcessEnv; harborExecutable?: string; signal?: AbortSignal;
}): Promise<HarborPythonRuntimeV1> {
  const timeoutMs = inventoryTimeout(input.env);
  const deadline = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref();
  try {
    signal.throwIfAborted();
    if (input.env.PYTHONPATH
      && input.env.PYTHONPATH.split(path.delimiter).some(value => !path.isAbsolute(value))) throw unavailable();
    const harbor = await locateHarborLauncher({ root: input.root, env: input.env, explicit: input.harborExecutable });
    signal.throwIfAborted();
    if (!harbor.executable) throw unavailable();
    const firstLine = (await readFile(harbor.executable, { encoding: "utf8", signal })).split(/\r?\n/, 1)[0] ?? "";
    const python = firstLine.match(/^#!(\/[^\s]+)$/)?.[1];
    if (!python || !/^python(?:[0-9.]+)?$/.test(path.basename(python))) throw unavailable();
    const probe = path.join(packageRoot(), "integrations", "harbor", "hitch_python_runtime.py");
    const result = await runCommand(python, ["-B", probe, harbor.executable, "--memo", ...verifiedBytecode], {
      env: { ...input.env, PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs, signal,
    });
    const receipt: unknown = JSON.parse(result.stdout);
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw unavailable();
    const envelope = receipt as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(",") !== "proof,runtime"
      || typeof envelope.proof !== "string" || !/^[a-f0-9]{64}$/.test(envelope.proof)) throw unavailable();
    const value = envelope.runtime;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).sort().join(",") !== "file_count,integrity,python_version,schema_version"
      || object.schema_version !== "1" || typeof object.integrity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(object.integrity)
      || typeof object.python_version !== "string" || !/^3\.\d+\.\d+$/.test(object.python_version)
      || !Number.isSafeInteger(object.file_count) || (object.file_count as number) < 1) throw unavailable();
    signal.throwIfAborted();
    verifiedBytecode.delete(envelope.proof);
    verifiedBytecode.add(envelope.proof);
    if (verifiedBytecode.size > 8) verifiedBytecode.delete(verifiedBytecode.values().next().value!);
    return value as HarborPythonRuntimeV1;
  } catch {
    if (input.signal?.aborted) {
      throw new HitchError("Harbor Python runtime verification cancelled", { code: "cancelled", exitCode: 9 });
    }
    if (deadline.signal.aborted) {
      throw new HitchError(`Harbor Python runtime verification timed out; adjust ${TIMEOUT_ENV} on the daemon`, {
        code: "harbor_python_runtime_timeout", exitCode: 12,
      });
    }
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
}

function unavailable() {
  return new HitchError("Harbor Python runtime cannot be verified; use a Python launcher with absolute module paths and unchanged package files", {
    code: "harbor_python_runtime_unavailable", exitCode: 12,
  });
}
