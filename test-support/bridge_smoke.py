"""Behavioral smoke test for the Harbor bridge.

Stubs the Harbor Python API and drives `HitchHarborAgent.setup()` and
`run()` against a real controller runtime bundle, asserting:

- the payload directory (not the bundle root) is uploaded to /opt/hitch;
- the CLI entrypoint is read from the manifest (no hardcoded dist/ path);
- compatible artifacts run directly, while an incompatible artifact is built
  once, persisted on the host, and reused by a concurrent trial; and
- the controller runtime id is recorded in context metadata.

Run from Node via the test suite:
  python3 test-support/bridge_smoke.py <bridge.py> <bundle-root> <logs-dir>
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import shlex
import shutil
import sys
import types
from pathlib import Path
from typing import Any


class BaseAgent:
    def __init__(self, logs_dir: Path, **kwargs: Any) -> None:
        self.logs_dir = Path(logs_dir)
        self.model_name = kwargs.get("model_name")


class ExecResult:
    def __init__(self, stdout: str = "", stderr: str = "", return_code: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.return_code = return_code


class BaseEnvironment:
    """Records uploads and execs instead of touching a real container."""

    def __init__(
        self,
        revision_identity: str,
        platform_identity: str = "linux-x64",
        node_version: str = "v22.0.0",
        prepared_artifact_dir: Path | None = None,
        result_case: str = "valid",
    ) -> None:
        self.uploads: list[tuple[str, str, str]] = []
        self.downloads: list[tuple[str, str]] = []
        self.execs: list[str] = []
        self.revision_identity = revision_identity
        self.platform_identity = platform_identity
        self.node_version = node_version
        self.prepared_artifact_dir = prepared_artifact_dir
        self.result_case = result_case
        self.bridge_errors: list[dict[str, Any]] = []

    async def upload_dir(self, source: Path, target: str) -> None:
        self.uploads.append(("dir", str(source), target))

    async def upload_file(self, source: Path, target: str) -> None:
        self.uploads.append(("file", str(source), target))

    async def download_dir(self, source: str, target: Path) -> None:
        self.downloads.append((source, str(target)))
        if self.prepared_artifact_dir is None:
            raise RuntimeError("fake container has no prepared artifact to download")
        await asyncio.sleep(0.05)
        shutil.copytree(self.prepared_artifact_dir, target, dirs_exist_ok=True, symlinks=True)

    async def exec(self, command: str, cwd: str | None = None, user: str | int | None = None) -> ExecResult:
        self.execs.append(command)
        if "process.platform" in command and "process.arch" in command:
            return ExecResult(stdout=self.platform_identity + "\n", return_code=0)
        if "process.version" in command:
            return ExecResult(stdout=self.node_version + "\n", return_code=0)
        if "node -e" in command:
            return ExecResult(stdout="", return_code=0)
        if "command -v git" in command:
            return ExecResult(stdout="", return_code=0)
        if " --version" in command:
            return ExecResult(stdout="hitch 0.2.0\n", return_code=0)
        if " prepare " in command or command.rstrip().endswith("prepare"):
            if self.prepared_artifact_dir is not None:
                artifact = json.loads((self.prepared_artifact_dir / "artifact.json").read_text(encoding="utf-8"))
                return ExecResult(stdout=json.dumps({"schema_version": "1", "artifact": artifact}) + "\n", return_code=0)
            return ExecResult(stdout='{"status":"ok"}\n', return_code=0)
        if " run " in command and "hitch-events.jsonl" in command:
            # The bridge parses run events for a run id, then cats result.json.
            event = '{"type":"run.completed","run_id":"run_' + "a" * 32 + '"}\n'
            if self.result_case == "process-failure-missing":
                return ExecResult(
                    stdout=event,
                    stderr="x" * 20_000 + "original process failure",
                    return_code=1,
                )
            return ExecResult(stdout=event, return_code=0)
        if "hitch-bridge-error.json" in command:
            for token in shlex.split(command):
                if token.startswith("{"):
                    self.bridge_errors.append(json.loads(token))
                    break
            return ExecResult(stdout="", return_code=0)
        if "stage_dir=" in command and "hitch-run-bundle" in command:
            if self.result_case == "bundle-failure":
                return ExecResult(stderr="bundle export failed", return_code=1)
            return ExecResult(stdout="", return_code=0)
        if "cp --" in command and "hitch-result.json" in command:
            if self.result_case == "copy-failure":
                return ExecResult(stderr="result copy failed", return_code=1)
            return ExecResult(stdout="", return_code=0)
        if "cat --" in command and "/result.json" in command:
            if self.result_case in {"missing", "process-failure-missing"}:
                return ExecResult(stderr="missing", return_code=44)
            if self.result_case == "not-file":
                return ExecResult(stderr="not a regular file", return_code=45)
            if self.result_case == "read-failure":
                return ExecResult(stderr="permission denied", return_code=13)
            if self.result_case == "empty":
                return ExecResult(stdout="", return_code=0)
            if self.result_case == "whitespace":
                return ExecResult(stdout=" \n", return_code=0)
            if self.result_case == "invalid-json":
                return ExecResult(stdout='{"status":', return_code=0)
            if self.result_case == "non-object":
                return ExecResult(stdout="[]\n", return_code=0)
            if self.result_case == "incomplete":
                return ExecResult(stdout='{"schema_version":"1"}\n', return_code=0)
            if self.result_case == "mismatch":
                payload = self._valid_result("run_" + "b" * 32)
                return ExecResult(stdout=json.dumps(payload) + "\n", return_code=0)
            payload = self._valid_result("run_" + "a" * 32)
            return ExecResult(stdout=json.dumps(payload) + "\n", return_code=0)
        return ExecResult(stdout="ok\n", return_code=0)

    def _valid_result(self, run_id: str) -> dict[str, Any]:
        return {
            "schema_version": "1",
            "run_id": run_id,
            "status": "succeeded",
            "exit_code": 0,
            "completed_at": "2026-08-27T00:00:00+00:00",
            "revision_identity": self.revision_identity,
            "artifact_id": "sha256:artifact",
        }


class AgentContext:
    def __init__(self) -> None:
        self.metadata: dict[str, Any] = {}


def install_harbor_stubs() -> None:
    """Register in-memory stub modules for the Harbor custom-agent API so the
    bridge can be imported without a real Harbor installation."""
    harbor = types.ModuleType("harbor")
    harbor_agents = types.ModuleType("harbor.agents")
    harbor_agents_base = types.ModuleType("harbor.agents.base")
    harbor_agents_base.BaseAgent = BaseAgent
    harbor_environments = types.ModuleType("harbor.environments")
    harbor_environments_base = types.ModuleType("harbor.environments.base")
    harbor_environments_base.BaseEnvironment = BaseEnvironment
    harbor_environments_base.ExecResult = ExecResult
    harbor_models = types.ModuleType("harbor.models")
    harbor_models_agent = types.ModuleType("harbor.models.agent")
    harbor_models_agent_context = types.ModuleType("harbor.models.agent.context")
    harbor_models_agent_context.AgentContext = AgentContext
    for module in [
        harbor, harbor_agents, harbor_agents_base,
        harbor_environments, harbor_environments_base,
        harbor_models, harbor_models_agent, harbor_models_agent_context,
    ]:
        module.__package__ = module.__name__
        module.__file__ = f"<stub {module.__name__}>"
        sys.modules[module.__name__] = module
    harbor.agents = harbor_agents
    harbor.environments = harbor_environments
    harbor.models = harbor_models
    harbor_agents.base = harbor_agents_base
    harbor_environments.base = harbor_environments_base
    harbor_models.agent = harbor_models_agent
    harbor_models_agent.context = harbor_models_agent_context


def load_bridge(bridge_path: str) -> Any:
    spec = importlib.util.spec_from_file_location("hitch_harbor_agent", bridge_path)
    assert spec and spec.loader, f"cannot load bridge from {bridge_path}"
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> int:
    bridge_path, bundle_root, logs_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    artifact_dir: Path | None = None
    incompatible_artifact = "--incompatible" in sys.argv[4:]
    if len(sys.argv) > 5 and sys.argv[4] == "--artifact":
        artifact_dir = Path(sys.argv[5])
    install_harbor_stubs()
    bridge = load_bridge(bridge_path)

    trial_id = "regex-log__YNRyNX7"
    task_id = "regex-log"
    trial_dir = Path(logs_dir) / trial_id
    agent_logs_dir = trial_dir / "agent"
    agent_logs_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "lock.json").write_text(
        json.dumps({"schema_version": 2, "task": {"name": task_id}}),
        encoding="utf-8",
    )

    manifest = json.loads((Path(bundle_root) / "manifest.json").read_text(encoding="utf-8"))
    entrypoint = manifest["entrypoints"]["cli"]["path"]
    artifact_manifest = (
        json.loads((artifact_dir / "artifact.json").read_text(encoding="utf-8"))
        if artifact_dir is not None else None
    )
    revision_identity = artifact_manifest["revision_identity"] if artifact_manifest else "sha256:" + "a" * 64
    if artifact_manifest:
        artifact_revision = artifact_manifest["resolved_revision"]["revision"]
        selector = artifact_revision["type"]
        value = artifact_revision["version"] if selector == "version" else artifact_revision["commit"]
        harness_ref = f'{artifact_manifest["harness_id"]}@{selector}:{value}'
    else:
        harness_ref = "pi@version:1.2.3"
    runtime_id = manifest["runtime_id"]

    container_platform = artifact_manifest["platform"] if artifact_manifest else "linux-x64"
    if artifact_manifest and incompatible_artifact:
        container_platform = "darwin-arm64" if container_platform != "darwin-arm64" else "linux-x64"
    node_version = artifact_manifest.get("toolchain", {}).get("node", "v22.0.0") if artifact_manifest else "v22.0.0"
    cache_dir = Path(logs_dir).parent / "host-artifact-cache"
    container_artifact_dir: Path | None = None
    if artifact_manifest:
        cache_dir.mkdir(parents=True, exist_ok=True)
    if artifact_manifest and incompatible_artifact:
        container_artifact_dir = Path(logs_dir).parent / "fake-container-artifact"
        shutil.copytree(artifact_dir, container_artifact_dir, symlinks=True)
        container_manifest = dict(artifact_manifest)
        container_manifest["platform"] = container_platform
        (container_artifact_dir / "artifact.json").write_text(
            json.dumps(container_manifest, indent=2) + "\n",
            encoding="utf-8",
        )
    env = BaseEnvironment(
        revision_identity=revision_identity,
        platform_identity=container_platform,
        node_version=node_version,
        prepared_artifact_dir=container_artifact_dir,
    )
    context = AgentContext()
    artifact_handoff = {
            "directory": str(artifact_dir),
            "artifact_id": artifact_manifest["artifact_id"],
            "artifact_integrity": artifact_manifest["artifact_integrity"],
            "entrypoint_integrity": artifact_manifest["entrypoint_integrity"],
            "harness_id": artifact_manifest["harness_id"],
            "revision_identity": artifact_manifest["revision_identity"],
            "adapter_version": artifact_manifest["adapter_version"],
            "recipe_version": artifact_manifest["recipe_version"],
            "platform": artifact_manifest["platform"],
            "node_version": artifact_manifest["toolchain"]["node"],
            "source_type": artifact_manifest["source_type"],
    } if artifact_manifest else None

    def make_agent(log_directory: Path) -> Any:
        return bridge.HitchHarborAgent(
            logs_dir=log_directory,
            harness_ref=harness_ref,
            revision_identity=revision_identity,
            hitch_runtime_dir=bundle_root,
            candidate_id="candidate-1",
            controller_runtime_id=runtime_id,
            harness_artifact=artifact_handoff,
            harness_artifact_cache_dir=str(cache_dir) if artifact_manifest else None,
            hitch_timeout_ms=5_000,
            agent_args=[],
            workdir="/app",
            model_name="openai/test-model",
            eval_id="eval_bridge_smoke",
            benchmark_id="benchmark",
            benchmark_revision="sha256:" + "b" * 64,
            verifier_identity="sha256:" + "c" * 64,
            logical_attempt=2,
        )

    agent = make_agent(agent_logs_dir)
    second_env: BaseEnvironment | None = None
    second_context: AgentContext | None = None
    second_agent: Any | None = None
    if artifact_manifest and incompatible_artifact:
        second_trial_dir = Path(logs_dir) / "regex-log__second"
        second_agent_logs = second_trial_dir / "agent"
        second_agent_logs.mkdir(parents=True, exist_ok=True)
        (second_trial_dir / "lock.json").write_text(
            json.dumps({"schema_version": 2, "task": {"name": task_id}}),
            encoding="utf-8",
        )
        second_env = BaseEnvironment(
            revision_identity=revision_identity,
            platform_identity=container_platform,
            node_version=node_version,
        )
        second_context = AgentContext()
        second_agent = make_agent(second_agent_logs)

    async def drive_one(active_agent: Any, active_env: BaseEnvironment, active_context: AgentContext) -> None:
        await active_agent.setup(active_env)
        await active_agent.run("do the task", active_env, active_context)

    async def drive() -> None:
        runs = [drive_one(agent, env, context)]
        if second_agent is not None and second_env is not None and second_context is not None:
            runs.append(drive_one(second_agent, second_env, second_context))
        await asyncio.gather(*runs)

    asyncio.run(drive())

    errors: list[str] = []

    # 1. The payload directory is uploaded as /opt/hitch, not the bundle root.
    dir_uploads = [u for u in env.uploads if u[0] == "dir"]
    expected_uploads = 2 if artifact_manifest and not incompatible_artifact else 1
    if len(dir_uploads) != expected_uploads:
        errors.append(f"expected exactly {expected_uploads} dir uploads, got {len(dir_uploads)}")
    runtime_uploads = [u for u in dir_uploads if u[2] == "/opt/hitch"]
    if len(runtime_uploads) != 1 or Path(runtime_uploads[0][1]).name != "payload":
        errors.append(f"runtime payload upload was invalid: {runtime_uploads!r}")
    if artifact_manifest and not incompatible_artifact:
        artifact_uploads = [u for u in dir_uploads if u[2] == "/opt/hitch-harness-artifact"]
        if len(artifact_uploads) != 1 or Path(artifact_uploads[0][1]) != artifact_dir:
            errors.append(f"prepared artifact upload was invalid: {artifact_uploads!r}")
    if artifact_manifest and incompatible_artifact:
        if len(env.downloads) != 1:
            errors.append(f"target-platform artifact was not downloaded exactly once: {env.downloads!r}")
        cached_artifacts = list((cache_dir / "artifacts").glob("*/artifact.json"))
        if len(cached_artifacts) != 1:
            errors.append(f"target-platform artifact was not persisted in the host cache: {cached_artifacts!r}")
        if second_env is None:
            errors.append("second cache-hit environment was not created")
        else:
            second_artifact_uploads = [u for u in second_env.uploads if u[2] == "/opt/hitch-harness-artifact"]
            if len(second_artifact_uploads) != 1:
                errors.append(f"second trial did not upload the host-cached artifact: {second_env.uploads!r}")

    # 2. The CLI entrypoint comes from the manifest, and the exec commands use
    #    the shell-quoted /opt/hitch/<entrypoint> — never a hardcoded dist path.
    import shlex
    quoted_entry = shlex.quote(f"/opt/hitch/{entrypoint}")
    if f"node {quoted_entry} --version" not in " ".join(env.execs):
        errors.append(f"--version must use the manifest entrypoint {quoted_entry}")
    if artifact_manifest and not incompatible_artifact:
        if f"node {quoted_entry} prepare" in " ".join(env.execs):
            errors.append("container-local prepare ran despite a compatible uploaded artifact")
        if "--internal-prepared-artifact /opt/hitch-harness-artifact" not in " ".join(env.execs):
            errors.append("run did not receive the prepared artifact handoff")
    elif f"node {quoted_entry} prepare" not in " ".join(env.execs):
        errors.append(f"prepare must use the manifest entrypoint {quoted_entry}")
    if f"node {quoted_entry} run" not in " ".join(env.execs):
        errors.append(f"run must use the manifest entrypoint {quoted_entry}")
    if any("/opt/hitch/bin/hitch.js" in command for command in env.execs):
        errors.append("bridge still hardcodes /opt/hitch/bin/hitch.js")
    if second_env is not None:
        if f"node {quoted_entry} prepare" in " ".join(second_env.execs):
            errors.append("second trial prepared again despite the target-platform host cache")
        if "--internal-prepared-artifact /opt/hitch-harness-artifact" not in " ".join(second_env.execs):
            errors.append("second trial did not run from the target-platform cached artifact")

    # 3. The runtime id is recorded in context metadata and matches the manifest.
    if context.metadata.get("controller_runtime_id") != runtime_id:
        errors.append(f"controller_runtime_id was {context.metadata.get('controller_runtime_id')!r}, expected {runtime_id}")
    if context.metadata.get("hitch_status") != "succeeded":
        errors.append(f"hitch_status was {context.metadata.get('hitch_status')!r}")
    if context.metadata.get("trial_id") != trial_id:
        errors.append(f"trial_id was {context.metadata.get('trial_id')!r}, expected {trial_id!r}")
    if context.metadata.get("task_id") != task_id:
        errors.append(f"task_id was {context.metadata.get('task_id')!r}, expected {task_id!r}")
    if context.metadata.get("attempt") != 2:
        errors.append(f"attempt was {context.metadata.get('attempt')!r}, expected 2")
    if artifact_manifest:
        expected_status = "host_cache_populated" if incompatible_artifact else "uploaded"
        if context.metadata.get("harness_artifact_transport", {}).get("status") != expected_status:
            errors.append(f"artifact transport metadata was {context.metadata.get('harness_artifact_transport')!r}")
        if incompatible_artifact and second_context is not None:
            if second_context.metadata.get("harness_artifact_transport", {}).get("status") != "host_cache_hit":
                errors.append(f"second artifact transport metadata was {second_context.metadata.get('harness_artifact_transport')!r}")

    if errors:
        for error in errors:
            print(f"bridge smoke failure: {error}", file=sys.stderr)
        return 1
    print("bridge smoke OK")
    return 0


def negative_main() -> int:
    """Drive setup() with a deliberately mismatched controller_runtime_id and
    assert the bridge refuses to upload (spec §4.6)."""
    bridge_path, bundle_root, logs_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    install_harbor_stubs()
    bridge = load_bridge(bridge_path)

    manifest = json.loads((Path(bundle_root) / "manifest.json").read_text(encoding="utf-8"))
    env = BaseEnvironment(revision_identity="sha256:" + "a" * 64)
    agent = bridge.HitchHarborAgent(
        logs_dir=Path(logs_dir),
        harness_ref="pi@version:1.2.3",
        revision_identity="sha256:" + "a" * 64,
        hitch_runtime_dir=bundle_root,
        candidate_id="candidate-1",
        controller_runtime_id="sha256:" + "f" * 64,  # deliberately wrong
        hitch_timeout_ms=5_000,
        agent_args=[],
        workdir="/app",
        model_name="openai/test-model",
    )

    import asyncio

    try:
        asyncio.run(agent.setup(env))
    except RuntimeError as error:
        if "runtime id mismatch" not in str(error):
            print(f"bridge negative failure: unexpected error {error}", file=sys.stderr)
            return 1
        if any(u[2] == "/opt/hitch" for u in env.uploads):
            print("bridge negative failure: payload was uploaded despite id mismatch", file=sys.stderr)
            return 1
        print("bridge negative OK (id mismatch rejected before upload)")
        return 0
    print("bridge negative failure: setup() succeeded with a mismatched runtime id", file=sys.stderr)
    return 1


def result_matrix_main() -> int:
    """Exercise result read/parse failures and stable error evidence."""
    bridge_path, bundle_root, logs_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    install_harbor_stubs()
    bridge = load_bridge(bridge_path)
    manifest = json.loads((Path(bundle_root) / "manifest.json").read_text(encoding="utf-8"))
    runtime_id = manifest["runtime_id"]
    revision_identity = "sha256:" + "a" * 64
    cases = {
        "missing": "hitch_result_missing",
        "not-file": "hitch_result_not_file",
        "read-failure": "hitch_result_read_failed",
        "empty": "hitch_result_empty",
        "whitespace": "hitch_result_empty",
        "invalid-json": "hitch_result_invalid_json",
        "non-object": "hitch_result_schema_invalid",
        "incomplete": "hitch_result_schema_invalid",
        "mismatch": "hitch_result_run_id_mismatch",
        "process-failure-missing": "hitch_process_failed",
        "bundle-failure": "hitch_run_bundle_export_failed",
        "copy-failure": "hitch_result_artifact_copy_failed",
    }
    errors: list[str] = []

    async def drive_case(case: str, expected_code: str) -> None:
        trial_id = f"result-{case}__1"
        trial_dir = Path(logs_dir) / trial_id
        agent_logs_dir = trial_dir / "agent"
        agent_logs_dir.mkdir(parents=True, exist_ok=True)
        (trial_dir / "lock.json").write_text(
            json.dumps({"schema_version": 2, "task": {"name": f"result-{case}"}}),
            encoding="utf-8",
        )
        env = BaseEnvironment(revision_identity=revision_identity, result_case=case)
        context = AgentContext()
        agent = bridge.HitchHarborAgent(
            logs_dir=agent_logs_dir,
            harness_ref="pi@version:1.2.3",
            revision_identity=revision_identity,
            hitch_runtime_dir=bundle_root,
            candidate_id="candidate-1",
            controller_runtime_id=runtime_id,
            hitch_timeout_ms=5_000,
            agent_args=[],
            workdir="/app",
            model_name="openai/test-model",
            eval_id="eval_bridge_result_matrix",
            benchmark_id="benchmark",
            benchmark_revision="sha256:" + "b" * 64,
            verifier_identity="sha256:" + "c" * 64,
        )
        await agent.setup(env)
        try:
            await agent.run("do the task", env, context)
            errors.append(f"{case}: run unexpectedly succeeded")
            return
        except Exception as error:
            if not isinstance(error, bridge.HitchBridgeError):
                errors.append(f"{case}: unexpected exception type {type(error).__name__}: {error}")
                return
            if error.code != expected_code:
                errors.append(f"{case}: code was {error.code!r}, expected {expected_code!r}")
            if "JSONDecodeError" in str(error):
                errors.append(f"{case}: leaked JSONDecodeError")
        if context.metadata.get("hitch_bridge_error_code") != expected_code:
            errors.append(f"{case}: metadata code was {context.metadata.get('hitch_bridge_error_code')!r}")
        if context.metadata.get("hitch_bridge_error_artifact") != "hitch-bridge-error.json":
            errors.append(f"{case}: metadata error artifact was not recorded")
        if len(env.bridge_errors) != 1:
            errors.append(f"{case}: expected one bridge error artifact, got {len(env.bridge_errors)}")
        else:
            evidence = env.bridge_errors[0]
            if evidence.get("code") != expected_code:
                errors.append(f"{case}: evidence code was {evidence.get('code')!r}")
            if len(json.dumps(evidence, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 64 * 1024:
                errors.append(f"{case}: bridge error artifact exceeded 64 KiB")
            if evidence.get("trial_id") != trial_id or evidence.get("eval_id") != "eval_bridge_result_matrix":
                errors.append(f"{case}: evidence identity was incomplete")
            for section in [evidence.get("process", {}), evidence.get("result_read", {})]:
                for key in ["stdout_tail", "stderr_tail"]:
                    if len(str(section.get(key, "")).encode("utf-8")) > 8192:
                        errors.append(f"{case}: {key} exceeded the evidence bound")
            if case == "process-failure-missing":
                if evidence.get("result_diagnostic") != "hitch_result_missing":
                    errors.append(f"{case}: missing result was not retained as a secondary diagnostic")
                stderr_tail = str(evidence.get("process", {}).get("stderr_tail", ""))
                if "[truncated " not in stderr_tail or not stderr_tail.endswith("original process failure"):
                    errors.append(f"{case}: process stderr was not tail-bounded correctly")
        read_commands = [command for command in env.execs if "cat --" in command and "/result.json" in command]
        if len(read_commands) != 1 or "| tee" in read_commands[0]:
            errors.append(f"{case}: result read still uses a masking pipeline")
        bundle_indexes = [index for index, command in enumerate(env.execs) if "stage_dir=" in command and "hitch-run-bundle" in command]
        error_indexes = [index for index, command in enumerate(env.execs) if "hitch-bridge-error.json" in command]
        if not bundle_indexes or not error_indexes or bundle_indexes[-1] > error_indexes[-1]:
            errors.append(f"{case}: run bundle was not exported before the bridge error")

    async def drive() -> None:
        for case, expected_code in cases.items():
            await drive_case(case, expected_code)

    asyncio.run(drive())
    if errors:
        for error in errors:
            print(f"bridge result matrix failure: {error}", file=sys.stderr)
        return 1
    print("bridge result matrix OK")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 4 and sys.argv[4] == "--expect-mismatch":
        sys.exit(negative_main())
    if len(sys.argv) > 4 and sys.argv[4] == "--result-matrix":
        sys.exit(result_matrix_main())
    sys.exit(main())
