import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

function containedRequest(request: Record<string, unknown>) {
  if (process.platform !== "darwin") return request;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const profile = '(version 1)(deny default)(allow process-exec)(allow process-fork)' +
    '(allow file-read*)(allow file-write* (literal "/dev/null"))(allow sysctl-read)' +
    '(allow process-info* (target same-sandbox))' +
    '(allow signal (target same-sandbox))(allow mach-priv-task-port (target same-sandbox))' +
    `(allow file-write* (subpath ${JSON.stringify(request.cwd)}))`;
  return { ...request, darwinSandbox: true, argv: ["/bin/bash", "-c", [
    "env", "/usr/bin/sandbox-exec", "-p", profile, ...(request.argv as string[]),
  ].map(quote).join(" ")] };
}

for (const detached of [false, true]) for (const cancellation of ["none", "signal", "parent-eof", "timeout"] as const) {
  test(`isolated guard reclaims ${detached ? "double-forked session" : "group"} descendants on ${cancellation}`, {
    skip: process.platform === "win32" || (detached && process.platform !== "darwin"),
  }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-guard-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "child.pid"), python = process.env.HITCH_GUARD_PYTHON || "python3";
    const keepalive = marker + ".alive";
    await writeFile(keepalive, "");
    const guard = spawn(python, ["-I", "-B", "integrations/isolated-run/process-guard.py"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let ack = "", diagnostics = "";
    guard.stdio[3]!.on("data", chunk => { ack += chunk.toString(); });
    guard.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
    const finished = new Promise<number | null>((resolve, reject) => { guard.once("error", reject); guard.once("close", resolve); });
    const code = `import errno,os,subprocess,sys,time
try:
 os.write(3,b'forged');raise Exception('model inherited acknowledgment descriptor')
except OSError as error: assert error.errno==errno.EBADF
${detached ? `pid=os.fork()
if pid==0:
 os.setsid()
 if os.fork(): os._exit(0)
 os.close(0);os.close(1);os.close(2)
 open(sys.argv[1],'w').write(str(os.getpid()))
 while os.path.exists(sys.argv[1]+'.alive'): time.sleep(.03)
 os._exit(0)
os.waitpid(pid,0)
while not os.path.exists(sys.argv[1]): time.sleep(.01)` : `child=subprocess.Popen([sys.executable,'-I','-B','-c','import os,sys,time;\\nwhile os.path.exists(sys.argv[1]+".alive"): time.sleep(.03)',sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
open(sys.argv[1],'w').write(str(child.pid))`}
${cancellation === "none" ? "" : "while os.path.exists(sys.argv[1]+'.alive'): time.sleep(.03)"}
`;
    guard.stdin!.write(JSON.stringify(containedRequest({ argv: [python, "-I", "-B", "-c", code, marker], cwd: root, env: { PATH: process.env.PATH }, prompt: "", cleanupRoot: root, timeoutMs: cancellation === "timeout" ? 1 : 10000 })) + "\n");
    let descendant = 0;
    try {
      for (let index = 0; index < 100 && !descendant; index++) {
        descendant = Number(await readFile(marker, "utf8").catch(() => "0"));
        if (!descendant) await delay(30);
      }
      assert.ok(descendant > 0, diagnostics);
      if (cancellation === "signal") guard.kill("SIGTERM");
      if (cancellation === "parent-eof") guard.stdin!.end();
      const result = await finished;
      assert.equal(result, cancellation === "none" ? 0 : 137, diagnostics);
      if (cancellation === "parent-eof") {
        assert.equal(ack, "");
        await assert.rejects(readFile(marker), { code: "ENOENT" });
      }
      else assert.deepEqual(JSON.parse(ack), { version: 1, model_stopped: true, returncode: result });
      const live = (await promisify(execFile)("/bin/ps", ["-o", "stat=", "-p", String(descendant)]).catch(() => ({ stdout: "" }))).stdout.trim();
      assert.ok(!live || live.startsWith("Z"));
    } finally {
      // The fixture exits independently if an assertion interrupts the guard.
      await rm(keepalive, { force: true });
      guard.stdin!.destroy();
      if (guard.exitCode === null && guard.signalCode === null) guard.kill("SIGKILL");
    }
  });
}
