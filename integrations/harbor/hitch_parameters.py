"""Generic host-side parameter channel. No training or benchmark semantics.

The sandbox only submits proposals; a frozen host contract is the authority.
Accepted values prove configuration registration, never execution compliance.
"""
from __future__ import annotations
import asyncio
import contextlib
import json
from pathlib import Path
import shlex
import shutil
import tempfile

_READ_REQUESTS = '''import json, pathlib, re
root = pathlib.Path('/tmp/hitch-parameter-channel')
rows = []
for p in sorted(root.glob('*.request.json'))[:64]:
 if re.fullmatch(r'[a-f0-9]{32}(?:\\.capability)?\\.request\\.json', p.name) and not p.is_symlink() and p.is_file() and p.stat().st_size <= 1048576:
  try: rows.append({'id': p.name.split('.')[0], 'kind': 'capability' if '.capability.' in p.name else 'parameter', 'request': p.read_text()})
  except (ValueError, OSError): pass
print(json.dumps(rows))
'''

class ParameterSession:
    def __init__(self, agent, environment):
        self.agent, self.env = agent, environment
        self.task = Path(getattr(environment, "environment_dir", "/__no_parameter_task__/environment")).parent
        self.node = shutil.which("node")
        self.state = None
        self.monitor = None
        self.failure = None
        self.seen = set()
        self.capabilities = None

    async def call(self, command, request):
        if self.node is None:
            raise RuntimeError("parameter authority unavailable: host Node.js missing")
        argv = [self.node, str(self.cli), command, str(self.state_file)]
        if command == "init":
            argv += [str(self.task)]
            if self.agent._artifact_host_directory:
                argv.append(str(self.agent._artifact_host_directory))
        child = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(child.communicate((request if isinstance(request, str) else json.dumps(request)).encode()), 15)
        except BaseException:
            child.kill()
            await child.wait()
            raise
        if child.returncode != 0:
            raise RuntimeError("parameter authority rejected request: " + err.decode(errors="replace")[:4096])
        return json.loads(out)

    async def upload(self, value, destination, readonly=False):
        with tempfile.TemporaryDirectory(prefix="hitch-parameters-") as directory:
            file = Path(directory) / "value.json"
            file.write_text(json.dumps(value))
            await self.env.upload_file(file, destination)
        if readonly:
            result = await self.env.exec("chmod 444 " + shlex.quote(destination))
            if result.return_code:
                raise RuntimeError("parameter view could not be protected")

    async def start(self):
        if not (self.task / "parameters.json").is_file():
            return False
        self.state_file = Path(self.env.trial_paths.trial_dir) / "parameter-state.json"
        self.cli = self.agent.hitch_runtime_dir / "payload/dist/src/parameters/cli.js"
        _, task_id, attempt = self.agent._trial_identity()
        try:
            self.state = await self.call("init", {"task": self.agent.benchmark_revision + ":" + task_id,
                "dataset": self.agent.benchmark_revision, "task_id": task_id, "harness": self.agent.revision_identity, "runtime": self.agent.controller_runtime_id,
                "repetition": attempt, "eval": self.agent.eval_id})
        except Exception:
            rejected = Path(str(self.state_file) + ".admission-error.json")
            if rejected.is_file():
                self.agent.logs_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(rejected, self.state_file.parent / "parameter-evidence.json")
            raise
        if self.state is None:
            raise RuntimeError("parameter contract disappeared during admission")
        if self.state.get("bindings"):
            from hitch_capabilities import CapabilitySession
            self.capabilities = CapabilitySession(self)
            await self.capabilities.prepare()
        await self.upload(self.state, "/tmp/hitch-parameters.json", readonly=True)
        await self.env.upload_file(Path(__file__).with_name("hitch_parameters_client.py"), "/tmp/hitch-parameters.py")
        result = await self.env.exec("mkdir -p /tmp/hitch-parameter-channel")
        if result.return_code:
            raise RuntimeError("parameter channel unavailable")
        self.monitor = asyncio.create_task(self.poll())
        return True

    async def drain(self, allow_capabilities=True):
        result = await self.env.exec("python3 -c " + shlex.quote(_READ_REQUESTS))
        if result.return_code or len(result.stdout or "") > 2 * 1024 * 1024:
            raise RuntimeError("parameter channel evidence unavailable")
        for row in json.loads(result.stdout):
            if row["id"] in self.seen:
                continue
            if len(self.seen) >= 4096:
                raise RuntimeError("parameter channel request limit exceeded")
            try:
                if row.get("kind") == "capability":
                    if not allow_capabilities or self.capabilities is None:
                        raise RuntimeError("Agent phase ended before capability request started")
                    response = await self.capabilities.execute(row["request"])
                else:
                    response = await self.call("submit", row["request"])
                    self.state = response["state"]
            except Exception as error:
                response = {"accepted": False, "reason": str(error)[:4096]}
            await self.upload(response, "/tmp/hitch-parameter-channel/" + row["id"] + ".response.json")
            self.seen.add(row["id"])
            removed = await self.env.exec("rm -f -- " + shlex.quote("/tmp/hitch-parameter-channel/" + row["id"] + (".capability" if row.get("kind") == "capability" else "") + ".request.json"))
            if removed.return_code:
                raise RuntimeError("parameter channel could not acknowledge request")
            if response.get("accepted"):
                await self.upload(self.state, "/tmp/hitch-parameters.json", readonly=True)

    async def poll(self):
        try:
            while True:
                await self.drain()
                await asyncio.sleep(.25)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.failure = str(error)

    async def stop(self):
        if self.monitor:
            self.monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.monitor
            try:
                await self.drain(allow_capabilities=False)
            except Exception as error:
                self.failure = str(error)
        if self.capabilities is not None:
            await self.capabilities.stop()
        if self.state is not None:
            self.agent.logs_dir.mkdir(parents=True, exist_ok=True)
            evidence = {"version": 1, "state": self.state, "evidence_error": self.failure,
                        "source": "host_parameter_authority", "execution_compliance": "unverified"}
            # Harbor mounts agent logs writable into the candidate. Never
            # write through that untrusted directory (including symlinks).
            (self.state_file.parent / "parameter-evidence.json").write_text(json.dumps(evidence))
        if self.failure:
            raise RuntimeError("parameter evidence unavailable: " + self.failure)
