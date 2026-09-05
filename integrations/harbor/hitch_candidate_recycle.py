"""Retire a candidate container without resetting the benchmark's sidecars.

Trusted host API only. The caller must revoke the old tool binding and finish
exporting the old run before calling this API, then reinstall the harness and
bind the next run before starting a model. Receipts prove environment changes,
not model conversation freshness, phase completion, or benchmark correctness.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any


class CandidateRecycleError(RuntimeError):
    pass


def _overlaps(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def _directory(path: Path) -> Path:
    absolute = path.absolute()
    if absolute.resolve(strict=True) != absolute or not absolute.is_dir():
        raise CandidateRecycleError("Candidate phase paths must be real directories without symlinks")
    return absolute


def _write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(".pending")
    with temporary.open("x", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


async def _docker(arguments: list[str]) -> str:
    process = await asyncio.create_subprocess_exec(
        "docker", *arguments, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=60)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        # Docker errors can contain environment values. Never journal them.
        raise CandidateRecycleError("Candidate Docker inspection failed")
    return stdout.decode("utf-8")


_INSPECT = ('{"id":{{json .Id}},"image":{{json .Image}},'
            '"state":{{json .State.Status}},"started_at":{{json .State.StartedAt}},'
            '"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},'
            '"host":{{json .HostConfig}},"config":{{json .Config}}}')


def _configuration_digest(container: dict[str, Any]) -> str:
    # Compare configuration without persisting potentially secret environment
    # values. Compose regenerates its own config-hash on the image-pin overlay.
    config = dict(container["config"])
    config.pop("Image", None)
    config.pop("Hostname", None)
    environment = config.get("Env") or []
    # Docker/Compose may reorder map-derived env and bind lists. Unique env
    # keys have no ordering semantics; duplicate keys must retain their order.
    if len({entry.split("=", 1)[0] for entry in environment}) == len(environment):
        config["Env"] = sorted(environment)
    config["Labels"] = {key: value for key, value in (config.get("Labels") or {}).items()
                        if not key.startswith("com.docker.compose.") and key != "io.hitch.candidate-phase"}
    host = dict(container["host"])
    # These two are generated per container by Docker, not requested resources.
    host.pop("ContainerIDFile", None)
    if host.get("Binds"):
        host["Binds"] = sorted(host["Binds"])
    digest = hashlib.sha256(json.dumps([config, host], sort_keys=True).encode()).hexdigest()
    return f"sha256:{digest}"


class CandidateRecycler:
    def __init__(self, environment: Any):
        self.environment = environment
        self.lock = asyncio.Lock()

    async def _compose(self, arguments: list[str]) -> str:
        result = await self.environment._run_docker_compose_command(
            arguments, check=False, timeout_sec=60
        )
        if result.return_code:
            raise CandidateRecycleError("Candidate Compose operation failed; trial cleanup required")
        return result.stdout or ""

    async def _containers(self) -> dict[str, dict[str, Any]]:
        ids = (await self._compose(["ps", "--all", "--quiet"])).split()
        if not ids or len(ids) > 64 or any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in ids):
            raise CandidateRecycleError("Candidate project container inventory is invalid")
        documents = await _docker(["inspect", "--format", _INSPECT, *ids])
        containers: dict[str, dict[str, Any]] = {}
        ownership = self.environment._hitch_ownership_labels
        if not ownership:
            raise CandidateRecycleError("Candidate recycling requires Hitch lease ownership")
        projects = set()
        for line in documents.splitlines():
            item = json.loads(line)
            labels = item["labels"] or {}
            if any(labels.get(key) != value for key, value in ownership.items()):
                raise CandidateRecycleError("Candidate project lease ownership changed")
            service = labels.get("com.docker.compose.service")
            projects.add(labels.get("com.docker.compose.project"))
            if not service or service in containers or labels.get("com.docker.compose.oneoff", "False").lower() != "false":
                raise CandidateRecycleError("Candidate recycling requires one container per service")
            containers[service] = item
        if len(containers) != len(ids) or "main" not in containers or len(projects) != 1 or None in projects:
            raise CandidateRecycleError("Candidate project inventory is incomplete")
        return containers

    @staticmethod
    def _sidecars(containers: dict[str, dict[str, Any]]) -> dict[str, Any]:
        result = {}
        for service, item in containers.items():
            if service != "main":
                if item["state"] != "running":
                    raise CandidateRecycleError("A benchmark sidecar is not running")
                result[service] = {"id": item["id"], "image": item["image"], "started_at": item["started_at"]}
        return result

    def _mounts(self, containers: dict[str, dict[str, Any]], archive: Path) -> dict[str, Path]:
        paths = self.environment.trial_paths
        allowed = {"/logs/agent": paths.agent_dir, "/logs/verifier": paths.verifier_dir,
                   "/logs/artifacts": paths.artifacts_dir}
        main = containers["main"]
        host = main["host"]
        if (host.get("Privileged") or host.get("VolumesFrom") or host.get("Devices") or host.get("CapAdd")
                or host.get("PidMode") or host.get("IpcMode") in ("host",) or str(host.get("IpcMode", "")).startswith("container:")
                or host.get("NetworkMode") == "host"):
            raise CandidateRecycleError("Candidate container isolation configuration is unsupported")
        writable = {}
        all_sources = []
        for mount in main["mounts"]:
            if mount["Type"] == "tmpfs":
                continue  # Recreated with the container.
            if mount["Type"] != "bind":
                raise CandidateRecycleError("Persistent candidate volumes are unsupported for phase recycling")
            source = Path(mount["Source"]).absolute()
            if source.resolve(strict=True) != source:
                raise CandidateRecycleError("Candidate mount source contains a symlink")
            if not source.is_file() and not source.is_dir():
                raise CandidateRecycleError("Special-file candidate mounts are unsupported")
            if _overlaps(source, archive):
                raise CandidateRecycleError("Candidate can access the phase archive")
            all_sources.append(source)
            if mount["RW"]:
                target = mount["Destination"]
                if target not in allowed or source != Path(allowed[target]).absolute():
                    raise CandidateRecycleError("Only Harbor trial log directories may be writable candidate mounts")
                writable[target] = _directory(source)
        if ("/logs/agent" not in writable or len(set(writable.values())) != len(writable)
                or len({source.name for source in writable.values()}) != len(writable)):
            raise CandidateRecycleError("Candidate phase log mounts are missing or aliased")
        for source in writable.values():
            if sum(_overlaps(source, other) for other in all_sources) != 1:
                raise CandidateRecycleError("Candidate mount paths overlap")
            for service, item in containers.items():
                if service != "main" and any(mount["Type"] == "bind" and _overlaps(source, Path(mount["Source"])) for mount in item["mounts"]):
                    raise CandidateRecycleError("Candidate logs are shared with a persistent service")
        return writable

    async def recycle(self, phase_index: int) -> dict[str, Any]:
        if type(phase_index) is not int or not 1 <= phase_index <= 9999:
            raise CandidateRecycleError("Candidate phase index must be an integer from 1 to 9999")
        async with self.lock:
            if getattr(self.environment, "_is_windows_container", False):
                raise CandidateRecycleError("Candidate recycling supports Linux containers only")
            trial = _directory(self.environment.trial_paths.trial_dir)
            root = trial / "hitch-candidate-phases"
            before = await self._containers()
            mounts = self._mounts(before, root)
            sidecars = self._sidecars(before)
            phase = root / f"phase-{phase_index:04d}"
            receipt_path = phase / "receipt.json"
            root.mkdir(mode=0o700, exist_ok=True)
            _directory(root)
            if root.stat().st_mode & 0o077:
                raise CandidateRecycleError("Candidate phase archive must be private to the host controller")
            if receipt_path.exists():
                _directory(phase)
                if receipt_path.is_symlink():
                    raise CandidateRecycleError("Candidate phase receipt is a symlink")
                receipt = json.loads(receipt_path.read_text())
                if (receipt.get("status") != "completed" or receipt.get("new_container_id") != before["main"]["id"]
                        or receipt.get("sidecars") != sidecars or receipt.get("ownership") != self.environment._hitch_ownership_labels):
                    raise CandidateRecycleError("Candidate recycle receipt is stale or incomplete; cleanup required")
                return receipt
            if phase.exists():
                raise CandidateRecycleError("Candidate phase archive already exists; cleanup required")
            existing = sorted(item.name for item in root.iterdir())
            if existing != [f"phase-{index:04d}" for index in range(1, phase_index)]:
                raise CandidateRecycleError("Candidate phases must be recycled consecutively")
            if phase_index > 1:
                previous = json.loads((root / f"phase-{phase_index - 1:04d}" / "receipt.json").read_text())
                if (previous.get("status") != "completed" or previous.get("new_container_id") != before["main"]["id"]
                        or previous.get("sidecars") != sidecars or previous.get("image") != before["main"]["image"]):
                    raise CandidateRecycleError("Previous candidate replacement is not complete")
            main = before["main"]
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", main["image"]):
                raise CandidateRecycleError("Candidate image identity is invalid")
            phase.mkdir(mode=0o700)
            receipt = {"schema_version": "hitch-candidate-recycle@1", "scope": "environment-only",
                       "phase_index": phase_index, "status": "prepared", "old_container_id": main["id"],
                       "image": main["image"], "configuration_digest": _configuration_digest(main),
                       "ownership": dict(self.environment._hitch_ownership_labels), "sidecars": sidecars,
                       "archives": {target: f"phase-{phase_index:04d}/{source.name}" for target, source in mounts.items()}}
            _write_json(receipt_path, receipt)
            try:
                # Deliberately bypass stop_service(): that hook snapshots the
                # entire benchmark and would terminate the native phase loop.
                await self._compose(["rm", "--stop", "--force", "--volumes", "main"])
                remaining = set((await _docker(["ps", "--all", "--no-trunc", "--quiet"])).split())
                if main["id"] in remaining:
                    raise CandidateRecycleError("Previous candidate container still exists")
                receipt["status"] = "retired"
                _write_json(receipt_path, receipt)
                for source in mounts.values():
                    _directory(source)
                    mode = source.stat().st_mode & 0o777
                    source.rename(phase / source.name)
                    source.mkdir(mode=mode)
                    source.chmod(mode)
                receipt["status"] = "archived"
                _write_json(receipt_path, receipt)
                overlay = phase / "replacement.json"
                _write_json(overlay, {"services": {"main": {"image": main["image"], "labels": {"io.hitch.candidate-phase": str(phase_index + 1)}}}})
                self.environment._hitch_phase_compose_path = overlay
                await self._compose(["up", "--detach", "--wait", "--wait-timeout", "45", "--no-deps", "--no-build", "--pull", "never", "main"])
                after = await self._containers()
                next_main = after["main"]
                checks = {"new-container": next_main["id"] != main["id"], "image": next_main["image"] == main["image"],
                          "running": next_main["state"] == "running", "configuration": _configuration_digest(next_main) == receipt["configuration_digest"],
                          "sidecars": self._sidecars(after) == sidecars, "mounts": self._mounts(after, root) == mounts}
                failed_checks = [name for name, passed in checks.items() if not passed]
                if failed_checks:
                    raise CandidateRecycleError("Replacement changed the benchmark environment contract: " + ", ".join(failed_checks))
                await self.environment.ensure_dirs(list(mounts))
                await self.environment._upload_environment_dir_after_start()
                receipt.update(status="completed", new_container_id=next_main["id"])
                _write_json(receipt_path, receipt)
                return receipt
            except BaseException as error:
                receipt.update(status="failed", failure_type=type(error).__name__)
                _write_json(receipt_path, receipt)
                raise
