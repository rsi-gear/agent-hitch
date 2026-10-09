"""Read-only, evaluation-local installation snapshots for Harbor main services.

This changes transport, not content authentication. The bridge and in-container
Hitch keep their existing pinned manifest and payload checks.
"""
from __future__ import annotations

import asyncio
import json
import posixpath
import re
from pathlib import Path
from typing import Any

CONTROLLER_TARGET = "/opt/hitch"
ARTIFACT_TARGET = "/opt/hitch-harness-artifact"
TARGETS = (CONTROLLER_TARGET, ARTIFACT_TARGET)


def candidate_session(session_id: str, trial_name: str | None = None) -> bool:
    # Verifier names can be truncated before their role marker, or end in
    # '__env' when a multi-step task uses 'env' as its verifier step name.
    # Harbor gives both roles the same TrialPaths, so bind to that exact trial.
    if trial_name is not None:
        return session_id == f"{trial_name}__env"
    return session_id.endswith("__env") and "__verifier__" not in session_id


def configure(raw: Any, session_id: str, trial_name: str | None = None) -> dict[str, str] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {"runtime_directory", "artifact_directory"}:
        raise ValueError("shared runtime transport metadata is invalid")
    for value in raw.values():
        if not isinstance(value, str) or not Path(value).is_absolute() or any(ord(c) < 32 for c in value):
            raise ValueError("shared runtime transport requires absolute host paths")
    # Harbor also forwards environment kwargs to separate verifier containers.
    # Only the candidate session receives harness code.
    if not candidate_session(session_id, trial_name):
        return None
    result = {
        CONTROLLER_TARGET: str(Path(raw["runtime_directory"]) / "payload"),
        ARTIFACT_TARGET: raw["artifact_directory"],
    }
    for source in result.values():
        if not Path(source).is_dir() or Path(source).is_symlink():
            raise ValueError("shared runtime snapshot must be an existing regular directory")
    return result


def reject_conflicts(config: dict[str, Any]) -> None:
    if config.get("privileged") or any(str(cap).upper().removeprefix("CAP_") in {"ALL", "SYS_ADMIN"} for cap in (config.get("cap_add") or [])):
        raise ValueError("shared runtime requires an unprivileged candidate without CAP_SYS_ADMIN")
    for mount in config.get("volumes", []):
        if isinstance(mount, dict):
            target = mount.get("target")
        elif isinstance(mount, str):
            parts = mount.split(":")
            target = parts[1] if len(parts) > 1 else parts[0]
        else:
            raise ValueError("shared runtime cannot validate candidate mounts")
        if not isinstance(target, str):
            raise ValueError("shared runtime cannot validate candidate mount target")
        target = posixpath.normpath(target)
        if any(target == reserved or target.startswith(reserved + "/") for reserved in TARGETS):
            raise ValueError("task mount conflicts with a shared runtime installation")


def compose_mounts(sources: dict[str, str]) -> list[dict[str, Any]]:
    return [{"type": "bind", "source": source.replace("$", "$$"), "target": target,
             "read_only": True, "bind": {"create_host_path": False}}
            for target, source in sources.items()]


def validate_mounts(inspected: Any, expected: dict[str, str]) -> None:
    if not isinstance(inspected, dict) or not isinstance(inspected.get("mounts"), list):
        raise RuntimeError("shared runtime Docker mount inspection is invalid")
    if inspected.get("privileged") or any(str(c).upper().removeprefix("CAP_") in {"ALL", "SYS_ADMIN"} for c in (inspected.get("cap_add") or [])):
        raise RuntimeError("shared runtime requires an unprivileged candidate without CAP_SYS_ADMIN")
    found = {}
    for mount in inspected["mounts"]:
        target = mount.get("Destination", "")
        if any(target.startswith(reserved + "/") for reserved in TARGETS):
            raise RuntimeError("nested mount shadows a shared runtime installation")
        if target in expected:
            if target in found or mount.get("Type") != "bind" or mount.get("RW") is not False:
                raise RuntimeError("shared runtime installation is not a unique read-only bind mount")
            if mount.get("Source") != expected[target]:
                raise RuntimeError("shared runtime bind source does not match its job")
            found[target] = mount
    if set(found) != set(expected):
        raise RuntimeError("shared runtime installation mount is missing")


async def verify_environment(environment: Any, controller_payload: Path, artifact_directory: Path) -> bool:
    expected = environment._hitch_shared_runtime
    if expected is None:
        return False
    if expected != {CONTROLLER_TARGET: str(controller_payload), ARTIFACT_TARGET: str(artifact_directory)}:
        raise RuntimeError("shared runtime environment and agent handoff disagree")
    result = await environment._run_docker_compose_command(["ps", "--all", "--quiet", "main"])
    identity = result.stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise RuntimeError("shared runtime requires exactly one candidate container")
    template = '{"mounts":{{json .Mounts}},"privileged":{{json .HostConfig.Privileged}},"cap_add":{{json .HostConfig.CapAdd}}}'
    process = await asyncio.create_subprocess_exec(
        "docker", "inspect", "--format", template, identity,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), 30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode != 0 or len(stdout) > 1024 * 1024:
        raise RuntimeError("shared runtime Docker mount inspection failed")
    validate_mounts(json.loads(stdout), expected)
    return True
