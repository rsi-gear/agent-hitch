"""Drive the packaged Harbor agent through native attempts and one physical rerun."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import types
from pathlib import Path

from bridge_smoke import AgentContext, BaseEnvironment, install_harbor_stubs, load_bridge


CREDENTIAL_NAME = "DSH_OPENAI_CODEX_ACCESS_B64"
EVAL_ID = "eval_0123456789abcdef0123456789abcdef"
STALE_ACCESS = "opaque-secret-stale-agent-123456789"
HELPER_ERROR_SECRET = "opaque-secret-helper-error-123456789"
VALIDITY_MARGIN_MS = 5 * 60 * 1000


def _namespace(value):
    if isinstance(value, dict):
        return types.SimpleNamespace(**{key: _namespace(entry) for key, entry in value.items()})
    if isinstance(value, list):
        return [_namespace(entry) for entry in value]
    return value


def install_timeout_model_stubs() -> None:
    """Expose the Harbor config-model surface used by the packaged bridge."""
    task_module = types.ModuleType("harbor.models.task.config")
    trial_module = types.ModuleType("harbor.models.trial.config")

    class TaskConfig:
        @classmethod
        def model_validate_toml(cls, encoded):
            value = json.loads(encoded)
            value.setdefault("agent", {})
            value["agent"].setdefault("timeout_sec", None)
            for step in value.get("steps") or []:
                step.setdefault("agent", {})
                step["agent"].setdefault("timeout_sec", None)
            return _namespace(value)

    class TrialConfig:
        @classmethod
        def model_validate_json(cls, encoded):
            value = json.loads(encoded)
            value.setdefault("timeout_multiplier", 1.0)
            value.setdefault("agent_timeout_multiplier", None)
            value.setdefault("agent", {})
            value["agent"].setdefault("override_timeout_sec", None)
            value["agent"].setdefault("max_timeout_sec", None)
            return _namespace(value)

    task_module.TaskConfig = TaskConfig
    trial_module.TrialConfig = TrialConfig
    for name, module in [
        ("harbor.models.task", types.ModuleType("harbor.models.task")),
        ("harbor.models.task.config", task_module),
        ("harbor.models.trial", types.ModuleType("harbor.models.trial")),
        ("harbor.models.trial.config", trial_module),
    ]:
        module.__package__ = name
        module.__file__ = f"<stub {name}>"
        sys.modules[name] = module


class PrivateEnvironment(BaseEnvironment):
    def __init__(self, *, environment_dir: Path, trial_config_path: Path, upload_delay_sec: float = 0, **kwargs):
        super().__init__(**kwargs)
        self.environment_dir = environment_dir
        self.trial_paths = types.SimpleNamespace(config_path=trial_config_path)
        self.upload_delay_sec = upload_delay_sec
        self.private_calls = []
        self.parent_payloads = []
        self.context_payloads = []

    async def upload_file(self, source, target):
        if self.upload_delay_sec:
            await asyncio.sleep(self.upload_delay_sec)
        if target == "/tmp/hitch-parent.json":
            self.parent_payloads.append(json.loads(Path(source).read_text(encoding="utf-8")))
        if target == "/tmp/hitch-context.json":
            self.context_payloads.append(json.loads(Path(source).read_text(encoding="utf-8")))
        await super().upload_file(source, target)

    async def hitch_exec_with_private_env(self, command, *, cwd=None, env=None):
        assert isinstance(env, dict) and set(env) == {CREDENTIAL_NAME}
        self.private_calls.append({"command": command, "cwd": cwd, "env": dict(env)})
        return await super().exec(command, cwd=cwd)


def artifact_handoff(artifact_dir: Path):
    manifest = json.loads((artifact_dir / "artifact.json").read_text(encoding="utf-8"))
    revision = manifest["resolved_revision"]["revision"]
    selector = revision["type"]
    value = revision["version"] if selector == "version" else revision["commit"]
    return manifest, f'{manifest["harness_id"]}@{selector}:{value}', {
        "directory": str(artifact_dir),
        "artifact_id": manifest["artifact_id"],
        "artifact_integrity": manifest["artifact_integrity"],
        "entrypoint_integrity": manifest["entrypoint_integrity"],
        "harness_id": manifest["harness_id"],
        "revision_identity": manifest["revision_identity"],
        "adapter_version": manifest["adapter_version"],
        "recipe_version": manifest["recipe_version"],
        "platform": manifest["platform"],
        "node_version": manifest["toolchain"]["node"],
        "source_type": manifest["source_type"],
    }


def write_trial(
    logs: Path,
    task_id: str,
    trial_id: str,
    *,
    task_config: dict | None = None,
    trial_config: dict | None = None,
) -> tuple[Path, Path, Path]:
    trial = logs / trial_id
    agent_logs = trial / "agent"
    agent_logs.mkdir(parents=True)
    (trial / "lock.json").write_text(
        json.dumps({"schema_version": 2, "task": {"name": task_id}}),
        encoding="utf-8",
    )
    task_dir = trial / "task"
    environment_dir = task_dir / "environment"
    environment_dir.mkdir(parents=True)
    (task_dir / "task.toml").write_text(
        json.dumps(task_config or {"agent": {"timeout_sec": 30}, "steps": []}),
        encoding="utf-8",
    )
    trial_config_path = trial / "config.json"
    trial_config_path.write_text(
        json.dumps(trial_config or {
            "timeout_multiplier": 1.0,
            "agent_timeout_multiplier": None,
            "agent": {"override_timeout_sec": None, "max_timeout_sec": None},
        }),
        encoding="utf-8",
    )
    return agent_logs, environment_dir, trial_config_path


def native_helper(request_path: Path, delay_sec: float) -> int:
    request = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
    request_path.write_text(json.dumps(request), encoding="utf-8")
    time.sleep(delay_sec)
    access = f"opaque-secret-native-{os.getpid()}"
    envelope = base64.b64encode(json.dumps({"access": access}).encode()).decode()
    print(json.dumps({
        "version": 1,
        "env": {CREDENTIAL_NAME: envelope},
        "expiresAtMs": int(time.time() * 1000) + request["minimumValidityMs"] + 60_000,
    }))
    return 0


async def main(bridge_path: Path, runtime: Path, logs: Path, artifact_dir: Path, helper: Path) -> None:
    install_harbor_stubs()
    install_timeout_model_stubs()
    sys.path.insert(0, str(bridge_path.parent))
    bridge = load_bridge(str(bridge_path))
    runtime_manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    manifest, harness_ref, handoff = artifact_handoff(artifact_dir)
    original_config = os.environ.get("HITCH_HOST_CREDENTIAL_HELPER_JSON")
    original_credential = os.environ.get(CREDENTIAL_NAME)
    os.environ[CREDENTIAL_NAME] = STALE_ACCESS

    def configure(
        mode: str,
        *,
        argv: list[str] | None = None,
        timeout_ms: int = 5_000,
    ) -> None:
        os.environ["HITCH_HOST_CREDENTIAL_HELPER_JSON"] = json.dumps({
            "version": 1,
            "argv": argv or [sys.executable, str(helper), "--helper", mode],
            "credentialNames": [CREDENTIAL_NAME],
            "timeoutMs": timeout_ms,
        })

    def make(
        task_id: str,
        attempt: int,
        trial_id: str,
        *,
        hitch_timeout_ms: int = 5_000,
        task_config: dict | None = None,
        trial_config: dict | None = None,
        upload_delay_sec: float = 0,
        context_metadata: dict | None = None,
    ):
        agent_logs, environment_dir, trial_config_path = write_trial(
            logs,
            task_id,
            trial_id,
            task_config=task_config,
            trial_config=trial_config,
        )
        environment = PrivateEnvironment(
            environment_dir=environment_dir,
            trial_config_path=trial_config_path,
            upload_delay_sec=upload_delay_sec,
            revision_identity=manifest["revision_identity"],
            platform_identity=manifest["platform"],
            node_version=manifest["toolchain"]["node"],
            default_workdir="/workspace",
        )
        context = AgentContext()
        context.metadata = context_metadata
        agent = bridge.HitchHarborAgent(
            logs_dir=agent_logs,
            harness_ref=harness_ref,
            revision_identity=manifest["revision_identity"],
            hitch_runtime_dir=str(runtime),
            controller_runtime_id=runtime_manifest["runtime_id"],
            harness_artifact=handoff,
            node_version=manifest["toolchain"]["node"],
            hitch_timeout_ms=hitch_timeout_ms,
            agent_args=[],
            credential_names=[CREDENTIAL_NAME],
            model_name="openai/test-model",
            eval_id=EVAL_ID,
            benchmark_id="benchmark",
            benchmark_revision="sha256:" + "b" * 64,
            verifier_identity="sha256:" + "c" * 64,
            logical_attempt=attempt,
        )
        return agent, environment, context

    async def drive(item) -> None:
        agent, environment, context = item
        await agent.setup(environment)
        await agent.run("do the task", environment, context)

    try:
        configure("success")
        initial = [
            make(task_id, attempt, f"{task_id}__attempt-{attempt}")
            for attempt in (1, 2, 3)
            for task_id in ("task-a", "task-b")
        ]
        # Setup represents queue/environment preparation. Helper invocation is
        # intentionally absent here and starts only in the concurrent run calls.
        for agent, environment, _context in initial:
            await agent.setup(environment)
            assert not environment.private_calls
        await asyncio.gather(*[
            agent.run("do the task", environment, context)
            for agent, environment, context in initial
        ])

        seen = {}
        secret_texts = [STALE_ACCESS]
        for agent, environment, context in initial:
            assert len(environment.private_calls) == 1
            call = environment.private_calls[0]
            envelope = call["env"][CREDENTIAL_NAME]
            access = json.loads(base64.b64decode(envelope).decode())["access"]
            secret_texts.extend([envelope, access])
            assert envelope not in call["command"] and access not in call["command"]
            assert STALE_ACCESS not in call["command"]
            assert all(envelope not in command and access not in command for command in environment.execs)
            parent = environment.parent_payloads[-1]
            task_id = environment.context_payloads[-1]["task_id"]
            attempt = parent["attempt"]
            assert parent["kind"] == "eval" and parent["eval_id"] == EVAL_ID
            assert parent["trial_id"] == agent._trial_identity()[0]
            assert context.metadata["hitch_run_id"].startswith("run_")
            seen[(task_id, attempt)] = envelope
        assert set(seen) == {(task_id, attempt) for task_id in ("task-a", "task-b") for attempt in (1, 2, 3)}
        assert len(set(seen.values())) == 6

        # A scheduler-selected invalid slot is a new physical Target start, but
        # its native eval and logical attempt identity remain unchanged.
        rerun = make("task-a", 2, "task-a__attempt-2-repair")
        await drive(rerun)
        _agent, rerun_environment, _context = rerun
        rerun_parent = rerun_environment.parent_payloads[-1]
        rerun_envelope = rerun_environment.private_calls[0]["env"][CREDENTIAL_NAME]
        rerun_access = json.loads(base64.b64decode(rerun_envelope).decode())["access"]
        secret_texts.extend([rerun_envelope, rerun_access])
        assert rerun_parent["eval_id"] == EVAL_ID and rerun_parent["attempt"] == 2
        assert rerun_envelope != seen[("task-a", 2)]

        # No helper preserves Hitch's zero sentinel and does not require the
        # Harbor task/config model surface.
        os.environ.pop("HITCH_HOST_CREDENTIAL_HELPER_JSON", None)
        no_helper = make(
            "task-native-no-helper",
            1,
            "task-native-no-helper__attempt-1",
            hitch_timeout_ms=0,
            task_config={"agent": {"timeout_sec": None}, "steps": []},
        )
        await drive(no_helper)
        _agent, no_helper_environment, _context = no_helper
        assert not no_helper_environment.private_calls
        assert any("--timeout 0" in command for command in no_helper_environment.execs)

        # A positive Hitch timeout is already finite, even when Harbor itself
        # has no deadline. It must not start depending on task config parsing.
        positive_request = logs / "positive-native-request.json"
        configure("success", argv=[
            sys.executable,
            str(Path(__file__).resolve()),
            "--native-helper",
            str(positive_request),
            "0",
        ])
        positive = make(
            "task-native-positive",
            1,
            "task-native-positive__attempt-1",
            hitch_timeout_ms=1_000,
            task_config={"agent": {"timeout_sec": None}, "steps": []},
        )
        await drive(positive)
        _agent, positive_environment, _context = positive
        positive_payload = json.loads(positive_request.read_text(encoding="utf-8"))
        assert positive_payload["minimumValidityMs"] == VALIDITY_MARGIN_MS + 1_000
        assert "--timeout 1000" in positive_environment.private_calls[0]["command"]

        # With the zero sentinel, derive Harbor 0.21's effective native budget:
        # min(override=8s, max=5s) * agent multiplier 0.5 = 2.5s.
        native_request = logs / "zero-native-request.json"
        configure("success", argv=[
            sys.executable,
            str(Path(__file__).resolve()),
            "--native-helper",
            str(native_request),
            "0",
        ])
        native = make(
            "task-native-zero",
            1,
            "task-native-zero__attempt-1",
            hitch_timeout_ms=0,
            task_config={"agent": {"timeout_sec": 60}, "steps": []},
            trial_config={
                "timeout_multiplier": 9,
                "agent_timeout_multiplier": 0.5,
                "agent": {"override_timeout_sec": 8, "max_timeout_sec": 5},
            },
            upload_delay_sec=0.05,
        )
        native_agent, native_environment, _context = native
        assert native_agent._native_harbor_agent_timeout_ms(native_environment) == 2_500
        await drive(native)
        native_payload = json.loads(native_request.read_text(encoding="utf-8"))
        assert VALIDITY_MARGIN_MS < native_payload["minimumValidityMs"] < VALIDITY_MARGIN_MS + 2_500
        assert "--timeout 0" in native_environment.private_calls[0]["command"]

        # Harbor does not identify a native multi-step invocation to BaseAgent;
        # the largest effective step is the safe validity bound. Here the
        # inherited 2s step resolves to 4s and the capped 5s step to 8s.
        multi = make(
            "task-native-multi",
            1,
            "task-native-multi__attempt-1",
            hitch_timeout_ms=0,
            task_config={
                "agent": {"timeout_sec": 2},
                "steps": [
                    {"agent": {"timeout_sec": None}},
                    {"agent": {"timeout_sec": 5}},
                ],
            },
            trial_config={
                "timeout_multiplier": 2,
                "agent_timeout_multiplier": None,
                "agent": {"override_timeout_sec": None, "max_timeout_sec": 4},
            },
        )
        multi_agent, multi_environment, _context = multi
        assert multi_agent._native_harbor_agent_timeout_ms(multi_environment) == 8_000

        # Refresh time consumes the native Harbor deadline. A credential that
        # arrives after it cannot launch the Target.
        expired_request = logs / "expired-native-request.json"
        configure("success", argv=[
            sys.executable,
            str(Path(__file__).resolve()),
            "--native-helper",
            str(expired_request),
            "0",
        ])
        expired = make(
            "task-native-expired",
            1,
            "task-native-expired__attempt-1",
            hitch_timeout_ms=0,
            task_config={"agent": {"timeout_sec": 0.5}, "steps": []},
        )
        expired_agent, expired_environment, expired_context = expired
        await expired_agent.setup(expired_environment)
        credential_module = sys.modules["hitch_host_credentials"]
        original_bridge_time = bridge.time
        original_prepare_credentials = credential_module.prepare_host_credentials
        clock = {"now_ns": 0}
        bridge.time = types.SimpleNamespace(
            monotonic_ns=lambda: clock["now_ns"]
        )

        async def prepare_credentials_and_advance_clock(*args, **kwargs):
            credentials = await original_prepare_credentials(*args, **kwargs)
            clock["now_ns"] = 600_000_000
            return credentials

        credential_module.prepare_host_credentials = prepare_credentials_and_advance_clock
        try:
            try:
                await expired_agent.run("do the task", expired_environment, expired_context)
            except RuntimeError as error:
                assert "native Harbor budget expired during host credential preparation" in str(error)
            else:
                raise AssertionError("expired native Harbor budget launched the Target")
        finally:
            credential_module.prepare_host_credentials = original_prepare_credentials
            bridge.time = original_bridge_time
        assert expired_request.is_file()
        assert not expired_environment.private_calls

        # An unbounded native task plus the zero sentinel cannot state a valid
        # short-lived credential requirement, so it fails before the helper.
        unavailable_request = logs / "unavailable-native-request.json"
        configure("success", argv=[
            sys.executable,
            str(Path(__file__).resolve()),
            "--native-helper",
            str(unavailable_request),
            "0",
        ])
        unavailable = make(
            "task-native-unavailable",
            1,
            "task-native-unavailable__attempt-1",
            hitch_timeout_ms=0,
            task_config={"agent": {"timeout_sec": None}, "steps": []},
        )
        unavailable_agent, unavailable_environment, unavailable_context = unavailable
        await unavailable_agent.setup(unavailable_environment)
        try:
            await unavailable_agent.run("do the task", unavailable_environment, unavailable_context)
        except bridge.HitchBridgeError as error:
            assert error.code == "host_credential_helper_request_invalid"
            assert "not finite" in str(error)
        else:
            raise AssertionError("unbounded native Harbor task launched the helper")
        assert not unavailable_request.exists()
        assert not unavailable_environment.private_calls

        assert unavailable_context.metadata == {
            "hitch_bridge_error_code": "host_credential_helper_request_invalid",
            "hitch_bridge_error_artifact": "hitch-bridge-error.json",
        }
        assert len(unavailable_environment.bridge_errors) == 1
        assert unavailable_environment.bridge_errors[0]["code"] == "host_credential_helper_request_invalid"

        helper_failures = [
            (
                "missing-executable",
                "success",
                [str(logs / "missing-host-credential-helper")],
                5_000,
                "host_credential_helper_unavailable",
                None,
            ),
            (
                "nonzero-exit",
                "failure",
                None,
                5_000,
                "host_credential_helper_failed",
                None,
            ),
            (
                "existing-metadata",
                "failure",
                None,
                5_000,
                "host_credential_helper_failed",
                {"existing": "kept"},
            ),
            (
                "timeout",
                "timeout",
                None,
                500,
                "host_credential_helper_timed_out",
                None,
            ),
        ]
        for case, mode, argv, timeout_ms, expected_code, existing_metadata in helper_failures:
            configure(mode, argv=argv, timeout_ms=timeout_ms)
            failed = make(
                f"task-{case}",
                2,
                f"task-{case}__attempt-2",
                context_metadata=existing_metadata,
            )
            failed_agent, failed_environment, failed_context = failed
            await failed_agent.setup(failed_environment)
            try:
                await failed_agent.run("do the task", failed_environment, failed_context)
            except bridge.HitchBridgeError as error:
                assert error.code == expected_code
                diagnostic = f"{error} {error.evidence!r} {failed_context.metadata!r}"
                assert HELPER_ERROR_SECRET not in diagnostic
            else:
                raise AssertionError(f"{case} unexpectedly launched the Target")
            assert failed_context.metadata["hitch_bridge_error_code"] == expected_code
            assert failed_context.metadata["hitch_bridge_error_artifact"] == "hitch-bridge-error.json"
            if existing_metadata is not None:
                assert failed_context.metadata["existing"] == "kept"
            assert not failed_environment.private_calls
            assert len(failed_environment.bridge_errors) == 1
            assert failed_environment.bridge_errors[0]["code"] == expected_code
            assert HELPER_ERROR_SECRET not in json.dumps(failed_environment.bridge_errors)
            assert os.environ[CREDENTIAL_NAME] == STALE_ACCESS

        for file in logs.rglob("*"):
            if not file.is_file():
                continue
            content = file.read_text(encoding="utf-8", errors="replace")
            for secret in [*secret_texts, HELPER_ERROR_SECRET]:
                assert secret not in content, f"credential leaked into {file}"
    finally:
        if original_config is None:
            os.environ.pop("HITCH_HOST_CREDENTIAL_HELPER_JSON", None)
        else:
            os.environ["HITCH_HOST_CREDENTIAL_HELPER_JSON"] = original_config
        if original_credential is None:
            os.environ.pop(CREDENTIAL_NAME, None)
        else:
            os.environ[CREDENTIAL_NAME] = original_credential

    print("Harbor host credential agent smoke OK")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--native-helper":
        raise SystemExit(native_helper(Path(sys.argv[2]), float(sys.argv[3])))
    asyncio.run(main(*(Path(value).resolve() for value in sys.argv[1:6])))
