"""Behavioral smoke test for the Harbor bridge.

Stubs the Harbor Python API and drives `HitchHarborAgent.setup()` and
`run()` against a real controller runtime bundle, asserting:

- the payload directory (not the bundle root) is uploaded to /opt/hitch;
- the CLI entrypoint is read from the manifest (no hardcoded dist/ path);
- the fallback CLI invocations (--version, prepare, run), or the prepared
  artifact path (--version, run), use the declared entrypoint; and
- the controller runtime id is recorded in context metadata.

Run from Node via the test suite:
  python3 test-support/bridge_smoke.py <bridge.py> <bundle-root> <logs-dir>
"""

from __future__ import annotations

import importlib.util
import json
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

    def __init__(self, revision_identity: str, platform_identity: str = "linux-x64") -> None:
        self.uploads: list[tuple[str, str, str]] = []
        self.execs: list[str] = []
        self.revision_identity = revision_identity
        self.platform_identity = platform_identity

    async def upload_dir(self, source: Path, target: str) -> None:
        self.uploads.append(("dir", str(source), target))

    async def upload_file(self, source: Path, target: str) -> None:
        self.uploads.append(("file", str(source), target))

    async def exec(self, command: str, cwd: str | None = None, user: str | int | None = None) -> ExecResult:
        self.execs.append(command)
        if "process.platform" in command and "process.arch" in command:
            return ExecResult(stdout=self.platform_identity + "\n", return_code=0)
        if "node -e" in command:
            return ExecResult(stdout="", return_code=0)
        if "command -v git" in command:
            return ExecResult(stdout="", return_code=0)
        if " --version" in command:
            return ExecResult(stdout="hitch 0.2.0\n", return_code=0)
        if " prepare " in command or command.rstrip().endswith("prepare"):
            return ExecResult(stdout='{"status":"ok"}\n', return_code=0)
        if " run " in command:
            # The bridge parses run events for a run id, then cats result.json.
            return ExecResult(stdout='{"type":"run.completed","run_id":"run_abc"}\n', return_code=0)
        if "result.json" in command:
            payload = {
                "status": "succeeded",
                "revision_identity": self.revision_identity,
                "artifact_id": "sha256:artifact",
            }
            return ExecResult(stdout=json.dumps(payload) + "\n", return_code=0)
        return ExecResult(stdout="ok\n", return_code=0)


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
    env = BaseEnvironment(
        revision_identity=revision_identity,
        platform_identity=container_platform,
    )
    context = AgentContext()
    agent = bridge.HitchHarborAgent(
        logs_dir=agent_logs_dir,
        harness_ref=harness_ref,
        revision_identity=revision_identity,
        hitch_runtime_dir=bundle_root,
        candidate_id="candidate-1",
        controller_runtime_id=runtime_id,
        harness_artifact={
            "directory": str(artifact_dir),
            "artifact_id": artifact_manifest["artifact_id"],
            "artifact_integrity": artifact_manifest["artifact_integrity"],
            "entrypoint_integrity": artifact_manifest["entrypoint_integrity"],
            "harness_id": artifact_manifest["harness_id"],
            "revision_identity": artifact_manifest["revision_identity"],
            "platform": artifact_manifest["platform"],
            "source_type": artifact_manifest["source_type"],
        } if artifact_manifest else None,
        hitch_timeout_ms=5_000,
        agent_args=[],
        workdir="/app",
        model_name="openai/test-model",
        eval_id="eval_bridge_smoke",
        benchmark_id="benchmark",
        benchmark_revision="sha256:" + "b" * 64,
        verifier_identity="sha256:" + "c" * 64,
    )

    import asyncio

    async def drive() -> None:
        await agent.setup(env)
        await agent.run("do the task", env, context)

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

    # 3. The runtime id is recorded in context metadata and matches the manifest.
    if context.metadata.get("controller_runtime_id") != runtime_id:
        errors.append(f"controller_runtime_id was {context.metadata.get('controller_runtime_id')!r}, expected {runtime_id}")
    if context.metadata.get("hitch_status") != "succeeded":
        errors.append(f"hitch_status was {context.metadata.get('hitch_status')!r}")
    if context.metadata.get("trial_id") != trial_id:
        errors.append(f"trial_id was {context.metadata.get('trial_id')!r}, expected {trial_id!r}")
    if context.metadata.get("task_id") != task_id:
        errors.append(f"task_id was {context.metadata.get('task_id')!r}, expected {task_id!r}")
    if context.metadata.get("attempt") != 1:
        errors.append(f"attempt was {context.metadata.get('attempt')!r}, expected 1")
    if artifact_manifest:
        expected_status = "incompatible_platform_fallback" if incompatible_artifact else "uploaded"
        if context.metadata.get("harness_artifact_transport", {}).get("status") != expected_status:
            errors.append(f"artifact transport metadata was {context.metadata.get('harness_artifact_transport')!r}")

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


if __name__ == "__main__":
    if len(sys.argv) > 4 and sys.argv[4] == "--expect-mismatch":
        sys.exit(negative_main())
    sys.exit(main())
