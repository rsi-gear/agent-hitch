"""Exercise the actual environment wrapper against a deterministic Docker model."""
import asyncio
import importlib.util
import hashlib
import json
import pathlib
import sys
import tempfile
import types
import shutil

bridge = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(bridge))
containers = {}
serial = 0
fault = None
downloads = 0
starts = []


def stopped():
    return {"Running": False, "Paused": False, "Restarting": False, "Pid": 0, "Status": "exited"}


def project(session):
    import re
    value = session.lower()
    if not re.match(r"^[a-z0-9]", value):
        value = "0" + value
    return re.sub(r"[^a-z0-9_-]", "-", value)


class DockerEnvironment:
    _EGRESS_CONTROL_SERVICE_NAME = "egress"

    def __init__(self, *, environment_dir, session_id, trial_paths, **kwargs):
        self.environment_dir = pathlib.Path(environment_dir)
        self.session_id = session_id
        self.trial_paths = trial_paths
        self._environment_docker_compose_path = self.environment_dir / "docker-compose.yaml"
        self.extra_docker_compose_paths = []
        self._enable_egress_control = False

    @property
    def _docker_compose_paths(self):
        return []

    async def _run_docker_compose_command(self, command, *args, **kwargs):
        global serial
        group = project(self.session_id)
        selected = [c for c in containers.values() if c["labels"]["com.docker.compose.project"] == group]
        if command[0] == "config":
            doc = json.loads(self._hitch_ownership_compose_path.read_text())
            if fault == "extra-compose":
                doc["services"]["unplanned"] = {"labels": self._hitch_ownership_labels}
            if fault == "restart-policy":
                doc["services"]["main"]["restart"] = "always"
            if fault == "deploy-restart-policy":
                doc["services"]["main"]["deploy"] = {"restart_policy": {"condition": "any"}}
            return types.SimpleNamespace(return_code=0, stdout=json.dumps(doc))
        if command[0] == "up":
            starts.append(self.session_id)
            names = ["main"] if "__env" not in self.session_id else ["main", "simulator"]
            for name in names:
                serial += 1
                identity = f"{serial:064x}"
                containers[identity] = {"id": identity, "state": {"Running": True, "Paused": False, "Restarting": False, "Pid": serial, "Status": "running"},
                    "labels": {**self._hitch_ownership_labels, "com.docker.compose.project": group,
                               "com.docker.compose.service": name, "com.docker.compose.oneoff": "False"}}
        if command[0] == "stop":
            if fault == "main-stop-error":
                raise RuntimeError("native stop failed")
            for item in selected:
                if len(command) == 1 or item["labels"]["com.docker.compose.service"] == command[1]:
                    item["state"] = stopped()
                    if fault == "paused-main":
                        item["state"].update(Paused=True, Status="paused")
        if command[0] == "down":
            if selected and fault == "down-error":
                raise RuntimeError("native down failed")
            for item in selected:
                if fault == "live-sidecar" and item["labels"]["com.docker.compose.service"] == "simulator":
                    continue
                containers.pop(item["id"], None)
        return types.SimpleNamespace(return_code=0, stdout="")

    async def start(self, force_build):
        await self._run_docker_compose_command(["down"])
        await self._run_docker_compose_command(["up", "--detach", "--wait"])

    async def stop_service(self, service):
        await self._run_docker_compose_command(["stop", service])

    async def stop(self, delete):
        # Harbor intentionally catches Docker cleanup errors. The Hitch sticky
        # failure must survive this, and the next environment must not start.
        try:
            await self._run_docker_compose_command(["down"] if delete else ["stop"])
        except RuntimeError:
            pass

    async def service_download_file(self, source_path, target_path, *, service=None):
        global downloads
        downloads += 1
        pathlib.Path(target_path).write_text("snapshot")

    async def service_download_dir(self, source_dir, target_dir, *, service=None):
        await self.service_download_file(source_dir, pathlib.Path(target_dir) / "snapshot", service=service)

    async def service_exec(self, command, *, service=None, **kwargs):
        return types.SimpleNamespace(return_code=0)


for name in ["harbor", "harbor.environments", "harbor.environments.docker"]:
    sys.modules[name] = types.ModuleType(name)
constants = types.ModuleType("harbor.constants")
constants.MAIN_SERVICE_NAME = "main"
docker_module = types.ModuleType("harbor.environments.docker.docker")
docker_module.DockerEnvironment = DockerEnvironment
yaml = types.ModuleType("yaml")
yaml.safe_load = json.loads
sys.modules.update({"harbor.constants": constants, "harbor.environments.docker.docker": docker_module, "yaml": yaml})
import hitch_phase_resources as phases
spec = importlib.util.spec_from_file_location("hitch_harbor_environment", bridge / "hitch_harbor_environment.py")
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


async def fake_docker(self, args):
    if fault == "docker-unavailable":
        raise phases.PhaseResourceError("phase_transition_unconfirmed: Docker unavailable")
    if args[0] == "info":
        return "fake-docker-backend-changed" if fault == "backend-changed" else "fake-docker-backend"
    if args[:2] == ["container", "ls"]:
        selected = list(containers.values())
        for i, arg in enumerate(args):
            if arg == "--filter":
                key, value = args[i + 1].split("=", 1)
                if key == "id":
                    selected = [c for c in selected if c["id"] == value]
                else:
                    label, expected = value.split("=", 1)
                    selected = [c for c in selected if c["labels"].get(label) == expected]
        return "\n".join(c["id"] for c in selected)
    if args[:2] == ["container", "inspect"]:
        return json.dumps(containers[args[-1]])
    raise AssertionError(args)


phases.PhaseResourceBarrier.docker = fake_docker
labels = {"io.hitch.root-id": "a" * 24, "io.hitch.provider": "local-docker",
          "io.hitch.eval-id": "eval_" + "b" * 32, "io.hitch.work-id": "work_" + "c" * 32,
          "io.hitch.lease-id": "lease_" + "d" * 32, "io.hitch.lease-epoch": "1", "io.hitch.task-id": "task-a"}
contract = {"schema_version": "1", "capability": "phase-exclusive-teardown-v1", "plan_digest": "sha256:" + "e" * 64,
            "task_id": "task-a", "attempt": 1, "verifier_mode": "separate",
            "agent_services": [{"name": "main", "replicas": 1}, {"name": "simulator", "replicas": 1}],
            "verifier_services": [{"name": "main", "replicas": 1}],
            "artifacts": [{"service": "simulator", "path": "/evidence/snapshot.json"}]}


def environment(root, verifier=False, legacy=False, alternate=None, ownership=None, source=None):
    directory = root / ("tests" if verifier else "environment")
    directory.mkdir(exist_ok=True)
    services = {"main": {}}
    if not verifier:
        services["simulator"] = {}
    (directory / "docker-compose.yaml").write_text(json.dumps({"services": services}))
    session = phases._verifier_session(root.name) if verifier else root.name + "__env"
    kwargs = {} if legacy else {"hitch_phase_resource_contract": alternate or contract}
    if source is not None:
        kwargs["hitch_phase_verifier_source"] = source
    return wrapper.HitchHarborDockerEnvironment(environment_dir=directory, session_id=session,
        trial_paths=types.SimpleNamespace(trial_dir=root), hitch_ownership_labels=ownership or labels, **kwargs)


def artifacts(root, valid=True):
    directory = root / "artifacts" / "evidence"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "snapshot.json").write_text("snapshot")
    entries = [{"source": "/evidence/snapshot.json", "destination": "artifacts/evidence/snapshot.json",
                "service": "simulator", "type": "file", "status": "ok"}]
    (directory.parent / "manifest.json").write_text(json.dumps(entries if valid else []))


async def rejected(awaitable):
    try:
        await awaitable
    except (phases.PhaseResourceError, RuntimeError):
        return
    raise AssertionError("operation was unexpectedly allowed")


async def scenario(name, root):
    global fault, downloads
    fault = None
    downloads = 0
    containers.clear()
    starts.clear()
    phases._AGENTS.clear()
    env = environment(root)
    await env.start(False)
    artifacts(root)
    if name in ("main-stop-error", "paused-main"):
        fault = name
        await rejected(env.stop_service("main"))
        # Both the sidecar collect hook and copy must remain blocked, even when
        # Harbor catches their errors and later successfully removes all containers.
        await rejected(env.service_exec("collect", service="simulator"))
        await rejected(env.service_download_file("snapshot", root / "copied", service="simulator"))
        assert downloads == 0
        fault = None
        await rejected(env.stop(True))
        assert not containers
        await rejected(environment(root, verifier=True).start(False))
        assert len(starts) == 1
        return
    await env.stop_service("main")
    await env.service_download_file("snapshot", root / "copied", service="simulator")
    assert downloads == 1
    if name in ("down-error", "live-sidecar", "docker-unavailable"):
        fault = name
        await rejected(env.stop(True))
        fault = None
        await rejected(environment(root, verifier=True).start(False))
        assert len(starts) == 1
        return
    if name == "missing-artifact":
        artifacts(root, False)
        await rejected(env.stop(True))
        await rejected(environment(root, verifier=True).start(False))
        return
    await env.stop(name != "success-retained")
    receipt = json.loads((root / "hitch-phase-resources-agent.json").read_text())
    assert any(e["event"] == "main.stopped-confirmed" for e in receipt["events"])
    assert receipt["events"][-1]["event"] == "environment.stopped-confirmed"
    assert receipt["artifact_seal"]["tree_digest"].startswith("sha256:")
    if name == "changed-artifact":
        (root / "artifacts/evidence/snapshot.json").write_text("changed")
    elif name == "lost-process":
        phases._AGENTS.clear()
    elif name == "changed-epoch":
        new_labels = {**labels, "io.hitch.lease-epoch": "2"}
        await rejected(environment(root, verifier=True, ownership=new_labels).start(False))
        return
    elif name == "changed-plan":
        await rejected(environment(root, verifier=True, alternate={**contract, "attempt": 2}).start(False))
        return
    elif name == "resurrected-main":
        identity = next(i for i, c in env._hitch_phase_resources.containers.items() if c["service"] == "main")
        containers[identity] = {"id": identity, "state": {"Running": True, "Paused": False, "Restarting": False, "Pid": 999, "Status": "running"},
            "labels": {**labels, "com.docker.compose.project": project(env.session_id), "com.docker.compose.service": "main"}}
    elif name in ("extra-compose", "backend-changed"):
        fault = name
    verifier = environment(root, verifier=True)
    if name not in ("success", "success-retained"):
        await rejected(verifier.start(False))
        assert len(starts) == 1
        return
    await verifier.start(False)
    assert len(starts) == 2
    if name == "success-retained":
        assert len(containers) == 3
        assert sum(c["state"]["Running"] for c in containers.values()) == 1
        await verifier.stop(False)
        assert all(not c["state"]["Running"] for c in containers.values())
    else:
        assert all(c["labels"]["com.docker.compose.service"] == "main" for c in containers.values())
        await verifier.stop(True)
        assert not containers
    await rejected(env.start(False))


async def main():
    global fault
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        for name in ["success", "success-retained", "main-stop-error", "paused-main", "down-error", "live-sidecar", "docker-unavailable",
                     "missing-artifact", "changed-artifact", "lost-process", "changed-epoch", "changed-plan", "resurrected-main", "extra-compose", "backend-changed"]:
            directory = root / name
            directory.mkdir()
            await scenario(name, directory)
        for variation in ("unplanned-agent-service", "restart-policy", "deploy-restart-policy", "early-sidecar-download"):
            fault = None
            containers.clear()
            starts.clear()
            phases._AGENTS.clear()
            directory = root / variation
            directory.mkdir()
            agent = environment(directory)
            if variation != "early-sidecar-download":
                fault = "extra-compose" if variation == "unplanned-agent-service" else variation
                await rejected(agent.start(False))
                assert not starts, "unplanned topology created a container before validation"
            else:
                await agent.start(False)
                await rejected(agent.service_download_file("snapshot", directory / "copied", service="simulator"))
                assert not (directory / "copied").exists()
                await rejected(agent.stop(True))
                await rejected(environment(directory, verifier=True).start(False))
                assert len(starts) == 1
        # Preparation may add overlays after the early start guard. The final
        # composed topology must still be checked before any container starts.
        fault = None
        containers.clear()
        starts.clear()
        phases._AGENTS.clear()
        directory = root / "prepared-topology"
        directory.mkdir()
        agent = environment(directory)
        class Preparation:
            images = {}
            def reset(self, force_build):
                self.reset_called = True
            async def runtime(self, run):
                assert self.reset_called
                document = json.loads(agent._hitch_ownership_compose_path.read_text())
                document["services"]["unplanned-prepared-service"] = {"labels": labels}
                agent._hitch_ownership_compose_path.write_text(json.dumps(document))
        agent._hitch_preparation = Preparation()
        await rejected(agent.start(False))
        assert not starts, "preparation bypassed final phase topology validation"
        fault = None
        containers.clear()
        legacy_dir = root / "legacy"
        legacy_dir.mkdir()
        legacy = environment(legacy_dir, legacy=True)
        await legacy.start(False)
        assert legacy._hitch_phase_resources is None
        await legacy.stop(True)
        assert not list(legacy_dir.glob("hitch-phase-resources-*.json"))
        for variation in ["valid", "receipt-changed", "snapshot-changed", "source-alive", "remote-source", "backend-changed"]:
            fault = None
            containers.clear()
            phases._AGENTS.clear()
            source_dir = root / ("source-" + variation)
            source_dir.mkdir()
            agent = environment(source_dir)
            await agent.start(False)
            artifacts(source_dir)
            await agent.stop_service("main")
            await agent.stop(True)
            receipt_path = source_dir / "hitch-phase-resources-agent.json"
            receipt = json.loads(receipt_path.read_text())
            if variation == "remote-source":
                receipt["ownership"]["io.hitch.provider"] = "remote-docker"
                receipt_path.write_text(json.dumps(receipt))
            source = {"schema_version": "1", "source_directory": str(source_dir),
                      "receipt_digest": "sha256:" + hashlib.sha256(receipt_path.read_bytes()).hexdigest()}
            regrade_dir = root / ("regrade-" + variation)
            regrade_dir.mkdir()
            shutil.copytree(source_dir / "artifacts", regrade_dir / "artifacts")
            phases._AGENTS.clear()  # A real regrade is in a different process.
            if variation == "receipt-changed":
                receipt_path.write_text(receipt_path.read_text() + "\n")
            elif variation == "snapshot-changed":
                (regrade_dir / "artifacts/evidence/snapshot.json").write_text("changed")
            elif variation == "source-alive":
                identity = next(i for i, c in agent._hitch_phase_resources.containers.items() if c["service"] == "main")
                containers[identity] = {"id": identity, "state": {"Running": True, "Paused": False, "Restarting": False, "Pid": 999, "Status": "running"},
                    "labels": {**labels, "com.docker.compose.project": project(agent.session_id), "com.docker.compose.service": "main"}}
            elif variation == "backend-changed":
                fault = "backend-changed"
            new_labels = {**labels, "io.hitch.lease-id": "lease_" + "f" * 32}
            verifier = environment(regrade_dir, verifier=True, ownership=new_labels, source=source)
            if variation == "valid":
                unused_agent = environment(regrade_dir, ownership=new_labels, source=source)
                await rejected(unused_agent.start(False))
                assert unused_agent._hitch_phase_resources.key not in phases._AGENTS
            if variation == "valid":
                await verifier.start(False)
                await verifier.stop(True)
                assert "verifier.regrade-authorized" in (regrade_dir / "hitch-phase-resources-verifier.json").read_text()
                assert source["receipt_digest"] == "sha256:" + hashlib.sha256(receipt_path.read_bytes()).hexdigest()
            else:
                await rejected(verifier.start(False))
    print("phase resource lifecycle barriers passed")


asyncio.run(main())
