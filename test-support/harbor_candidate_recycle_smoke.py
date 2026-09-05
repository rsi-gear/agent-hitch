"""Deterministic failure-gate checks; no model, VM, or Docker daemon needed."""
import asyncio
import copy
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_candidate_recycle as module


class Environment:
    def __init__(self, root):
        self.trial_paths = SimpleNamespace(trial_dir=root, agent_dir=root / "agent", verifier_dir=root / "verifier", artifacts_dir=root / "artifacts")
        self.trial_paths.agent_dir.mkdir()
        self._hitch_ownership_labels = {"io.hitch.lease-id": "lease_" + "a" * 32}
        self.commands = []
        self.fail = None
        self.uploaded = False
        self.generation = 2
        self.containers = {}
        for service, identifier in [("main", "1"), ("desktop", "2")]:
            labels = {**self._hitch_ownership_labels, "com.docker.compose.service": service, "com.docker.compose.project": "test"}
            self.containers[service] = {"id": identifier * 64, "image": "sha256:" + "a" * 64, "state": "running", "started_at": "start-1", "labels": labels,
                                        "host": {"Memory": 134217728, "NanoCpus": 1000000000}, "config": {"Env": ["SECRET=hidden-value"], "Labels": labels}, "mounts": []}
        self.containers["main"]["mounts"] = [{"Type": "bind", "Source": str(root / "agent"), "Destination": "/logs/agent", "RW": True}]
        self.original = copy.deepcopy(self.containers["main"])

    async def _run_docker_compose_command(self, command, **kwargs):
        self.commands.append(command)
        if command[0] == self.fail:
            return SimpleNamespace(return_code=1, stdout="SECRET=must-not-journal")
        if command[0] == "ps":
            return SimpleNamespace(return_code=0, stdout="\n".join(item["id"] for item in self.containers.values()))
        if command[0] == "rm" and self.fail != "old-still-live":
            self.containers.pop("main")
        if command[0] == "up":
            self.containers["main"] = copy.deepcopy(self.original)
            self.generation += 1
            self.containers["main"]["id"] = str(self.generation) * 64
            if self.fail == "resources":
                self.containers["main"]["host"]["Memory"] *= 2
            if self.fail == "sidecar-restart":
                self.containers["desktop"]["started_at"] = "restarted"
        return SimpleNamespace(return_code=0, stdout="")

    async def docker(self, command):
        if command[0] == "inspect":
            return "\n".join(json.dumps(item) for item in self.containers.values())
        assert command == ["ps", "--all", "--no-trunc", "--quiet"]
        return "\n".join(item["id"] for item in self.containers.values())

    async def ensure_dirs(self, paths):
        assert paths == ["/logs/agent"]

    async def _upload_environment_dir_after_start(self):
        self.uploaded = True


async def rejected(call):
    try:
        await call
    except module.CandidateRecycleError as error:
        assert "SECRET" not in str(error)
        return
    raise AssertionError("invalid candidate recycle accepted")


async def main():
    config = {"config": {"Env": ["A=1", "B=2"]}, "host": {"Binds": ["/a:/a:rw", "/b:/b:rw"], "Memory": 1024}}
    reordered = copy.deepcopy(config)
    reordered["config"]["Env"].reverse()
    reordered["host"]["Binds"].reverse()
    assert module._configuration_digest(config) == module._configuration_digest(reordered)
    reordered["config"]["Env"][0] = "B=3"
    assert module._configuration_digest(config) != module._configuration_digest(reordered)
    original_docker = module._docker
    try:
        for case in ["success", "wrong-lease", "persistent-volume", "parent-mount", "shared-log", "foreign-log", "rm", "up", "resources", "old-still-live", "sidecar-restart"]:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                env = Environment(root)
                module._docker = env.docker
                recycler = module.CandidateRecycler(env)
                (root / "agent/old-trajectory.json").write_text("previous conversation")
                if case == "wrong-lease":
                    env.containers["desktop"]["labels"]["io.hitch.lease-id"] = "wrong"
                if case == "persistent-volume":
                    env.containers["main"]["mounts"].append({"Type": "volume"})
                if case == "parent-mount":
                    env.containers["main"]["mounts"].append({"Type": "bind", "Source": str(root), "Destination": "/past", "RW": False})
                if case == "shared-log":
                    env.containers["desktop"]["mounts"] = env.containers["main"]["mounts"]
                if case == "foreign-log":
                    foreign = root / "unrelated-user-directory"
                    foreign.mkdir()
                    env.containers["main"]["mounts"][0]["Source"] = str(foreign)
                if case in ["rm", "up", "resources", "old-still-live", "sidecar-restart"]:
                    env.fail = case
                if case != "success":
                    await rejected(recycler.recycle(1))
                    mutations = [command for command in env.commands if command[0] in ["rm", "up"]]
                    if case in ["rm", "up", "resources", "old-still-live", "sidecar-restart"]:
                        receipt = root / "hitch-candidate-phases/phase-0001/receipt.json"
                        assert json.loads(receipt.read_text())["status"] == "failed"
                        assert "SECRET" not in receipt.read_text()
                        await rejected(recycler.recycle(1))
                        assert mutations == [command for command in env.commands if command[0] in ["rm", "up"]]
                        assert not env.uploaded
                    else:
                        assert not mutations
                        assert (root / "agent/old-trajectory.json").exists()
                    continue
                receipt = await recycler.recycle(1)
                assert receipt["status"] == "completed" and receipt["scope"] == "environment-only"
                assert not list((root / "agent").iterdir())
                assert (root / "hitch-candidate-phases/phase-0001/agent/old-trajectory.json").read_text() == "previous conversation"
                assert env.uploaded
                assert "hidden-value" not in json.dumps(receipt)
                assert await recycler.recycle(1) == receipt
                assert len([command for command in env.commands if command[0] == "up"]) == 1
                assert json.loads(env._hitch_phase_compose_path.read_text())["services"]["main"]["image"] == receipt["image"]
                await rejected(recycler.recycle(3))
                await rejected(recycler.recycle(True))
                second = await recycler.recycle(2)
                assert second["old_container_id"] == receipt["new_container_id"]
                await rejected(recycler.recycle(1))
    finally:
        module._docker = original_docker
    print("candidate recycle failure gates passed")


if __name__ == "__main__":
    asyncio.run(main())
