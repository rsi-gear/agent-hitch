"""Fail-closed barriers for a frozen, single-step Docker resource contract.

The receipt is evidence, never authority: a verifier needs the matching agent
in this process (or an explicit hashed local regrade handoff), sealed artifacts,
and a fresh stop check against the original Docker daemon.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
import tempfile
import weakref
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping


class PhaseResourceError(RuntimeError):
    pass


_AGENTS: weakref.WeakValueDictionary[tuple[str, str, str], "PhaseResourceBarrier"] = weakref.WeakValueDictionary()
_CONTRACT_FIELDS = {
    "schema_version", "capability", "plan_digest", "task_id", "attempt",
    "verifier_mode", "agent_services", "verifier_services", "artifacts",
}


def validate_phase_contract(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != _CONTRACT_FIELDS:
        raise ValueError("Hitch phase resource contract fields are invalid")
    if (value["schema_version"] != "1"
            or value["capability"] != "phase-exclusive-teardown-v1"
            or value["verifier_mode"] != "separate"
            or not isinstance(value["plan_digest"], str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["plan_digest"])
            or not isinstance(value["task_id"], str) or not value["task_id"]
            or len(value["task_id"]) > 4096 or any(c in value["task_id"] for c in "\x00\r\n")
            or isinstance(value["attempt"], bool) or not isinstance(value["attempt"], int)
            or value["attempt"] < 1):
        raise ValueError("Hitch phase resource contract identity is invalid")
    for field in ("agent_services", "verifier_services"):
        services = value[field]
        if not isinstance(services, list) or not 1 <= len(services) <= 256:
            raise ValueError("Hitch phase resource services are invalid")
        names = set()
        for service in services:
            if (not isinstance(service, dict) or set(service) != {"name", "replicas"}
                    or not isinstance(service["name"], str)
                    or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}", service["name"])
                    or service["name"] in names or isinstance(service["replicas"], bool)
                    or not isinstance(service["replicas"], int) or not 1 <= service["replicas"] <= 256):
                raise ValueError("Hitch phase resource service is invalid")
            names.add(service["name"])
        if not any(s == {"name": "main", "replicas": 1} for s in services):
            raise ValueError("Hitch phase resource contract requires one main service")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, list) or len(artifacts) > 4096:
        raise ValueError("Hitch phase resource artifact requirements are invalid")
    agent_services = {s["name"] for s in value["agent_services"]}
    seen = set()
    for artifact in artifacts:
        if (not isinstance(artifact, dict) or set(artifact) != {"service", "path"}
                or artifact["service"] not in agent_services or not isinstance(artifact["path"], str)
                or not artifact["path"].startswith("/")
                or any(c in artifact["path"] for c in "\x00\r\n*?[]")
                or ".." in PurePosixPath(artifact["path"]).parts):
            raise ValueError("Hitch phase resource artifact requirement is invalid")
        key = (artifact["service"], artifact["path"])
        if key in seen:
            raise ValueError("Hitch phase resource artifact requirement is duplicated")
        seen.add(key)
    return json.loads(json.dumps(value))


class PhaseResourceBarrier:
    def __init__(self, environment: Any, contract: Mapping[str, Any], verifier_source: Any = None) -> None:
        self.environment = environment
        self.contract = dict(contract)
        self.labels = dict(environment._hitch_ownership_labels)
        if not self.labels or self.labels.get("io.hitch.task-id") != contract["task_id"]:
            raise PhaseResourceError("phase_transition_unconfirmed: task ownership differs")
        self.trial_dir = Path(environment.trial_paths.trial_dir).resolve()
        self.session = environment.session_id
        agent_session = f"{self.trial_dir.name}__env"
        verifier_session = _verifier_session(self.trial_dir.name)
        if self.session == agent_session:
            self.role = "agent"
        elif self.session == verifier_session:
            self.role = "verifier"
        else:
            raise PhaseResourceError("phase_transition_unconfirmed: unsupported trial session")
        self.verifier_source = _validate_verifier_source(verifier_source)
        self.project = _project_name(self.session)
        self.key = (str(self.trial_dir), self.labels["io.hitch.lease-id"], self.labels["io.hitch.lease-epoch"])
        self.failure: str | None = None
        self.started = False
        self.main_stop_attempted = False
        self.main_confirmed = False
        self.stopped_confirmed = False
        self.containers: dict[str, dict[str, Any]] = {}
        self.artifact_seal: dict[str, str] | None = None
        self.events: list[dict[str, Any]] = []
        self.docker_backend_id: str | None = None
        # Harbor RegradeTrial constructs an unused agent environment before
        # replacing the agent with NopAgent. Permit construction only; it must
        # never acquire runtime authority or create containers.
        if self.role == "agent" and self.verifier_source is None:
            if self.key in _AGENTS:
                raise PhaseResourceError("phase_transition_unconfirmed: duplicate agent environment")
            _AGENTS[self.key] = self

    def fail(self, reason: str) -> None:
        # Sticky even if Harbor swallows the exception and a later down succeeds.
        self.failure = self.failure or reason
        self.record("phase_transition_unconfirmed", {"reason": self.failure})

    def check(self) -> None:
        if self.failure is not None:
            raise PhaseResourceError(f"phase_transition_unconfirmed: {self.failure}")

    def record(self, event: str, details: dict[str, Any] | None = None) -> None:
        self.events.append({"event": event, "at": _now(), **(details or {})})
        self.events = self.events[-64:]
        receipt = {"schema_version": "1", "contract": self.contract, "ownership": self.labels,
                   "role": self.role, "session_id": self.session, "events": self.events,
                   "failure": self.failure, "containers": list(self.containers.values()),
                   "artifact_seal": self.artifact_seal, "docker_backend_id": self.docker_backend_id,
                   **({"verifier_source": self.verifier_source} if self.verifier_source else {})}
        _atomic_json(self.trial_dir / f"hitch-phase-resources-{self.role}.json", receipt)

    async def before_start(self) -> None:
        self.check()
        if self.verifier_source is not None and self.role != "verifier":
            raise PhaseResourceError("phase_transition_unconfirmed: verifier source cannot start an agent")
        await self.confirm_backend()
        if self.started:
            raise PhaseResourceError("phase_transition_unconfirmed: environment restart is unsupported")
        if self.role == "agent" and await self.owned_containers():
            raise PhaseResourceError("phase_transition_unconfirmed: previous owned containers remain")
        if self.role == "verifier":
            if self.verifier_source is not None:
                await self.authorize_regrade()
                return
            agent = _AGENTS.get(self.key)
            if (agent is None or agent.contract != self.contract or agent.labels != self.labels
                    or not agent.stopped_confirmed or agent.artifact_seal is None):
                raise PhaseResourceError("phase_transition_unconfirmed: no current agent stop proof")
            agent.check()
            await agent.confirm_stopped()
            if agent.seal_artifacts() != agent.artifact_seal:
                raise PhaseResourceError("phase_transition_unconfirmed: collected artifacts changed")
            self.record("verifier.start-authorized", {"artifact_seal": agent.artifact_seal})

    def validate_compose(self, document: Any) -> None:
        self.check()
        services = document.get("services") if isinstance(document, dict) else None
        expected = {s["name"]: s["replicas"] for s in self.contract[f"{self.role}_services"]}
        if not isinstance(services, dict) or set(services) != set(expected):
            raise PhaseResourceError("phase_transition_unconfirmed: Compose services differ from plan")
        for name, config in services.items():
            deploy = config.get("deploy", {})
            count = config.get("scale", deploy.get("replicas", 1))
            restart = deploy.get("restart_policy", {})
            if (config.get("restart", "no") != "no"
                    or not isinstance(restart, dict) or restart.get("condition", "none") != "none"):
                raise PhaseResourceError("phase_transition_unconfirmed: restart policy is unsupported by phase teardown")
            if (count != expected[name] or isinstance(count, bool)
                    or config.get("profiles") or config.get("external")
                    or any(config.get("labels", {}).get(k) != v for k, v in self.labels.items())):
                raise PhaseResourceError("phase_transition_unconfirmed: Compose identity/replicas differ")

    async def after_start(self) -> None:
        self.check()
        current = await self.owned_containers()
        selected = [c for c in current if c["project"] == self.project]
        expected = {s["name"]: s["replicas"] for s in self.contract[f"{self.role}_services"]}
        counts: dict[str, int] = {}
        for item in selected:
            counts[item["service"]] = counts.get(item["service"], 0) + 1
            self.containers[item["id"]] = item
        if counts != expected:
            raise PhaseResourceError("phase_transition_unconfirmed: created containers differ from plan")
        allowed_old = set(_AGENTS[self.key].containers) if self.role == "verifier" and self.verifier_source is None else set()
        if any(c["project"] != self.project and c["id"] not in allowed_old for c in current):
            raise PhaseResourceError("phase_transition_unconfirmed: unexpected owned container")
        self.started = True
        self.record("environment.started")

    async def before_main_stop(self) -> None:
        if self.role != "agent":
            return
        self.main_stop_attempted = True
        self.check()
        # Capture exact identities before stop, including an unexpectedly alive helper.
        await self.refresh_agent_containers()

    async def after_main_stop(self) -> None:
        if self.role != "agent":
            return
        self.check()
        await self.confirm_stopped(main_only=True)
        self.main_confirmed = True
        self.record("main.stopped-confirmed")

    async def before_sidecar_operation(self, service: str | None, require_main_stop: bool = False) -> None:
        if self.role != "agent" or service in (None, "main"):
            return
        if not self.main_stop_attempted and not require_main_stop:
            return
        self.check()
        if not self.main_confirmed:
            raise PhaseResourceError("phase_transition_unconfirmed: main not quiesced before sidecar collection")
        await self.confirm_stopped(main_only=True)

    async def before_stop(self) -> None:
        if self.role == "agent" and self.started:
            await self.refresh_agent_containers()

    async def after_stop(self) -> None:
        if self.role != "agent" or not self.started:
            return
        self.check()
        await self.confirm_stopped()
        self.artifact_seal = self.seal_artifacts()
        self.stopped_confirmed = True
        self.record("environment.stopped-confirmed")

    async def refresh_agent_containers(self) -> None:
        self.check()
        current = await self.owned_containers()
        if any(c["project"] != self.project or c["id"] not in self.containers for c in current):
            raise PhaseResourceError("phase_transition_unconfirmed: agent container identity changed")
        for item in current:
            self.containers[item["id"]] = item

    async def confirm_stopped(self, main_only: bool = False, *, persist: bool = True) -> None:
        self.check()
        current = await self.owned_containers()
        if any(c["project"] != self.project or c["id"] not in self.containers for c in current):
            raise PhaseResourceError("phase_transition_unconfirmed: unknown container at stop barrier")
        current_by_id = {c["id"]: c for c in current}
        checked = []
        for identity, original in self.containers.items():
            if main_only and original["service"] != "main":
                continue
            item = current_by_id.get(identity)
            if item is None:
                # A filtered ownership listing alone cannot prove that an ID is gone.
                found = await self.docker(["container", "ls", "--all", "--no-trunc", "--filter", f"id={identity}", "--format", "{{.ID}}"])
                if found.strip():
                    raise PhaseResourceError("phase_transition_unconfirmed: stopped container ownership changed")
                checked.append({"id": identity, "state": "removed"})
                continue
            state = item["state"]
            if (state.get("Running") is not False or state.get("Paused") is not False
                    or state.get("Restarting") is not False or state.get("Pid") != 0
                    or state.get("Status") not in ("exited", "dead", "created")):
                raise PhaseResourceError("phase_transition_unconfirmed: container is not stopped")
            checked.append({"id": identity, "state": state["Status"], "pid": 0})
        if main_only and not checked:
            raise PhaseResourceError("phase_transition_unconfirmed: main container was never observed")
        if persist:
            self.record("main.stop-checked" if main_only else "environment.stop-checked", {"checked": checked})

    async def authorize_regrade(self) -> None:
        source_ref = self.verifier_source
        source_dir = Path(source_ref["source_directory"])
        receipt_path = source_dir / "hitch-phase-resources-agent.json"
        if (source_dir.is_symlink() or receipt_path.is_symlink() or not receipt_path.is_file()
                or receipt_path.stat().st_size > 8 * 1024 * 1024):
            raise PhaseResourceError("phase_transition_unconfirmed: regrade source proof is unavailable")
        content = receipt_path.read_bytes()
        if "sha256:" + hashlib.sha256(content).hexdigest() != source_ref["receipt_digest"]:
            raise PhaseResourceError("phase_transition_unconfirmed: regrade source proof changed")
        receipt = json.loads(content)
        if (not isinstance(receipt, dict) or receipt.get("schema_version") != "1"
                or receipt.get("contract") != self.contract or receipt.get("role") != "agent"
                or receipt.get("failure") is not None or not isinstance(receipt.get("events"), list)
                or not any(isinstance(event, dict) and event.get("event") == "environment.stopped-confirmed" for event in receipt["events"])):
            raise PhaseResourceError("phase_transition_unconfirmed: regrade source was not confirmed stopped")
        ownership = receipt.get("ownership")
        if (not isinstance(ownership, dict) or ownership.get("io.hitch.provider") != "local-docker"
                or self.labels.get("io.hitch.provider") != "local-docker"
                or ownership.get("io.hitch.root-id") != self.labels["io.hitch.root-id"]
                or ownership.get("io.hitch.task-id") != self.contract["task_id"]):
            raise PhaseResourceError("phase_transition_unconfirmed: regrade requires the original local Docker node")
        from hitch_harbor_environment import _validate_labels
        ownership = _validate_labels(ownership)
        original = receipt.get("containers")
        seal = receipt.get("artifact_seal")
        if (not isinstance(original, list) or not original or len(original) > 512
                or not isinstance(seal, dict) or set(seal) != {"manifest_digest", "tree_digest"}
                or any(not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in seal.values())
                or receipt.get("session_id") != source_dir.name + "__env"):
            raise PhaseResourceError("phase_transition_unconfirmed: invalid regrade source evidence")
        source = object.__new__(PhaseResourceBarrier)
        source.environment = self.environment
        source.contract, source.labels, source.trial_dir = self.contract, ownership, source_dir
        source.failure, source.containers = None, {}
        source.project = _project_name(receipt["session_id"])
        source.docker_backend_id = receipt.get("docker_backend_id")
        if not isinstance(source.docker_backend_id, str) or source.docker_backend_id != self.docker_backend_id:
            raise PhaseResourceError("phase_transition_unconfirmed: regrade Docker daemon differs")
        expected = {item["name"]: item["replicas"] for item in self.contract["agent_services"]}
        counts: dict[str, int] = {}
        for container in original:
            if (not isinstance(container, dict) or not isinstance(container.get("id"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", container["id"])
                    or container["id"] in source.containers or container.get("project") != source.project
                    or container.get("service") not in expected):
                raise PhaseResourceError("phase_transition_unconfirmed: invalid regrade source container identity")
            source.containers[container["id"]] = container
            counts[container["service"]] = counts.get(container["service"], 0) + 1
        if counts != expected:
            raise PhaseResourceError("phase_transition_unconfirmed: incomplete regrade source container identity")
        await source.confirm_stopped(persist=False)
        if source.seal_artifacts() != seal or self.seal_artifacts() != seal:
            raise PhaseResourceError("phase_transition_unconfirmed: regrade artifact handoff changed")
        self.artifact_seal = seal
        self.record("verifier.regrade-authorized", {"source_receipt_digest": source_ref["receipt_digest"]})

    async def owned_containers(self) -> list[dict[str, Any]]:
        await self.confirm_backend()
        command = ["container", "ls", "--all", "--no-trunc"]
        for key in ("io.hitch.root-id", "io.hitch.lease-id", "io.hitch.lease-epoch"):
            value = self.labels[key]
            command.extend(["--filter", f"label={key}={value}"])
        command.extend(["--format", "{{.ID}}"])
        ids = (await self.docker(command)).split()
        if len(ids) > 512 or len(ids) != len(set(ids)) or any(not re.fullmatch(r"[a-f0-9]{64}", i) for i in ids):
            raise PhaseResourceError("phase_transition_unconfirmed: invalid Docker ownership inventory")
        result = []
        for identity in ids:
            raw = json.loads(await self.docker(["container", "inspect", "--format",
                '{"id":{{json .Id}},"state":{{json .State}},"labels":{{json .Config.Labels}}}', identity]))
            labels = raw.get("labels", {})
            if raw.get("id") != identity or any(labels.get(k) != v for k, v in self.labels.items()):
                raise PhaseResourceError("phase_transition_unconfirmed: Docker ownership changed")
            if labels.get("com.docker.compose.oneoff", "False").lower() != "false":
                raise PhaseResourceError("phase_transition_unconfirmed: unexpected one-off container")
            state = raw.get("state", {})
            if not isinstance(state, dict):
                raise PhaseResourceError("phase_transition_unconfirmed: invalid Docker state")
            # Healthcheck logs / daemon error strings can contain task output.
            # Retain only the fields required by the stop proof.
            state = {key: state.get(key) for key in ("Running", "Paused", "Restarting", "Pid", "Status")}
            result.append({"id": identity, "project": labels.get("com.docker.compose.project"),
                           "service": labels.get("com.docker.compose.service"), "state": state})
        return result

    async def confirm_backend(self) -> None:
        identity = (await self.docker(["info", "--format", "{{.ID}}"])).strip()
        if not re.fullmatch(r"[a-zA-Z0-9:_.-]{8,256}", identity):
            raise PhaseResourceError("phase_transition_unconfirmed: Docker daemon identity is unavailable")
        if self.docker_backend_id is None:
            self.docker_backend_id = identity
            # Persist the execution node before any container can be created.
            # Cleanup/recovery must not interpret an empty different daemon as
            # proof that this node's resources have disappeared.
            self.record("environment.backend-bound")
        elif self.docker_backend_id != identity:
            raise PhaseResourceError("phase_transition_unconfirmed: Docker daemon identity changed")

    async def docker(self, args: list[str]) -> str:
        process = await asyncio.create_subprocess_exec("docker", *args,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=15)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        if process.returncode != 0 or len(stdout) > 4 * 1024 * 1024:
            raise PhaseResourceError("phase_transition_unconfirmed: Docker state could not be confirmed")
        return stdout.decode("utf-8")

    def seal_artifacts(self) -> dict[str, str]:
        root = self.trial_dir / "artifacts"
        manifest = root / "manifest.json"
        if root.is_symlink() or not root.is_dir() or manifest.is_symlink() or not manifest.is_file():
            raise PhaseResourceError("phase_transition_unconfirmed: artifact manifest is unavailable")
        content = manifest.read_bytes()
        if len(content) > 8 * 1024 * 1024:
            raise PhaseResourceError("phase_transition_unconfirmed: artifact manifest is too large")
        entries = json.loads(content)
        if not isinstance(entries, list) or len(entries) > 4096:
            raise PhaseResourceError("phase_transition_unconfirmed: invalid artifact manifest")
        successful = set()
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("status") not in ("ok", "empty", "skipped"):
                raise PhaseResourceError("phase_transition_unconfirmed: artifact collection failed")
            service = entry.get("service") or "main"
            destination = entry.get("destination")
            if not isinstance(destination, str):
                raise PhaseResourceError("phase_transition_unconfirmed: invalid artifact destination")
            relative = PurePosixPath(destination)
            if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != "artifacts":
                raise PhaseResourceError("phase_transition_unconfirmed: artifact escaped its storage")
            target = self.trial_dir.joinpath(*relative.parts)
            if entry["status"] in ("ok", "empty"):
                if (entry.get("type") not in ("file", "directory")
                        or not target.exists() or target.is_symlink()
                        or (entry["type"] == "file" and not target.is_file())
                        or (entry["type"] == "directory" and not target.is_dir())
                        or (entry["status"] == "empty" and entry["type"] != "directory")):
                    raise PhaseResourceError("phase_transition_unconfirmed: collected artifact is missing")
                successful.add((service, entry.get("source")))
        if any((a["service"], a["path"]) not in successful for a in self.contract["artifacts"]):
            raise PhaseResourceError("phase_transition_unconfirmed: required artifact was not collected")
        digest = hashlib.sha256()
        for entry in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
            info = entry.lstat()
            relative = entry.relative_to(root).as_posix()
            if stat.S_ISDIR(info.st_mode):
                digest.update(json.dumps([relative, "directory"]).encode() + b"\n")
            elif stat.S_ISREG(info.st_mode):
                file_digest = hashlib.sha256()
                with entry.open("rb") as handle:
                    while chunk := handle.read(1024 * 1024):
                        file_digest.update(chunk)
                digest.update(json.dumps([relative, "file", file_digest.hexdigest()]).encode() + b"\n")
            else:
                raise PhaseResourceError("phase_transition_unconfirmed: artifact tree has non-regular entries")
        return {"manifest_digest": "sha256:" + hashlib.sha256(content).hexdigest(),
                "tree_digest": "sha256:" + digest.hexdigest()}


def _verifier_session(trial_name: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-._" else "_" for c in f"{trial_name}__verifier__trial")
    if len(safe) <= 63:
        return safe
    suffix = "__" + hashlib.sha1(safe.encode()).hexdigest()[:8]
    return safe[:63 - len(suffix)].rstrip("-._") + suffix


def _project_name(session: str) -> str:
    value = session.lower()
    if not re.match(r"^[a-z0-9]", value):
        value = "0" + value
    return re.sub(r"[^a-z0-9_-]", "-", value)


def _validate_verifier_source(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != {"schema_version", "source_directory", "receipt_digest"}
            or value["schema_version"] != "1" or not isinstance(value["source_directory"], str)
            or not Path(value["source_directory"]).is_absolute()
            or ".." in Path(value["source_directory"]).parts
            or not isinstance(value["receipt_digest"], str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["receipt_digest"])):
        raise PhaseResourceError("phase_transition_unconfirmed: invalid verifier source handoff")
    return dict(value)


def _atomic_json(target: Path, value: Any) -> None:
    if target.is_symlink():
        raise PhaseResourceError("phase_transition_unconfirmed: invalid receipt destination")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".hitch-phase-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
