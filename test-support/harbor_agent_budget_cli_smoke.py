"""Real Hitch CLI timeout/export with a local fake model; no model API or Docker.

Host path translation substitutes for Harbor container I/O. The real agent bridge,
CLI, executor, process retirement and exported result files are exercised.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile

from bridge_smoke import AgentContext, ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / "integrations/harbor"))
bridge = load_bridge(str(repo / "integrations/harbor/hitch_harbor_agent.py"))
digest = "sha256:" + "a" * 64


async def command(argv, *, env, cwd, timeout=12):
    child = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(child.communicate(), timeout)
    except BaseException:
        if child.returncode is None:
            child.kill()
        await child.wait()
        raise
    return ExecResult(stdout.decode(), stderr.decode(), child.returncode)


class Environment:
    def __init__(self, root, executable, case):
        self.root = root
        self.environment_dir = root / "environment"
        for folder in [self.environment_dir, root / "workspace", root / "agent", root / "tmp"]:
            folder.mkdir(parents=True, exist_ok=True)
        self.variables = {**os.environ, "HITCH_CODEX_PATH": str(executable),
                          "SYNTHETIC_VERSION_DELAY_MS": "1200" if case == "prelaunch-expiry" else "250"}
        self.config = {"task": {"driver": {"kind": "terminal"}, "submission": {}},
                       "agent_timeout_sec": 1 if case == "prelaunch-expiry" else 2,
                       "profile": {"budget": {"collection_timeout_ms": 3000, "cleanup_grace_ms": 3000}}}
        (root / ".hitch-benchmark.json").write_text(json.dumps(self.config))
        self._hitch_benchmark = type("Session", (), {"config": self.config})()

    def mapped(self, text):
        replacements = dict([("/opt/hitch/", str(repo) + "/"), ("/logs/agent", str(self.root / "agent")),
                               ("/tmp/hitch-state", str(self.root / "state")), ("/tmp/hitch-", str(self.root / "tmp/hitch-")),
                               ("/workspace", str(self.root / "workspace"))])
        return re.sub("|".join(re.escape(key) for key in replacements), lambda match: replacements[match.group()], text)

    async def upload_file(self, source, target):
        await asyncio.sleep(0.05)
        destination = Path(self.mapped(target))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(Path(source).read_bytes())

    async def exec(self, text, **kwargs):
        return await command(["/bin/bash", "-c", self.mapped(text)], env=self.variables,
                             cwd=self.mapped(kwargs.get("cwd") or "/workspace"))


async def main():
    receipts = []
    with tempfile.TemporaryDirectory(prefix="hitch-budget-cli-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        executable = root / "synthetic-codex"
        executable.write_text('''#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  setTimeout(() => { console.log('codex-cli 9.9.9'); }, Number(process.env.SYNTHETIC_VERSION_DELAY_MS || 0));
} else {
  fs.writeFileSync('candidate.pid', String(process.pid));
  console.log(JSON.stringify({type:'thread.started',thread_id:require('node:crypto').randomUUID()}));
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
''')
        executable.chmod(0o755)
        resolved = await command(["node", "--input-type=module", "-e",
            "import {resolveHarness,parseHarnessReference} from './dist/src/revisions/index.js';console.log((await resolveHarness(parseHarnessReference('codex'),{root:process.argv[1]})).identity)",
            str(root / "resolution")], env={**os.environ, "HITCH_CODEX_PATH": str(executable)}, cwd=str(repo))
        assert resolved.return_code == 0, resolved.stderr
        for case in ["running-timeout", "prelaunch-expiry"]:
            directory = root / case
            env = Environment(directory, executable, case)
            (directory / "lock.json").write_text(json.dumps({"schema_version": 2, "task": {"name": "synthetic-timeout"}}))
            agent = bridge.HitchHarborAgent(logs_dir=directory / "agent", harness_ref="codex", revision_identity=resolved.stdout.strip(),
                hitch_runtime_dir=str(repo), workdir="/workspace", hitch_timeout_ms=0, eval_id="eval_" + "1" * 32,
                benchmark_id="synthetic", benchmark_revision=digest, verifier_identity=digest)
            agent._entrypoint = "dist/bin/hitch.js"
            context = AgentContext()
            try:
                try:
                    await asyncio.wait_for(agent.run("Wait indefinitely.", env, context), env.config["agent_timeout_sec"] + 6)
                except bridge.HitchBridgeError as error:
                    assert error.code == "hitch_process_failed", error
                else:
                    raise AssertionError("real CLI timeout was not reported")
                result = json.loads((directory / "agent/hitch-result.json").read_text())
                exported = json.loads((directory / "agent/hitch-run-bundle/result.json").read_text())
                assert result == exported and result["status"] == "timed_out"
                assert context.metadata["hitch_status"] == "timed_out"
                assert (directory / "agent/hitch-run-bundle/bundle.complete.json").is_file()
                events = [json.loads(line) for line in (directory / "agent/hitch-run-bundle/events.jsonl").read_text().splitlines()]
                assert any(e["type"] == "run.failed" and e.get("status") == "timed_out" for e in events)
                pidfile = directory / "workspace/candidate.pid"
                assert pidfile.exists() == (case == "running-timeout")
                if pidfile.exists():
                    try:
                        os.kill(int(pidfile.read_text()), 0)
                    except ProcessLookupError:
                        pass
                    else:
                        raise AssertionError("synthetic model outlived terminal result")
                receipts.append({"case": case, "status": result["status"], "model_launched": pidfile.exists(), "terminal_bundle_exported": True})
            finally:
                # This PID is written only by this fixture's private executable.
                pidfile = directory / "workspace/candidate.pid"
                if pidfile.exists():
                    try:
                        os.killpg(int(pidfile.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
    print(json.dumps({"scope": "real-cli-synthetic-model-local-io", "passed": True, "cases": receipts}))


if __name__ == "__main__":
    asyncio.run(main())
