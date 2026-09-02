"""Protocol failure gates with an injected deterministic worker transport."""
import asyncio
import importlib.util
import json
from pathlib import Path
import shlex
import sys
import tempfile
from types import SimpleNamespace, ModuleType

bridge = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("hitch_benchmark", bridge)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.modules["hitch_benchmark"] = module
phases = ["prepare", "quiesce", "snapshot", "cleanup"]
config = {
    "task_id": "unregistered", "profile_digest": "sha256:" + "a" * 64,
    "profile": {"budget": {"collection_timeout_ms": 10000}},
    "tools": [{"name": "new_tool", "description": "test", "inputSchema": {"type": "object"}}],
    "task": {"lifecycle": {p: {"target": "environment:worker", "argv": ["python", "/test.py", "argument with spaces"], "timeout_ms": 1000} for p in phases}, "driver": {"config": {"endpoint": "http://worker:8765/"}}, "submission": {"paths": ["/state.json"], "max_bytes": 1000}},
}

class Environment:
    def __init__(self, root, failure=None):
        self.trial_paths = SimpleNamespace(trial_dir=root)
        self._hitch_ownership_labels = {}
        self.session_id = "test-session"
        self.failure = failure
        self.calls = []
        self.uploaded = []
    async def service_exec(self, command, **kwargs):
        argv = shlex.split(command)
        request = json.loads(argv[2])
        assert argv[3:] == ["|", "python", "/test.py", "argument with spaces"]
        assert kwargs["service"] == "worker"
        phase = request["phase"]; self.calls.append(phase)
        if phase == self.failure:
            raise RuntimeError("intentional worker failure")
        if self.failure == "cancel" and phase == "prepare":
            raise asyncio.CancelledError()
        outputs = {"prepare": {"ready": True, "tool_bindings": [{"endpoint": "http://worker:8765/", "token": "secret-token-" * 4, "tools": config["tools"]}]}, "quiesce": {"quiesced": True}, "snapshot": {"artifacts": [{"path": "/state.json", "bytes": 25}]}, "cleanup": {"cleaned": True}}
        return SimpleNamespace(return_code=0, stdout=json.dumps({"schema_version": "1", "request_id": request["request_id"], "status": "ok", "output": outputs[phase]}), stderr="")
    async def upload_file(self, source, target):
        self.uploaded.append(target)
    async def start(self, force_build):
        pass
    async def stop_service(self, service):
        assert service == "main"
    async def stop(self, delete):
        self.released = True

# Exercise the real environment wrapper's failure/cancellation finally path.
for name in ["harbor", "harbor.environments", "harbor.environments.docker"]:
    sys.modules[name] = ModuleType(name)
constants = ModuleType("harbor.constants"); constants.MAIN_SERVICE_NAME = "main"
docker = ModuleType("harbor.environments.docker.docker"); docker.DockerEnvironment = Environment
yaml = ModuleType("yaml"); yaml.safe_load = json.loads
sys.modules.update({"harbor.constants": constants, "harbor.environments.docker.docker": docker, "yaml": yaml})
env_spec = importlib.util.spec_from_file_location("environment_wrapper", bridge.with_name("hitch_harbor_environment.py"))
wrapper = importlib.util.module_from_spec(env_spec); env_spec.loader.exec_module(wrapper)

async def main():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for failure in [None, "prepare", "cancel"]:
            env = object.__new__(wrapper.HitchHarborDockerEnvironment)
            Environment.__init__(env, root, failure)
            session = module.BenchmarkSession(env, config)
            env._hitch_benchmark = session
            try:
                await env.start(False)
                await env.stop_service("main")
                await session.snapshot()  # phase IDs and outputs are reused.
                await env.stop(True)
            except (RuntimeError, asyncio.CancelledError):
                assert failure is not None
            assert env.released
            assert env.calls[-1] == "cleanup"
            if failure is None:
                assert env.calls == phases
                assert env.uploaded == ["/tmp/hitch-tool-binding.json", "/tmp/hitch-tools.mjs"]
            journal = session.journal.read_text()
            assert "secret-token" not in journal
            assert (json.loads(journal)["failure"] is not None) == (failure is not None)
        # The native result has already coerced bool/string to an integer. Only
        # the original reward JSON can distinguish invalid output from real zero.
        task_dir = root / "task"; task_dir.mkdir()
        config.update({"metrics": {"score": {"type": "binary", "range": [0, 1]}}, "primary_metric": "score", "task_digest": "sha256:" + "a" * 64})
        config["task"].update({"grading": {"metric_map": {"score": "passed"}}, "source_task_id": "original"})
        (task_dir / ".hitch-benchmark.json").write_text(json.dumps(config))
        verifier_dir = root / "verifier"; verifier_dir.mkdir()
        (root / "benchmark-lifecycle.json").write_text(json.dumps({"phases": dict.fromkeys(phases, {}), "failure": None}))
        verifier = SimpleNamespace(task=SimpleNamespace(paths=SimpleNamespace(environment_dir=task_dir / "environment")), trial_paths=SimpleNamespace(trial_dir=root, verifier_dir=verifier_dir))
        result = SimpleNamespace(rewards={"passed": 1}, model_copy=lambda update: update)
        for value in [True, "1", float("nan"), 2, None]:
            (verifier_dir / "reward.json").write_text(json.dumps({"passed": value}))
            try:
                module.normalize_rewards(verifier, result)
                raise AssertionError("invalid raw reward accepted")
            except RuntimeError:
                pass
        (verifier_dir / "reward.json").write_text(json.dumps({"passed": 0}))
        assert module.normalize_rewards(verifier, result)["rewards"]["reward"] == 0
    print("benchmark protocol failure gates passed")

asyncio.run(main())
