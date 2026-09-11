"""CPU-only Harbor 0.21 compose transport contract for private Target env."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path


class ExecResult:
    def __init__(self, stdout=None, stderr=None, return_code=0):
        self.stdout = stdout
        self.stderr = stderr
        self.return_code = return_code


def install_harbor_stubs() -> None:
    harbor = types.ModuleType("harbor")
    environments = types.ModuleType("harbor.environments")
    base = types.ModuleType("harbor.environments.base")
    docker_package = types.ModuleType("harbor.environments.docker")
    docker = types.ModuleType("harbor.environments.docker.docker")
    base.ExecResult = ExecResult
    docker._sanitize_docker_compose_project_name = lambda value: "".join(
        character if character.isalnum() or character in "-_" else "-"
        for character in value.lower()
    )
    for module in (harbor, environments, base, docker_package, docker):
        module.__package__ = module.__name__
        sys.modules[module.__name__] = module
    harbor.environments = environments
    environments.base = base
    environments.docker = docker_package
    docker_package.docker = docker


class Platform:
    @staticmethod
    def exec_shell_args(command):
        return ["bash", "-lc", command]


class Environment:
    def __init__(self, directory: Path, credential_name: str) -> None:
        self.session_id = "Trial.ID"
        self.environment_dir = directory / "environment"
        self.environment_dir.mkdir()
        self._docker_compose_paths = [directory / "base.yaml", directory / "task.yaml"]
        for compose_path in self._docker_compose_paths:
            compose_path.write_text("services: {}\n", encoding="utf-8")
        self.task_env_config = types.SimpleNamespace(workdir="/workspace")
        self._platform = Platform()
        self.default_user = 1000
        self.credential_name = credential_name

    def _resolve_user(self, user):
        return self.default_user if user is None else user

    def _merge_env(self, _env):
        return {"STATIC_AGENT_SETTING": "kept", self.credential_name: "stale-target-access"}

    @staticmethod
    def _compose_env_vars(include_os_env=True):
        assert include_os_env is True
        return {"COMPOSE_INFRA": "yes"}


class Process:
    def __init__(self, output: bytes = b"", delay: float = 0) -> None:
        self.output = output
        self.delay = delay
        self.returncode = None
        self.terminated = False
        self.killed = False

    async def communicate(self):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.returncode is None:
            self.returncode = 7
        return self.output, None

    def terminate(self):
        self.terminated = True
        self.returncode = 143

    def kill(self):
        self.killed = True
        self.returncode = 137

    async def wait(self):
        return self.returncode


def load_module(source: Path):
    spec = importlib.util.spec_from_file_location("hitch_private_exec", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def main(source: Path) -> None:
    install_harbor_stubs()
    module = load_module(source)
    credential_name = "DSH_OPENAI_CODEX_ACCESS_B64"
    decoded_access = "opaque-secret-private-exec-123456789"
    envelope = base64.b64encode(json.dumps({"access": decoded_access}).encode()).decode()
    original = os.environ.get(credential_name)
    os.environ[credential_name] = "stale-host-access"
    try:
        with tempfile.TemporaryDirectory(prefix="hitch-private-exec-") as temporary:
            directory = Path(temporary)
            environment = Environment(directory, credential_name)
            calls = []
            success_process = Process(f"Harbor error {envelope} {decoded_access}\n".encode())

            async def success_spawn(*argv, **kwargs):
                calls.append((argv, kwargs))
                return success_process

            module.asyncio.create_subprocess_exec = success_spawn
            result = await module.exec_with_private_environment(
                environment,
                "node /opt/hitch/bin/hitch.js run",
                env={credential_name: envelope},
                cwd="/work",
                user=1001,
            )
            assert len(calls) == 1
            argv, kwargs = calls[0]
            expected = (
                "docker", "compose", "--project-name", "trial-id", "--project-directory",
                str(environment.environment_dir.resolve().absolute()),
                "-f", str(environment._docker_compose_paths[0].resolve().absolute()),
                "-f", str(environment._docker_compose_paths[1].resolve().absolute()),
                "exec", "-w", "/work",
                "-e", credential_name, "-e", "STATIC_AGENT_SETTING",
                "-u", "1001", "main", "bash", "-lc", "node /opt/hitch/bin/hitch.js run",
            )
            assert argv == expected, argv
            serialized_argv = "\0".join(argv)
            assert envelope not in serialized_argv and decoded_access not in serialized_argv
            assert "stale-target-access" not in serialized_argv
            assert kwargs["env"][credential_name] == envelope
            assert kwargs["env"]["STATIC_AGENT_SETTING"] == "kept"
            assert result.return_code == 7
            assert envelope not in result.stdout and decoded_access not in result.stdout
            assert result.stdout.count("[REDACTED]") == 2

            timeout_process = Process(delay=1)

            async def timeout_spawn(*_argv, **_kwargs):
                return timeout_process

            module.asyncio.create_subprocess_exec = timeout_spawn
            try:
                await asyncio.wait_for(module.exec_with_private_environment(
                    environment, "target", env={credential_name: envelope}, timeout_sec=0.01,
                ), timeout=2)
            except RuntimeError as error:
                assert str(error) == "private Target execution timed out"
                assert envelope not in str(error) and decoded_access not in str(error)
            else:
                raise AssertionError("private exec timeout unexpectedly succeeded")
            assert timeout_process.terminated or timeout_process.killed

            cancel_process = Process(delay=10)

            async def cancel_spawn(*_argv, **_kwargs):
                return cancel_process

            module.asyncio.create_subprocess_exec = cancel_spawn
            execution = asyncio.create_task(module.exec_with_private_environment(
                environment, "target", env={credential_name: envelope},
            ))
            await asyncio.sleep(0)
            execution.cancel()
            try:
                await asyncio.wait_for(execution, timeout=2)
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("private exec cancellation was swallowed")
            assert cancel_process.terminated or cancel_process.killed
            assert os.environ[credential_name] == "stale-host-access"
    finally:
        if original is None:
            os.environ.pop(credential_name, None)
        else:
            os.environ[credential_name] = original

    print("Harbor private exec smoke OK")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
