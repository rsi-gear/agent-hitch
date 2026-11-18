import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

test("Darwin stop proof rejects lost identities, new zombies and concurrent forks", { skip: process.platform === "win32" }, async () => {
  await promisify(execFile)(process.env.HITCH_GUARD_PYTHON || "python3", ["-I", "-B", "-c", `
import itertools, runpy, signal, types
from unittest.mock import patch
module = runpy.run_path('integrations/isolated-run/process-guard.py')
Guard = module['DarwinSandbox']

def observe(process, kill, markers=None, succeeds=False):
    guard = Guard.__new__(Guard)
    guard.pids = lambda: [123]
    guard.process = process
    guard.creation_marker = lambda: next(markers)
    markers = markers or itertools.count(100)
    calls = []
    def signal_process(pid, sig):
        calls.append((pid, sig))
        return kill(pid, sig)
    with patch.object(module['os'], 'kill', signal_process), \
         patch.object(module['time'], 'monotonic', lambda: next(clock)), \
         patch.object(module['time'], 'sleep', lambda _: None):
        clock = itertools.count(0, .1)
        try:
            guard.terminate()
        except RuntimeError:
            assert not succeeds, 'clean containment did not converge'
        else:
            assert succeeds, 'uncertain process boundary was accepted'
    return calls

def outsider(pid, sig):
    assert sig == 0, 'an unrelated PID received a real signal'
    raise PermissionError()

def vanished(pid):
    raise ProcessLookupError()

def process(identity=1, state=1):
    return types.SimpleNamespace(identity=(123, identity, 0), state=state)

observe(vanished, outsider)
identities = itertools.count(1)
observe(lambda _: process(next(identities)), outsider)
zombies = itertools.count(1)
observe(lambda _: process(next(zombies), 5), outsider)
observe(lambda _: process(), outsider, itertools.count(100, 2))
assert observe(lambda _: process(), outsider, succeeds=True) == [(123, 0)]

alive, inspections = True, 0
def owned(pid):
    global inspections
    inspections += 1
    return process(state=1 if alive else 5)
def stop(pid, sig):
    global alive
    if sig == signal.SIGKILL: alive = False
calls = observe(owned, stop, succeeds=True)
assert calls == [(123, 0), (123, signal.SIGKILL)]
assert inspections >= 3, 'new zombie was accepted in the kill pass'

for short_result in (0, 55):
    guard = Guard.__new__(Guard)
    guard.libproc = types.SimpleNamespace(proc_pidinfo=lambda *args: short_result)
    with patch.object(module['os'], 'fork', lambda: 123), \
         patch.object(module['os'], 'kill'), patch.object(module['os'], 'waitpid'):
        try: guard.creation_marker()
        except RuntimeError: pass
        else: raise AssertionError('missing process birth identity was accepted')
`]);
});

test("guard never acknowledges a failed stop proof", { skip: process.platform === "win32" }, async () => {
  const python = process.env.HITCH_GUARD_PYTHON || "python3";
  // This replaces only the observer with a deliberately inconclusive one;
  // main still starts a real child and handles its normal-exit cleanup.
  const guard = spawn(python, ["-I", "-B", "-c", `
import runpy, sys
module = runpy.run_path('integrations/isolated-run/process-guard.py')
class Inconclusive:
    def __init__(self, request): pass
    def terminate(self): raise RuntimeError('stop proof unavailable')
module['main'].__globals__['DarwinSandbox'] = Inconclusive
sys.exit(module['main']())
`], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let ack = "", diagnostics = "";
  guard.stdio[3]!.on("data", chunk => { ack += chunk.toString(); });
  guard.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => {
    guard.once("close", resolve); guard.once("error", reject);
  });
  guard.stdin!.write(JSON.stringify({
    darwinSandbox: true, argv: [python, "-I", "-B", "-c", "pass"],
    cwd: process.cwd(), env: { PATH: process.env.PATH }, prompt: "", timeoutMs: 1000,
  }) + "\n");
  try {
    assert.equal(await finished, 1);
    assert.match(diagnostics, /stop proof unavailable/);
    assert.equal(ack, "");
  } finally {
    guard.stdin!.destroy();
    if (guard.exitCode === null && guard.signalCode === null) guard.kill("SIGKILL");
  }
});

test("guard cancellation during initialization confirms no model started", { skip: process.platform === "win32" }, async () => {
  const python = process.env.HITCH_GUARD_PYTHON || "python3";
  const guard = spawn(python, ["-I", "-B", "-c", `
import os, runpy, signal, sys
module = runpy.run_path('integrations/isolated-run/process-guard.py')
class CancelDuringInitialization:
    def __init__(self, request): os.kill(os.getpid(), signal.SIGTERM)
def forbidden_launch(*args, **kwargs):
    raise AssertionError('cancelled guard started a model')
module['main'].__globals__['DarwinSandbox'] = CancelDuringInitialization
module['subprocess'].Popen = forbidden_launch
sys.exit(module['main']())
`], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let ack = "", diagnostics = "";
  guard.stdio[3]!.on("data", chunk => { ack += chunk.toString(); });
  guard.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => {
    guard.once("close", resolve); guard.once("error", reject);
  });
  guard.stdin!.write(JSON.stringify({ darwinSandbox: true }) + "\n");
  try {
    assert.equal(await finished, 137, diagnostics);
    assert.deepEqual(JSON.parse(ack), { version: 1, model_stopped: true, returncode: 137 });
  } finally {
    guard.stdin!.destroy();
    if (guard.exitCode === null && guard.signalCode === null) guard.kill("SIGKILL");
  }
});
