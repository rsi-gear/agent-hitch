import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withBridgePythonPath } from "../src/backends/harbor/bridge-environment.js";
import { ensureControllerRuntime, useControllerRuntimeById } from "../src/controller-runtime/index.js";
import { statePaths } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("Harbor bridge environment prevents bytecode writes without mutating its parent", () => {
  const parent = { PYTHONPATH: "parent-python-path", PYTHONDONTWRITEBYTECODE: "", KEEP_ME: "yes" };
  const result = withBridgePythonPath(parent, path.join("runtime", "root"));
  assert.deepEqual(result, {
    ...parent,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: [path.join("runtime", "root", "payload", "integrations", "harbor"), parent.PYTHONPATH].join(path.delimiter),
  });
  assert.deepEqual(parent, { PYTHONPATH: "parent-python-path", PYTHONDONTWRITEBYTECODE: "", KEEP_ME: "yes" });
});

test("Python imports cannot invalidate a guarded controller runtime", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-runtime-bytecode-"));
  t.after(() => forceRemove(root));

  const unguarded = await createPythonRuntime(path.join(root, "unguarded"));
  await chmod(unguarded.bridgeDirectory, 0o755);
  const unguardedEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: unguarded.bridgeDirectory };
  delete unguardedEnv.PYTHONDONTWRITEBYTECODE;
  delete unguardedEnv.PYTHONPYCACHEPREFIX;
  importBridge(unguardedEnv);
  assert.ok((await readdir(unguarded.bridgeDirectory)).includes("__pycache__"));
  await assert.rejects(
    useControllerRuntimeById(statePaths(unguarded.root), unguarded.runtimeId),
    (error: unknown) => (error as { code?: string }).code === "controller_runtime_integrity_mismatch",
  );

  const guarded = await createPythonRuntime(path.join(root, "guarded"));
  await chmod(guarded.bridgeDirectory, 0o755);
  const parentEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: "parent-python-path", PYTHONDONTWRITEBYTECODE: "" };
  delete parentEnv.PYTHONPYCACHEPREFIX;
  const guardedEnv = withBridgePythonPath(parentEnv, guarded.runtimeDirectory);
  importBridge(guardedEnv);
  assert.equal((await readdir(guarded.bridgeDirectory)).includes("__pycache__"), false);
  assert.equal((await useControllerRuntimeById(statePaths(guarded.root), guarded.runtimeId)).runtime_id, `sha256:${guarded.runtimeId}`);
  assert.equal(parentEnv.PYTHONDONTWRITEBYTECODE, "");
  assert.equal(parentEnv.PYTHONPATH, "parent-python-path");
});

async function createPythonRuntime(root: string): Promise<{
  root: string;
  runtimeDirectory: string;
  runtimeId: string;
  bridgeDirectory: string;
}> {
  const payload = path.join(root, "payload-source");
  await mkdir(path.join(payload, "dist", "bin"), { recursive: true });
  await mkdir(path.join(payload, "integrations", "harbor"), { recursive: true });
  await writeFile(path.join(payload, "package.json"), "{}\n");
  await writeFile(path.join(payload, "dist", "bin", "hitch.js"), "#!/usr/bin/env node\n");
  await writeFile(path.join(payload, "integrations", "harbor", "hitch_harbor_agent.py"), "IMPORTED = True\n");
  const runtime = await ensureControllerRuntime({
    root,
    payloadRoot: payload,
    rules: [
      { path: "package.json" },
      { path: "dist/bin/hitch.js", executable: true },
      { path: "integrations/harbor/hitch_harbor_agent.py" },
    ],
  });
  return {
    root,
    runtimeDirectory: runtime.directory,
    runtimeId: runtime.runtime_id.slice("sha256:".length),
    bridgeDirectory: path.join(runtime.directory, "payload", "integrations", "harbor"),
  };
}

function importBridge(env: NodeJS.ProcessEnv): void {
  // Disable host-level cache redirection so both branches exercise writes next
  // to the imported runtime module, including on Apple's system Python.
  const python = process.env.HITCH_TEST_PYTHON_PATH || "python3";
  const result = spawnSync(python, ["-X", "pycache_prefix=", "-c", "import hitch_harbor_agent"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
