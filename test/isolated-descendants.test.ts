import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { executeRun, newRunId } from "../src/runs/index.js";

test("isolated completion stops double-forked sessions without signaling unrelated processes", {
  skip: process.platform !== "darwin", timeout: 20000,
}, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-detached-run-")));
  const candidate = path.join(root, "candidate"), output = path.join(root, "output");
  await mkdir(candidate); await mkdir(output);
  const pidPath = path.join(output, "descendant.pid"), writesPath = path.join(output, "writes");
  let descendant = 0;
  const state = async (pid: number) => (await promisify(execFile)("/bin/ps", ["-o", "stat=", "-p", String(pid)])
    .catch(() => ({ stdout: "" }))).stdout.trim();
  t.after(async () => {
    if (descendant && (await state(descendant)).match(/^[^Z]/)) {
      try { process.kill(descendant, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  const outsider = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const outsiderStopped = new Promise(resolve => outsider.once("close", resolve));
  t.after(async () => { outsider.kill("SIGKILL"); await outsiderStopped; });
  await new Promise<void>((resolve, reject) => { outsider.once("spawn", resolve); outsider.once("error", reject); });

  const executable = path.join(root, "codex"), source = executable + ".c";
  await writeFile(source, `#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("codex-cli 0.145.0"); return 0; }
  pid_t child = fork();
  if (child < 0) return 2;
  if (!child) {
    if (setsid() < 0) _exit(3);
    pid_t detached = fork();
    if (detached < 0) _exit(4);
    if (detached) _exit(0);
    freopen("/dev/null", "r", stdin); freopen("/dev/null", "w", stdout); freopen("/dev/null", "w", stderr);
    FILE *pid = fopen(${JSON.stringify(pidPath)}, "w");
    if (!pid) _exit(5);
    fprintf(pid, "%d", getpid()); fclose(pid);
    for (int i = 0; i < 200; i++) {
      FILE *out = fopen(${JSON.stringify(writesPath)}, "a");
      if (out) { fputs("still running\\n", out); fclose(out); }
      usleep(100000);
    }
    _exit(0);
  }
  for (int i = 0; i < 100 && access(${JSON.stringify(pidPath)}, F_OK); i++) usleep(10000);
  puts("{\\"type\\":\\"turn.completed\\",\\"usage\\":{\\"input_tokens\\":0,\\"output_tokens\\":0}}");
  return 0;
}
`);
  await promisify(execFile)("/usr/bin/cc", [source, "-o", executable]);
  const original = { HITCH_CODEX_PATH: process.env.HITCH_CODEX_PATH, CODEX_API_KEY: process.env.CODEX_API_KEY };
  process.env.HITCH_CODEX_PATH = executable;
  process.env.CODEX_API_KEY = "test-private-key";
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const result = await executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request: {
    harness_ref: "codex@installed", cwd: candidate, model: "test", prompt: "check", timeout_ms: 10000,
    workspace_mode: "shared", agent_args: [], generation_budget: { model_requests: 1, tokens: 1000 },
    isolation: { read_paths: [candidate, output], write_paths: [output], unix_sockets: [], allowed_domains: ["api.openai.com"] },
  } });
  descendant = Number(await readFile(pidPath, "utf8"));
  assert.ok(Number.isInteger(descendant) && descendant > 1);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.execution, { stopped: true });
  const before = await readFile(writesPath, "utf8").catch(() => "");
  await delay(300);
  assert.equal(await readFile(writesPath, "utf8").catch(() => ""), before, "descendant wrote after stop confirmation");
  assert.match(await state(descendant), /^(Z|$)/, "detached descendant remained alive");
  assert.equal(outsider.exitCode, null, "cleanup must not stop another run or host process");
  assert.equal(outsider.signalCode, null);
});
