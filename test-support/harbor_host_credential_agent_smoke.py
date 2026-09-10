"""Drive the packaged Harbor agent through native attempts and one physical rerun."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

from bridge_smoke import AgentContext, BaseEnvironment, install_harbor_stubs, load_bridge


CREDENTIAL_NAME = "DSH_OPENAI_CODEX_ACCESS_B64"
EVAL_ID = "eval_0123456789abcdef0123456789abcdef"
STALE_ACCESS = "opaque-secret-stale-agent-123456789"
HELPER_ERROR_SECRET = "opaque-secret-helper-error-123456789"


class PrivateEnvironment(BaseEnvironment):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.private_calls = []
        self.parent_payloads = []
        self.context_payloads = []

    async def upload_file(self, source, target):
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


def write_trial(logs: Path, task_id: str, trial_id: str) -> Path:
    trial = logs / trial_id
    agent_logs = trial / "agent"
    agent_logs.mkdir(parents=True)
    (trial / "lock.json").write_text(
        json.dumps({"schema_version": 2, "task": {"name": task_id}}),
        encoding="utf-8",
    )
    return agent_logs


async def main(bridge_path: Path, runtime: Path, logs: Path, artifact_dir: Path, helper: Path) -> None:
    install_harbor_stubs()
    sys.path.insert(0, str(bridge_path.parent))
    bridge = load_bridge(str(bridge_path))
    runtime_manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    manifest, harness_ref, handoff = artifact_handoff(artifact_dir)
    original_config = os.environ.get("HITCH_HOST_CREDENTIAL_HELPER_JSON")
    original_credential = os.environ.get(CREDENTIAL_NAME)
    os.environ[CREDENTIAL_NAME] = STALE_ACCESS

    def configure(mode: str) -> None:
        os.environ["HITCH_HOST_CREDENTIAL_HELPER_JSON"] = json.dumps({
            "version": 1,
            "argv": [sys.executable, str(helper), "--helper", mode],
            "credentialNames": [CREDENTIAL_NAME],
            "timeoutMs": 5_000,
        })

    def make(task_id: str, attempt: int, trial_id: str):
        environment = PrivateEnvironment(
            revision_identity=manifest["revision_identity"],
            platform_identity=manifest["platform"],
            node_version=manifest["toolchain"]["node"],
            default_workdir="/workspace",
        )
        context = AgentContext()
        agent = bridge.HitchHarborAgent(
            logs_dir=write_trial(logs, task_id, trial_id),
            harness_ref=harness_ref,
            revision_identity=manifest["revision_identity"],
            hitch_runtime_dir=str(runtime),
            controller_runtime_id=runtime_manifest["runtime_id"],
            harness_artifact=handoff,
            node_version=manifest["toolchain"]["node"],
            hitch_timeout_ms=5_000,
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

        configure("failure")
        failed = make("task-a", 2, "task-a__attempt-2-helper-failed")
        failed_agent, failed_environment, failed_context = failed
        await failed_agent.setup(failed_environment)
        try:
            await failed_agent.run("do the task", failed_environment, failed_context)
        except bridge.HitchBridgeError as error:
            assert error.code == "host_credential_helper_failed"
            diagnostic = f"{error} {error.evidence!r} {failed_context.metadata!r}"
            assert HELPER_ERROR_SECRET not in diagnostic
        else:
            raise AssertionError("helper failure unexpectedly launched the Target")
        assert not failed_environment.private_calls
        assert len(failed_environment.bridge_errors) == 1
        assert failed_environment.bridge_errors[0]["code"] == "host_credential_helper_failed"
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
    asyncio.run(main(*(Path(value).resolve() for value in sys.argv[1:6])))
