"""CI semantics for Hitch's enter-only hook; the manual canary uses real Harbor."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace


class Trial:
    pass


@asynccontextmanager
async def original(trial, *, enter_error=None, exit_error=None, suppress=False):
    try:
        if enter_error is not None:
            raise enter_error
        try:
            yield "environment"
        except ValueError:
            if not suppress:
                raise
    finally:
        trial.exits += 1
        if exit_error is not None:
            raise exit_error


Trial._separate_verifier_env = original
for name in ("harbor", "harbor.constants", "harbor.environments", "harbor.environments.docker",
             "harbor.environments.docker.docker", "harbor.trial", "harbor.trial.trial"):
    sys.modules[name] = ModuleType(name)
sys.modules["yaml"] = ModuleType("yaml")
sys.modules["harbor.constants"].MAIN_SERVICE_NAME = "main"
sys.modules["harbor.environments.docker.docker"].DockerEnvironment = object
sys.modules["harbor.trial.trial"].Trial = Trial
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_harbor_environment as provider


def trial(managed=True):
    result = Trial()
    result.exits = 0
    result._environment_build_timeout_sec = 600.0
    result.config = SimpleNamespace(environment=SimpleNamespace(import_path=(
        "hitch_harbor_environment:HitchHarborDockerEnvironment" if managed else "native:Environment")))
    return result


async def expect_error(instance, error, expected, *, in_body=False, exit_error=False):
    try:
        kwargs = {} if in_body else {"exit_error" if exit_error else "enter_error": error}
        async with instance._separate_verifier_env(**kwargs):
            if in_body:
                raise error
    except BaseException as caught:
        assert type(caught) is expected, (type(caught), expected)
        assert instance.exits == 1
        return caught
    raise AssertionError("expected failure")


async def main():
    installed = Trial._separate_verifier_env
    provider._install_verifier_start_timeout_hook()
    assert Trial._separate_verifier_env is installed
    instance = trial()
    async with instance._separate_verifier_env() as environment:
        assert environment == "environment"
    assert instance.exits == 1
    error = asyncio.TimeoutError("internal probe timed out after 15 seconds")
    caught = await expect_error(trial(), error, provider.VerifierEnvironmentStartTimeoutError)
    assert caught.__cause__ is error
    assert "environment build budget: 600.0 seconds" in str(caught)
    assert not isinstance(caught, asyncio.TimeoutError)
    error = RuntimeError("compose build failed at a useful step")
    caught = await expect_error(trial(), error, provider.VerifierEnvironmentStartError)
    assert caught.__cause__ is error and "useful step" in str(caught.__cause__)
    for managed, in_body, exiting in ((False, False, False), (True, True, False), (True, False, True)):
        error = asyncio.TimeoutError("original timeout")
        caught = await expect_error(trial(managed), error, asyncio.TimeoutError, in_body=in_body, exit_error=exiting)
        assert caught is error
    for in_body in (False, True):
        error = asyncio.CancelledError("external cancellation")
        assert await expect_error(trial(), error, asyncio.CancelledError, in_body=in_body) is error
    instance = trial()
    async with instance._separate_verifier_env(suppress=True):
        raise ValueError("suppressed by original context manager")
    assert instance.exits == 1
    print("10 enter/body/exit/cancellation/context-manager hook checks passed")


if __name__ == "__main__":
    asyncio.run(main())
