"""Exercise the real bridge setup in isolated, network-disabled Docker containers."""
from __future__ import annotations

import asyncio
import json
import shlex
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from bridge_smoke import ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
bridge = load_bridge(str(Path(__file__).resolve().parents[1] / "integrations/harbor/hitch_harbor_agent.py"))


class DockerEnvironment:
    def __init__(self, docker: str, container: str, corrupt: bool) -> None:
        self.docker = docker
        self.container = container
        self.corrupt = corrupt
        self.commands: list[str] = []

    def call(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([self.docker, *args], text=True, capture_output=True, check=True, timeout=60)

    async def exec(self, command: str, cwd: str | None = None, user: Any = None) -> ExecResult:
        self.commands.append(command)
        args = [self.docker, "exec", "--user", str(user or 0)]
        if cwd:
            args += ["--workdir", cwd]
        result = subprocess.run(args + [self.container, "sh", "-c", command], text=True, capture_output=True, timeout=60)
        return ExecResult(stdout=result.stdout, stderr=result.stderr, return_code=result.returncode)

    async def upload_dir(self, source: Path, target: str) -> None:
        self.call("exec", self.container, "mkdir", "-p", target)
        self.call("cp", str(source) + "/.", self.container + ":" + target)

    async def upload_file(self, source: Path, target: str) -> None:
        self.call("cp", str(source), self.container + ":" + target)
        if self.corrupt and target.endswith("node-runtime.tar.gz"):
            self.call("exec", self.container, "sh", "-c", "printf X >> " + shlex.quote(target))


async def main() -> None:
    docker, image, artifact_path, controller_path, logs = sys.argv[1:]
    artifact = json.loads((Path(artifact_path) / "artifact.json").read_text())
    controller = json.loads((Path(controller_path) / "manifest.json").read_text())
    transport = {key: artifact[key] for key in (
        "artifact_id", "artifact_integrity", "entrypoint_integrity", "harness_id", "revision_identity",
        "adapter_version", "recipe_version", "platform", "source_type",
    )}
    transport.update(directory=artifact_path, node_version=artifact["toolchain"]["node"])
    for case in ("no-node", "existing-node", "corrupt-upload"):
        name = "hitch-node-smoke-" + uuid.uuid4().hex
        env = DockerEnvironment(docker, name, case == "corrupt-upload")
        created = False
        try:
            env.call("run", "--detach", "--name", name, "--platform", "linux/amd64", "--network", "none", image, "sleep", "240")
            created = True
            network = env.call("inspect", "--format", "{{.HostConfig.NetworkMode}}", name).stdout.strip()
            assert network == "none"
            env.call("exec", name, "mkdir", "-p", "/logs/agent")
            if case != "existing-node":
                # These are disposable test containers, never user/system images.
                env.call("exec", name, "rm", "/usr/local/bin/node", "/usr/local/bin/npm", "/usr/local/bin/npx")
                missing = await env.exec("! command -v node && ! command -v npm")
                assert missing.return_code == 0
            agent = bridge.HitchHarborAgent(
                logs_dir=Path(logs) / case, harness_ref="pi@version:1.2.3", revision_identity=artifact["revision_identity"],
                hitch_runtime_dir=controller_path, controller_runtime_id=controller["runtime_id"], harness_artifact=transport,
            )
            if case == "corrupt-upload":
                try:
                    await agent.setup(env)
                    raise AssertionError("corrupted upload was accepted")
                except bridge.HitchBridgeError as error:
                    assert error.code == "hitch_node_runtime_integrity_mismatch", error
                assert not any("tar --no-same-owner" in command for command in env.commands)
                assert agent.version() is None
                print("corrupt-upload: rejected OK", flush=True)
                continue
            await agent.setup(env)
            assert (agent.version() or "").startswith("hitch "), agent.version()
            result = await env.exec(agent._node_prefix() + ' node --version && npm --version && npx --version && node /opt/hitch-harness-artifact/entry.js')
            assert result.return_code == 0, result.stderr
            assert "v22.23.0" in result.stdout and "offline harness OK" in result.stdout, result.stdout
            selected = json.loads((Path(logs) / case / "hitch-node-runtime.json").read_text())
            assert selected["source"] == ("system" if case == "existing-node" else "offline-artifact")
            assert not any("nvm" in command or "curl " in command or "apt-get " in command for command in env.commands)
            if case == "no-node":
                # Selecting Hitch's PATH must not install a global system Node.
                assert (await env.exec("! command -v node")).return_code == 0
                # Offline extraction must not accidentally inherit a private
                # host cache umask and make the runtime root-only.
                unprivileged = await env.exec(agent._node_prefix() + " node --version && npm --version", user=65534)
                assert unprivileged.return_code == 0, unprivileged.stderr
            print(f'{case}: {selected["source"]} OK ({agent.version()}, {result.stdout.strip()})', flush=True)
        finally:
            if created:
                env.call("rm", "--force", name)


if __name__ == "__main__":
    asyncio.run(main())
