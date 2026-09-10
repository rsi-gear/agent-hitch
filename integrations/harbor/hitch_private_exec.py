"""Run one Docker Target with per-exec secrets absent from process argv."""

from __future__ import annotations

import asyncio
import base64
import json
import re
from typing import Any

from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import _sanitize_docker_compose_project_name

_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


async def exec_with_private_environment(
    environment: Any,
    command: str,
    *,
    env: dict[str, str],
    cwd: str | None = None,
    timeout_sec: int | None = None,
    user: str | int | None = None,
) -> ExecResult:
    """Pass values through the compose client's environment and only names in argv."""
    if (
        not isinstance(env, dict)
        or not env
        or any(
            not isinstance(name, str)
            or _ENVIRONMENT_NAME.fullmatch(name) is None
            or not isinstance(value, str)
            or not value
            or "\0" in value
            for name, value in env.items()
        )
    ):
        raise RuntimeError("private Target environment is invalid")

    resolved_user = environment._resolve_user(user)
    # Preserve Harbor's persistent and task-scoped agent environment, then let
    # the fresh helper values replace the deliberately blank startup values.
    target_environment = dict(environment._merge_env(None) or {})
    target_environment.update(env)
    exec_command = ["exec"]
    effective_cwd = cwd or environment.task_env_config.workdir
    if effective_cwd:
        exec_command.extend(["-w", effective_cwd])
    for name in sorted(target_environment):
        # Docker Compose resolves a name without `=value` from its own process
        # environment. The secret therefore never appears in host process argv.
        exec_command.extend(["-e", name])
    if resolved_user is not None:
        exec_command.extend(["-u", str(resolved_user)])
    exec_command.append("main")
    exec_command.extend(environment._platform.exec_shell_args(command))

    full_command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for compose_path in environment._docker_compose_paths:
        full_command.extend(["-f", str(compose_path.resolve().absolute())])
    full_command.extend(exec_command)

    host_environment = environment._compose_env_vars(include_os_env=True)
    host_environment.update(target_environment)
    process = await asyncio.create_subprocess_exec(
        *full_command,
        env=host_environment,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        if timeout_sec is None:
            stdout, stderr = await process.communicate()
        else:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        await _terminate_compose_client(process)
        raise RuntimeError("private Target execution timed out") from None
    except BaseException:
        # Match Harbor 0.21's compose-exec cleanup. The surrounding trial still
        # owns Target teardown; stopping this client alone is not treated as
        # proof that the command or container has stopped.
        await _terminate_compose_client(process)
        raise
    secrets = sorted(
        {secret for name, value in env.items() for secret in _credential_secrets(name, value)},
        key=len,
        reverse=True,
    )
    stdout_text = _redact(stdout.decode(errors="replace") if stdout else None, secrets)
    stderr_text = _redact(stderr.decode(errors="replace") if stderr else None, secrets)
    return ExecResult(
        stdout=stdout_text,
        stderr=stderr_text,
        return_code=process.returncode or 0,
    )


async def _terminate_compose_client(process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _redact(value: str | None, secrets: list[str]) -> str | None:
    if value is None:
        return None
    for secret in secrets:
        value = value.replace(secret, "[REDACTED]")
    return value


def _credential_secrets(name: str, value: str) -> list[str]:
    secrets = [value]
    if not name.endswith("_B64") or len(value) > 512 * 1024:
        return secrets
    try:
        decoded = base64.b64decode(value, validate=True)
        if len(decoded) > 256 * 1024:
            return secrets
        parsed = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return secrets

    def collect(entry):
        if isinstance(entry, str) and len(entry) >= 16:
            secrets.append(entry)
        elif isinstance(entry, dict):
            for nested in entry.values():
                collect(nested)
        elif isinstance(entry, list):
            for nested in entry:
                collect(nested)

    collect(parsed)
    return secrets
