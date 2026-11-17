import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

for (const cancellation of ["none", "signal", "parent-eof"] as const) {
  test(`isolated guard reclaims descendants and confirms on ${cancellation}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "hitch-guard-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "child.pid"), python = process.env.HITCH_GUARD_PYTHON || "python3";
    const guard = spawn(python, ["-I", "-B", "integrations/isolated-run/process-guard.py"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let ack = "", diagnostics = "";
    guard.stdio[3]!.on("data", chunk => { ack += chunk.toString(); });
    guard.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
    const finished = new Promise<number | null>((resolve, reject) => { guard.once("error", reject); guard.once("close", resolve); });
    const code = `import errno,os,subprocess,sys,time
try:
 os.write(3,b'forged');raise Exception('model inherited acknowledgment descriptor')
except OSError as error: assert error.errno==errno.EBADF
child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
open(sys.argv[1],'w').write(str(child.pid))
${cancellation === "none" ? "" : "time.sleep(60)"}
`;
    guard.stdin!.write(JSON.stringify({ argv: [python, "-I", "-B", "-c", code, marker], cwd: root, env: { PATH: process.env.PATH }, prompt: "", cleanupRoot: root, timeoutMs: 10000 }) + "\n");
    let descendant = 0;
    try {
      for (let index = 0; index < 100 && !descendant; index++) {
        descendant = Number(await readFile(marker, "utf8").catch(() => "0"));
        if (!descendant) await delay(30);
      }
      assert.ok(descendant > 0);
      if (cancellation === "signal") guard.kill("SIGTERM");
      if (cancellation === "parent-eof") guard.stdin!.end();
      const result = await finished;
      assert.equal(result, cancellation === "none" ? 0 : 137, diagnostics);
      if (cancellation === "parent-eof") assert.equal(ack, "");
      else assert.deepEqual(JSON.parse(ack), { version: 1, model_stopped: true, returncode: result });
      const live = (await promisify(execFile)("/bin/ps", ["-o", "stat=", "-p", String(descendant)]).catch(() => ({ stdout: "" }))).stdout.trim();
      assert.ok(!live || live.startsWith("Z"));
    } finally {
      guard.stdin!.destroy();
      if (guard.exitCode === null && guard.signalCode === null) guard.kill("SIGKILL");
    }
  });
}
