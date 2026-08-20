"""Harbor custom agent that runs an immutable harness through Hitch in a trial container."""

from __future__ import annotations

import json
import shlex
import tempfile
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext


class HitchHarborAgent(BaseAgent):
    """Upload Hitch into a Harbor environment and delegate the agent phase to it."""

    def __init__(
        self,
        logs_dir: Path,
        harness_ref: str,
        revision_identity: str,
        hitch_runtime_dir: str,
        candidate_id: str = "candidate-1",
        controller_runtime_id: str | None = None,
        hitch_timeout_ms: int = 900_000,
        agent_args: list[str] | None = None,
        workdir: str = "/app",
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.harness_ref = harness_ref
        self.revision_identity = revision_identity
        self.hitch_runtime_dir = Path(hitch_runtime_dir)
        self.controller_runtime_id = controller_runtime_id
        self.candidate_id = candidate_id
        self.hitch_timeout_ms = int(hitch_timeout_ms)
        self.agent_args = list(agent_args or [])
        self.workdir = workdir
        self._hitch_version: str | None = None

    @staticmethod
    def name() -> str:
        return "hitch"

    def version(self) -> str | None:
        return self._hitch_version

    async def setup(self, environment: BaseEnvironment) -> None:
        payload_dir = self.hitch_runtime_dir / "payload"
        if not self.hitch_runtime_dir.is_dir():
            raise RuntimeError(f"Hitch runtime directory does not exist: {self.hitch_runtime_dir}")
        if not payload_dir.is_dir():
            raise RuntimeError(f"Hitch runtime bundle has no payload directory: {self.hitch_runtime_dir}")
        # Upload the cached bundle's payload (package.json + dist/) as the
        # package root so /opt/hitch/dist/bin/hitch.js is the real entrypoint.
        # The manifest.json and local cache path are host-side bookkeeping and
        # are not identity (spec §4.2).
        await environment.upload_dir(payload_dir, "/opt/hitch")
        await self._ensure_node(environment)
        version = await self._exec(environment, f"{self._node_prefix()} node /opt/hitch/dist/bin/hitch.js --version")
        self._hitch_version = (version.stdout or "").strip() or None
        prepare = " ".join(
            [
                self._node_prefix(),
                "HITCH_ROOT=/tmp/hitch-state",
                "node /opt/hitch/dist/bin/hitch.js prepare",
                shlex.quote(self.harness_ref),
                "--json",
            ]
        )
        await self._exec(environment, prepare)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix="hitch-instruction-",
                suffix=".txt",
                dir=self.logs_dir,
                delete=False,
            ) as handle:
                handle.write(instruction)
                temporary = Path(handle.name)
            remote_instruction = "/tmp/hitch-instruction.txt"
            await environment.upload_file(temporary, remote_instruction)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

        arguments = [
            self._node_prefix(),
            "HITCH_ROOT=/tmp/hitch-state",
            "node /opt/hitch/dist/bin/hitch.js run",
            "--harness",
            shlex.quote(self.harness_ref),
            "--cwd",
            shlex.quote(self.workdir),
            "--workspace-mode",
            "shared",
            "--prompt-file",
            shlex.quote(remote_instruction),
            "--timeout",
            str(self.hitch_timeout_ms),
            "--output",
            "jsonl",
        ]
        if self.model_name:
            arguments.extend(["--model", shlex.quote(self.model_name)])
        for value in self.agent_args:
            arguments.extend(["--agent-arg", shlex.quote(value)])
        command = (
            "set -o pipefail; "
            + " ".join(arguments)
            + " 2> >(tee /logs/agent/hitch-stderr.log >&2)"
            + " | tee /logs/agent/hitch-events.jsonl"
        )
        execution = await environment.exec(command, cwd=self.workdir)
        events = self._events(execution.stdout or "")
        run_id = next((event.get("run_id") for event in events if event.get("run_id")), None)
        hitch_result = None
        if run_id:
            result_path = f"/tmp/hitch-state/runs/{run_id}/result.json"
            result = await environment.exec(
                f"cat {shlex.quote(result_path)} | tee /logs/agent/hitch-result.json"
            )
            if result.return_code == 0 and result.stdout:
                hitch_result = json.loads(result.stdout)
        context.metadata = {
            "candidate_id": self.candidate_id,
            "harness_ref": self.harness_ref,
            "revision_identity": self.revision_identity,
            "controller_runtime_id": self.controller_runtime_id,
            "hitch_run_id": run_id,
            "hitch_status": hitch_result.get("status") if hitch_result else None,
            "hitch_artifact_id": hitch_result.get("artifact_id") if hitch_result else None,
        }
        if execution.return_code != 0:
            message = (execution.stderr or "").strip()
            if hitch_result and hitch_result.get("error", {}).get("message"):
                message = hitch_result["error"]["message"]
            raise RuntimeError(
                f"Hitch agent run failed with code {execution.return_code}: {message or 'no diagnostic output'}"
            )
        if hitch_result is None:
            raise RuntimeError("Hitch agent run completed without a persisted result")
        if hitch_result.get("revision_identity") != self.revision_identity:
            raise RuntimeError(
                "Hitch resolved a different harness revision inside the trial container: "
                f"expected {self.revision_identity}, got {hitch_result.get('revision_identity')}"
            )

    async def _ensure_node(self, environment: BaseEnvironment) -> None:
        probe = await environment.exec(
            "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'"
        )
        needs_git = "@commit:" in self.harness_ref
        git_probe = await environment.exec("command -v git >/dev/null 2>&1")
        if probe.return_code == 0 and (not needs_git or git_probe.return_code == 0):
            return
        prerequisites = """
set -eu
if command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then exit 0; fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ca-certificates git bash
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates git
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates git
else
  echo 'Hitch requires Node.js 22+ and could not install curl in this task image' >&2
  exit 1
fi
"""
        await self._exec(environment, prerequisites, user=0)
        if probe.return_code == 0:
            return
        install = """
set -eu
export NVM_DIR=/opt/hitch-node
mkdir -p "$NVM_DIR"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
"""
        await self._exec(environment, install, user=0)

    @staticmethod
    def _node_prefix() -> str:
        return "if [ -s /opt/hitch-node/nvm.sh ]; then export NVM_DIR=/opt/hitch-node; . /opt/hitch-node/nvm.sh; fi;"

    @staticmethod
    def _events(output: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for line in output.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    @staticmethod
    async def _exec(
        environment: BaseEnvironment,
        command: str,
        user: str | int | None = None,
    ) -> ExecResult:
        result = await environment.exec(command, user=user)
        if result.return_code != 0:
            diagnostic = (result.stderr or result.stdout or "no output").strip()
            raise RuntimeError(f"container setup command failed ({result.return_code}): {diagnostic}")
        return result
