"""Harbor verifier wrapper with conservative, verifier-only infra retries.

The wrapper retries the task's test script in the same live environment. It
never re-instantiates or calls the candidate agent, so the candidate workspace
and all other container state remain unchanged between verifier attempts.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harbor.models.trial.paths import EnvironmentPaths
from harbor.models.verifier.result import VerifierResult
from harbor.verifier.verifier import Verifier


MAX_LOG_BYTES = 256 * 1024
HITCH_AGENT_OUTCOME_NAME = "hitch-agent-outcome.json"
LOG_NAMES = ("test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt")
OUTPUT_NAMES = (*LOG_NAMES, "reward.txt", "reward.json", "process.json", "feedback.json", "ctrf.json")
CONTROL_NAMES = (
    "infrastructure-error.json",
    "infrastructure-retry-history.json",
    "candidate-ineligible.json",
    "eligibility-gate.json",
)

INFRASTRUCTURE_PATTERNS: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = (
    (
        "dns_resolution_failed",
        (
            re.compile(r"curl:\s*\(\d+\)\s*Could not resolve host:", re.I),
            re.compile(r"Temporary failure in name resolution", re.I),
            re.compile(r"Name or service not known", re.I),
            re.compile(r"getaddrinfo\s+(?:EAI_AGAIN|ENOTFOUND)", re.I),
            re.compile(r"Could not resolve hostname", re.I),
        ),
    ),
    (
        "network_unreachable",
        (
            re.compile(r"Network is unreachable", re.I),
            re.compile(
                r"Failed to establish a new connection:[^\n]*(?:timed out|connection refused)",
                re.I,
            ),
            re.compile(r"Could not connect to (?:host|server)", re.I),
        ),
    ),
    (
        "package_install_failed",
        (
            re.compile(r"Could not find a version that satisfies the requirement", re.I),
            re.compile(r"No matching distribution found for", re.I),
            re.compile(r"Failed to (?:download|fetch) [^\n]*(?:package|wheel|index)", re.I),
            re.compile(r"error:\s*failed to (?:download|fetch|install)", re.I),
        ),
    ),
    (
        "test_runner_missing",
        (
            re.compile(r"(?:^|\n)[^\n]*(?:uvx|pytest|pipx|tox|nox): command not found(?:\n|$)", re.I),
            re.compile(r"No module named ['\"]?(?:pytest|unittest|tox|nox)['\"]?", re.I),
        ),
    ),
    (
        "verifier_environment_missing",
        (
            re.compile(r"/(?:root|home/[^/]+)/\.local/bin/env: No such file or directory", re.I),
            re.compile(
                r"(?:^|\n)[^\n]*/bin/(?:python|python3|pytest|uv|uvx): No such file or directory(?:\n|$)",
                re.I,
            ),
        ),
    ),
)

TEST_EXECUTION_EVIDENCE = (
    re.compile(r"test session starts", re.I),
    re.compile(r"collected\s+\d+\s+items?", re.I),
    re.compile(r"(?:^|\n)Ran\s+\d+\s+tests?", re.I),
    re.compile(r"(?:^|\n)TAP version\s+\d+", re.I),
    re.compile(r"={3,}[^\n]*(?:passed|failed|errors?|skipped)[^\n]*={3,}", re.I),
)


class VerifierInfrastructureError(RuntimeError):
    """Raised after every verifier-only infrastructure retry is exhausted."""


@dataclass(frozen=True)
class InfrastructureObservation:
    signals: tuple[str, ...]
    source_files: tuple[str, ...]


class HitchRetryingVerifier(Verifier):
    """Retry only masked verifier bootstrap failures in the live trial."""

    def __init__(
        self,
        *args: Any,
        infrastructure_retries: int = 1,
        infrastructure_retry_backoff_ms: int = 1_000,
        **kwargs: Any,
    ) -> None:
        if isinstance(infrastructure_retries, bool) or not isinstance(infrastructure_retries, int) or infrastructure_retries < 0:
            raise ValueError("infrastructure_retries must be a non-negative integer")
        if (
            isinstance(infrastructure_retry_backoff_ms, bool)
            or not isinstance(infrastructure_retry_backoff_ms, int)
            or infrastructure_retry_backoff_ms < 0
        ):
            raise ValueError("infrastructure_retry_backoff_ms must be a non-negative integer")
        super().__init__(*args, **kwargs)
        self.infrastructure_retries = infrastructure_retries
        self.infrastructure_retry_backoff_ms = infrastructure_retry_backoff_ms

    async def verify(self) -> VerifierResult:
        started_ns = time.monotonic_ns()
        try:
            return await self._verify_with_retries()
        finally:
            self._write_phase_timing(started_ns)

    async def _verify_with_retries(self) -> VerifierResult:
        directory = getattr(getattr(getattr(self, "task", None), "paths", None), "environment_dir", None)
        if directory and (directory.parent / ".hitch-benchmark.json").is_file():
            from hitch_benchmark import restore_final_response, validate_collected_submission
            validate_collected_submission(self)
            await restore_final_response(self)
        # Do not trust a control file left by the candidate or a prior phase.
        await self._remove_files(CONTROL_NAMES)
        eligibility = self._read_trusted_agent_outcome()
        if eligibility is None:
            self._write_json("eligibility-gate.json", {
                "schema_version": "1", "status": "unavailable", "verifier_executed": True,
            })
        elif eligibility["gradeability"] == "ungradeable":
            self._write_json("candidate-ineligible.json", {
                "schema_version": "1",
                "code": "candidate_evidence_unavailable",
                "run_id": eligibility["run_id"],
                "candidate_bundle": eligibility["candidate_bundle"],
                "reason_code": eligibility.get("reason_code", "candidate_evidence_unavailable"),
                "verifier_executed": False,
            })
            return VerifierResult(rewards={"reward": 0})
        attempts: list[dict[str, Any]] = []
        for attempt in range(1, self.infrastructure_retries + 2):
            result: VerifierResult | None = None
            caught: Exception | None = None
            try:
                result = await super().verify()
            except Exception as error:
                caught = error

            reward = _primary_reward(result)
            observation = _detect_infrastructure(
                self.trial_paths.verifier_dir,
                reward,
                allow_missing_reward=caught is not None,
            )
            if observation is None:
                # The control namespace belongs to this wrapper. Remove files
                # a task script may have created before returning/propagating.
                await self._remove_files(CONTROL_NAMES)
                if caught is not None:
                    raise caught
                if attempts:
                    self._write_history("recovered", attempts)
                assert result is not None
                directory = getattr(getattr(getattr(self, "task", None), "paths", None), "environment_dir", None)
                if directory and (directory.parent / ".hitch-benchmark.json").is_file():
                    from hitch_benchmark import normalize_rewards
                    return normalize_rewards(self, result)
                return result

            attempts.append(
                {
                    "attempt": attempt,
                    "signals": list(observation.signals),
                    "source_files": list(observation.source_files),
                }
            )
            self._archive_attempt(attempt)
            if attempt > self.infrastructure_retries:
                diagnostic = {
                    "schema_version": "1",
                    "code": "verifier_infrastructure_failure",
                    "signals": list(observation.signals),
                    "source_files": list(observation.source_files),
                    "attempts": attempts,
                    "max_retries": self.infrastructure_retries,
                    "backoff_ms": self.infrastructure_retry_backoff_ms,
                }
                self._write_json("infrastructure-error.json", diagnostic)
                self._write_history("exhausted", attempts)
                signal_list = ", ".join(observation.signals)
                raise VerifierInfrastructureError(
                    "verifier infrastructure retries exhausted "
                    f"after {attempt} attempt(s): {signal_list}"
                ) from caught

            self._write_history("retrying", attempts)
            await self._clear_outputs()
            backoff_seconds = (self.infrastructure_retry_backoff_ms * attempt) / 1_000
            if backoff_seconds > 0:
                await asyncio.sleep(backoff_seconds)

        raise AssertionError("unreachable verifier retry state")

    def _read_trusted_agent_outcome(self) -> dict[str, Any] | None:
        source = self.trial_paths.verifier_dir.parent / "agent" / HITCH_AGENT_OUTCOME_NAME
        try:
            if not source.is_file() or source.stat().st_size <= 0 or source.stat().st_size > 16 * 1024:
                return None
            value = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict) or set(value) - {
            "schema_version", "run_id", "status", "candidate_bundle", "submission_snapshot", "gradeability", "reason_code",
        }:
            return None
        if value.get("schema_version") != "1" or re.fullmatch(r"run_[a-f0-9]{32}", str(value.get("run_id", ""))) is None:
            return None
        if value.get("status") not in {"succeeded", "failed", "timed_out", "cancelled"}:
            return None
        if value.get("candidate_bundle") not in {"complete", "missing", "invalid"}:
            return None
        if value.get("submission_snapshot") not in {"complete", "missing", "not-required"}:
            return None
        if value.get("gradeability") not in {"gradeable", "ungradeable"}:
            return None
        if value["gradeability"] == "gradeable" and value["candidate_bundle"] != "complete":
            return None
        if "reason_code" in value and (not isinstance(value["reason_code"], str) or not value["reason_code"]):
            return None
        return value

    def _write_phase_timing(self, started_ns: int) -> None:
        self._write_json(
            "hitch-phase-timings.json",
            {
                "schema_version": "1",
                "phases": {
                    "verifier": {
                        "duration_ms": max(0, (time.monotonic_ns() - started_ns) // 1_000_000),
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    }
                },
            },
        )

    async def _clear_outputs(self) -> None:
        await self._remove_files(OUTPUT_NAMES)

    async def _remove_files(self, names: tuple[str, ...]) -> None:
        for name in names:
            (self.trial_paths.verifier_dir / name).unlink(missing_ok=True)
        env_paths = EnvironmentPaths.for_os(self.environment.os)
        if self.environment.os.value == "windows":
            targets = ",".join(
                f"'{str(env_paths.verifier_dir / name)}'"
                for name in names
            )
            command = (
                "powershell -NoProfile -NonInteractive -Command "
                f'"Remove-Item -Force -ErrorAction SilentlyContinue {targets}"'
            )
        else:
            targets = " ".join(
                _shell_quote(str(env_paths.verifier_dir / name))
                for name in names
            )
            command = f"rm -f -- {targets}"
        cleared = await self.environment.exec(
            command=command,
            user=None if self.environment.os.value == "windows" else "root",
        )
        if cleared.return_code != 0:
            raise VerifierInfrastructureError(
                "could not clear verifier control/output files: "
                f"exit {cleared.return_code}"
            )

    def _archive_attempt(self, attempt: int) -> None:
        archive = self.trial_paths.verifier_dir / "infrastructure-attempts" / f"attempt-{attempt:04d}"
        archive.mkdir(parents=True, exist_ok=True)
        for name in OUTPUT_NAMES:
            source = self.trial_paths.verifier_dir / name
            if source.is_file():
                shutil.copy2(source, archive / name)

    def _write_history(self, status: str, attempts: list[dict[str, Any]]) -> None:
        self._write_json(
            "infrastructure-retry-history.json",
            {
                "schema_version": "1",
                "code": "verifier_infrastructure_retry_history",
                "status": status,
                "max_retries": self.infrastructure_retries,
                "backoff_ms": self.infrastructure_retry_backoff_ms,
                "attempts": attempts,
                "candidate_rerun": False,
            },
        )

    def _write_json(self, name: str, value: dict[str, Any]) -> None:
        target = self.trial_paths.verifier_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _primary_reward(result: VerifierResult | None) -> float | int | None:
    if result is None:
        return None
    preferred = result.rewards.get("reward")
    if isinstance(preferred, (int, float)) and not isinstance(preferred, bool):
        return preferred
    return next(
        (
            value
            for value in result.rewards.values()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ),
        None,
    )


def _detect_infrastructure(
    verifier_dir: Path,
    reward: float | int | None,
    *,
    allow_missing_reward: bool,
) -> InfrastructureObservation | None:
    if reward != 0 and not (allow_missing_reward and reward is None):
        return None
    ctrf = verifier_dir / "ctrf.json"
    if ctrf.is_file() and ctrf.stat().st_size > 0:
        return None

    logs: list[str] = []
    source_files: list[str] = []
    for name in LOG_NAMES:
        source = verifier_dir / name
        value = _read_bounded(source)
        if value is None:
            continue
        logs.append(value)
        source_files.append(f"verifier/{name}")
    if not logs:
        return None
    combined = "\n".join(logs)
    if any(pattern.search(combined) for pattern in TEST_EXECUTION_EVIDENCE):
        return None
    signals = tuple(
        signal
        for signal, patterns in INFRASTRUCTURE_PATTERNS
        if any(pattern.search(combined) for pattern in patterns)
    )
    if not signals:
        return None
    return InfrastructureObservation(signals=signals, source_files=tuple(source_files))


def _read_bounded(source: Path) -> str | None:
    try:
        size = source.stat().st_size
    except FileNotFoundError:
        return None
    with source.open("rb") as handle:
        if size <= MAX_LOG_BYTES:
            return handle.read().decode("utf-8", errors="replace")
        half = MAX_LOG_BYTES // 2
        head = handle.read(half)
        handle.seek(max(0, size - (MAX_LOG_BYTES - half)))
        tail = handle.read(MAX_LOG_BYTES - half)
    return (
        head.decode("utf-8", errors="replace")
        + "\n[... verifier log truncated ...]\n"
        + tail.decode("utf-8", errors="replace")
    )


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"
