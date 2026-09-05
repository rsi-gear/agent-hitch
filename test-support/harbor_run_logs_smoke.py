"""Exercise log FD lifetime and interrupted evidence using real shell/Node I/O."""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge_smoke import ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
bridge = load_bridge(str(Path(__file__).resolve().parents[1] / "integrations/harbor/hitch_harbor_agent.py"))


class RunLogsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hitch-run-logs-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.source = self.root / "source"
        self.source.mkdir()
        self.agent = bridge.HitchHarborAgent(logs_dir=self.logs, harness_ref="deepseek@local", revision_identity="sha256:" + "a" * 64, hitch_runtime_dir=str(self.root))
        self.commands = []
        self.destinations = []

    async def exec(self, command, **kwargs):
        self.commands.append(command)
        args = shlex.split(command)
        args[-2] = str(self.source)
        args[-1] = str(self.root / Path(args[-1]).name)
        self.destinations.append(Path(args[-1]))
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate()
        self.assertEqual(proc.returncode, 0, err.decode())
        return ExecResult(out.decode(), err.decode(), proc.returncode)

    async def test_log_output_and_failure_code(self):
        for code in [0, 7]:
            invocation = shlex.join([sys.executable, "-c", f"import sys;print('out');print('err',file=sys.stderr);sys.exit({code})"])
            command = self.agent._logged_run_command(invocation).replace("/logs/agent", shlex.quote(str(self.logs)))
            proc = await asyncio.create_subprocess_exec("bash", "-c", command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await proc.communicate()
            self.assertEqual((proc.returncode, out, err), (code, b"out\n", b"err\n"))
            self.assertEqual((self.logs / "hitch-events.jsonl").read_bytes(), out)
            self.assertEqual((self.logs / "hitch-stderr.log").read_bytes(), err)

    async def test_background_service_does_not_inherit_log_pipes(self):
        ready = self.root / "background.json"
        child = self.root / "background.py"
        child.write_text("import os,stat,json,time,pathlib\n"
            "pipes=[]\n"
            "for fd in range(3,256):\n"
            " try:\n"
            "  if stat.S_ISFIFO(os.fstat(fd).st_mode):pipes.append(fd)\n"
            " except OSError:pass\n"
            f"pathlib.Path({str(ready)!r}).write_text(json.dumps(dict(pid=os.getpid(),pipes=pipes)))\n"
            "time.sleep(2)\n")
        parent = ("import subprocess,sys,time,pathlib;"
            f"p=subprocess.Popen([sys.executable,{str(child)!r}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=False,start_new_session=True);"
            f"ready=pathlib.Path({str(ready)!r});"
            "\nwhile not ready.exists():time.sleep(0.01)\n")
        invocation = shlex.join([sys.executable, "-c", parent])
        command = self.agent._logged_run_command(invocation).replace("/logs/agent", shlex.quote(str(self.logs)))
        proc = await asyncio.create_subprocess_exec("bash", "-c", command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            await asyncio.wait_for(proc.communicate(), 1.5)
            self.assertEqual(proc.returncode, 0)
            state = json.loads(ready.read_text())
            self.assertEqual(state["pipes"], [])
            os.kill(state["pid"], 0)  # The service is still running for a verifier.
        finally:
            await asyncio.sleep(2)

    async def test_preserves_evidence_without_credentials_or_external_paths(self):
        (self.source / "events.jsonl").write_text('{"type":"run.completed"}\n')
        (self.source / "trajectory").mkdir()
        (self.source / "trajectory/session.jsonl").write_text('{"type":"session"}\n')
        (self.source / "runtime-home").mkdir()
        (self.source / "runtime-home/auth.json").write_text('secret')
        (self.source / "trajectory/unsafe.json").symlink_to(self.source / "runtime-home/auth.json")
        (self.source / "trajectory/unsafe-dir").symlink_to(self.source / "runtime-home", target_is_directory=True)
        os.mkfifo(self.source / "trajectory/pipe")
        ref = {"files": [{"path": p} for p in ["trajectory/session.jsonl", "trajectory/session.jsonl", "trajectory/unsafe.json", "trajectory/unsafe-dir/auth.json", "trajectory/../runtime-home/auth.json", "trajectory/pipe"]]}
        (self.source / "trajectory.ref.json").write_text(json.dumps(ref))
        await self.agent._preserve_interrupted_run(self, "run_" + "a" * 32)
        dest = self.destinations[0]
        self.assertEqual((dest / "events.jsonl").read_text(), (self.source / "events.jsonl").read_text())
        self.assertTrue((dest / "trajectory/session.jsonl").is_file())
        self.assertFalse((dest / "trajectory/unsafe.json").exists())
        self.assertFalse((dest / "runtime-home").exists())
        self.assertFalse((dest / "bundle.complete.json").exists())
        self.assertFalse(json.loads((dest / "diagnostic.json").read_text())["complete"])

    async def test_missing_result_still_preserves_existing_events(self):
        (self.source / "events.jsonl").write_text('{"type":"run.started"}\n')
        await self.agent._preserve_interrupted_run(self, "run_" + "b" * 32)
        dest = self.destinations[0]
        self.assertTrue((dest / "events.jsonl").exists())
        self.assertFalse((dest / "result.json").exists())

    async def test_cleanup_timeout_is_bounded_and_not_raised(self):
        class Blocked:
            async def exec(self, *args, **kwargs):
                await asyncio.Event().wait()
        real_wait_for = asyncio.wait_for
        async def short_wait(awaitable, timeout):
            self.assertEqual(timeout, 5)
            return await real_wait_for(awaitable, 0.01)
        with patch.object(bridge.asyncio, "wait_for", short_wait):
            await self.agent._preserve_interrupted_run(Blocked(), "run_" + "c" * 32)
        receipt = json.loads((self.logs / "hitch-interrupted-run.json").read_text())
        self.assertIn(receipt["export_error"], ["TimeoutError"])
        self.assertFalse(receipt["complete"])


if __name__ == "__main__":
    unittest.main()
