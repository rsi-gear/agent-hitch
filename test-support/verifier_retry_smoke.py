#!/usr/bin/env python3
"""Behavioral smoke test for the Harbor verifier wrapper without Harbor installed."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace


class FakeVerifierResult:
    def __init__(self, *, rewards: dict[str, float]) -> None:
        self.rewards = rewards


class FakeEnvironmentPaths:
    verifier_dir = Path("/logs/verifier")

    @classmethod
    def for_os(cls, _os: object) -> "FakeEnvironmentPaths":
        return cls()


class FakeBaseVerifier:
    def __init__(self, *args: object, trial_paths: object, environment: object, **kwargs: object) -> None:
        del args, kwargs
        self.trial_paths = trial_paths
        self.environment = environment
        self._fake_attempt = 0

    async def verify(self) -> FakeVerifierResult:
        self._fake_attempt += 1
        return self.environment.outcome(self.trial_paths.verifier_dir, self._fake_attempt)


class FakeEnvironment:
    def __init__(self, outcome: object) -> None:
        self.os = SimpleNamespace(value="linux")
        self.outcome = outcome
        self.commands: list[str] = []

    async def exec(self, *, command: str, user: str) -> object:
        assert user == "root"
        self.commands.append(command)
        return SimpleNamespace(return_code=0)


def install_harbor_stubs() -> None:
    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.trial": types.ModuleType("harbor.models.trial"),
        "harbor.models.trial.paths": types.ModuleType("harbor.models.trial.paths"),
        "harbor.models.verifier": types.ModuleType("harbor.models.verifier"),
        "harbor.models.verifier.result": types.ModuleType("harbor.models.verifier.result"),
        "harbor.verifier": types.ModuleType("harbor.verifier"),
        "harbor.verifier.verifier": types.ModuleType("harbor.verifier.verifier"),
    }
    modules["harbor.models.trial.paths"].EnvironmentPaths = FakeEnvironmentPaths
    modules["harbor.models.verifier.result"].VerifierResult = FakeVerifierResult
    modules["harbor.verifier.verifier"].Verifier = FakeBaseVerifier
    sys.modules.update(modules)


def load_wrapper(source: Path) -> object:
    install_harbor_stubs()
    spec = importlib.util.spec_from_file_location("hitch_harbor_verifier", source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def infra_then_pass(verifier_dir: Path, attempt: int) -> FakeVerifierResult:
    verifier_dir.mkdir(parents=True, exist_ok=True)
    if attempt == 1:
        (verifier_dir / "test-stdout.txt").write_text(
            "curl: (6) Could not resolve host: astral.sh\n"
            "/tests/test.sh: uvx: command not found\n"
        )
        (verifier_dir / "reward.txt").write_text("0\n")
        return FakeVerifierResult(rewards={"reward": 0})
    assert not (verifier_dir / "reward.txt").exists()
    (verifier_dir / "test-stdout.txt").write_text("1 passed in 0.01s\n")
    (verifier_dir / "ctrf.json").write_text("{}\n")
    (verifier_dir / "reward.txt").write_text("1\n")
    return FakeVerifierResult(rewards={"reward": 1})


def real_test_failure(verifier_dir: Path, attempt: int) -> FakeVerifierResult:
    assert attempt == 1
    verifier_dir.mkdir(parents=True, exist_ok=True)
    (verifier_dir / "test-stdout.txt").write_text(
        "============================= test session starts ==============================\n"
        "collected 1 item\n"
        "curl: (6) Could not resolve host: candidate.invalid\n"
        "============================== 1 failed in 0.1s ===============================\n"
    )
    return FakeVerifierResult(rewards={"reward": 0})


def always_infra(verifier_dir: Path, attempt: int) -> FakeVerifierResult:
    verifier_dir.mkdir(parents=True, exist_ok=True)
    (verifier_dir / "test-stdout.txt").write_text(
        f"attempt {attempt}: curl: (6) Could not resolve host: astral.sh\n"
        "/tests/test.sh: uvx: command not found\n"
    )
    (verifier_dir / "reward.txt").write_text("0\n")
    return FakeVerifierResult(rewards={"reward": 0})


async def main(source: Path) -> None:
    module = load_wrapper(source)
    with tempfile.TemporaryDirectory() as temporary:
        verifier_dir = Path(temporary) / "recovered"
        environment = FakeEnvironment(infra_then_pass)
        verifier = module.HitchRetryingVerifier(
            trial_paths=SimpleNamespace(verifier_dir=verifier_dir),
            environment=environment,
            infrastructure_retries=1,
            infrastructure_retry_backoff_ms=0,
        )
        result = await verifier.verify()
        assert result.rewards == {"reward": 1}
        assert verifier._fake_attempt == 2
        history = json.loads((verifier_dir / "infrastructure-retry-history.json").read_text())
        assert history["status"] == "recovered"
        assert history["candidate_rerun"] is False
        assert history["attempts"][0]["signals"] == [
            "dns_resolution_failed",
            "test_runner_missing",
        ]
        assert not (verifier_dir / "infrastructure-error.json").exists()
        timing = json.loads((verifier_dir / "hitch-phase-timings.json").read_text())
        assert timing["phases"]["verifier"]["duration_ms"] >= 0

        failed_dir = Path(temporary) / "real-failure"
        failed = module.HitchRetryingVerifier(
            trial_paths=SimpleNamespace(verifier_dir=failed_dir),
            environment=FakeEnvironment(real_test_failure),
            infrastructure_retries=2,
            infrastructure_retry_backoff_ms=0,
        )
        failed_result = await failed.verify()
        assert failed_result.rewards == {"reward": 0}
        assert failed._fake_attempt == 1
        assert not (failed_dir / "infrastructure-retry-history.json").exists()

        exhausted_dir = Path(temporary) / "exhausted"
        exhausted = module.HitchRetryingVerifier(
            trial_paths=SimpleNamespace(verifier_dir=exhausted_dir),
            environment=FakeEnvironment(always_infra),
            infrastructure_retries=1,
            infrastructure_retry_backoff_ms=0,
        )
        try:
            await exhausted.verify()
            raise AssertionError("expected verifier infrastructure exhaustion")
        except module.VerifierInfrastructureError:
            pass
        diagnostic = json.loads((exhausted_dir / "infrastructure-error.json").read_text())
        assert len(diagnostic["attempts"]) == 2
        assert diagnostic["max_retries"] == 1
        assert exhausted._fake_attempt == 2

    print("verifier retry smoke OK")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]).resolve()))
