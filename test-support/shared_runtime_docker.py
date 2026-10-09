"""Real read-only Docker/Compose mounts; no model, registry or network calls."""
import asyncio
import json
import sys
import uuid
from pathlib import Path

from harbor_node_runtime_docker import DockerEnvironment, bridge

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_shared_runtime as shared


class SharedEnvironment(DockerEnvironment):
    def __init__(self, docker, container, sources):
        super().__init__(docker, container, False)
        self._hitch_shared_runtime = sources

    async def _run_docker_compose_command(self, args):
        assert args == ["ps", "--all", "--quiet", "main"]
        return self.call("inspect", "--format", "{{.Id}}", self.container)

    async def hitch_verify_shared_runtime(self, payload, artifact):
        return await shared.verify_environment(self, payload, artifact)

    async def upload_dir(self, source, target):
        raise AssertionError("shared installation must not be uploaded")


async def main():
    docker, image, artifact_path, controller_path, logs = sys.argv[1:]
    artifact = json.loads((Path(artifact_path) / "artifact.json").read_text())
    controller = json.loads((Path(controller_path) / "manifest.json").read_text())
    sources = shared.configure({"runtime_directory": controller_path, "artifact_directory": artifact_path}, "test__env")
    transport = {key: artifact[key] for key in (
        "artifact_id", "artifact_integrity", "entrypoint_integrity", "harness_id", "revision_identity",
        "adapter_version", "recipe_version", "platform", "source_type",
    )}
    transport.update(directory=artifact_path, node_version=artifact["toolchain"]["node"])
    project = "hitch-shared-test-" + uuid.uuid4().hex
    root = Path(logs)
    root.mkdir(parents=True)
    config = root / "compose.json"
    config.write_text(json.dumps({"services": {
        name: {"image": image, "command": ["sleep", "240"], "network_mode": "none",
               "volumes": shared.compose_mounts(sources) if name != "verifier" else []}
        for name in ("main", "peer", "verifier")
    }}))
    env = DockerEnvironment(docker, "", False)
    compose = ["compose", "--project-name", project, "-f", str(config)]
    try:
        env.call(*compose, "up", "--detach", "--pull", "never")
        candidates = []
        for index, name in enumerate(("main", "peer")):
            identity = env.call(*compose, "ps", "--quiet", name).stdout.strip()
            candidate = SharedEnvironment(docker, identity, sources)
            candidates.append(candidate)
            candidate.call("exec", identity, "mkdir", "-p", "/workspace", "/logs/agent")
            if index == 0:
                candidate.call("exec", identity, "rm", "/usr/local/bin/node", "/usr/local/bin/npm", "/usr/local/bin/npx")
            agent = bridge.HitchHarborAgent(
                logs_dir=root / name, harness_ref="pi@version:1.2.3", revision_identity=artifact["revision_identity"],
                hitch_runtime_dir=controller_path, controller_runtime_id=controller["runtime_id"], harness_artifact=transport,
            )
            await agent.setup(candidate)
            assert agent._setup_complete
            assert agent._artifact_transport_status == "shared_readonly_bind"
            result = await candidate.exec(agent._node_prefix() + " node /opt/hitch-harness-artifact/entry.js", user=65534)
            assert result.return_code == 0 and "offline harness OK" in result.stdout, result.stderr
            for target in shared.TARGETS:
                assert (await candidate.exec("touch " + target + "/forbidden")).return_code != 0
            assert (await candidate.exec("printf 'task-%d' > /workspace/private" % index)).return_code == 0
        for index, candidate in enumerate(candidates):
            assert (await candidate.exec("cat /workspace/private")).stdout == "task-%d" % index
        verifier = env.call(*compose, "ps", "--quiet", "verifier").stdout.strip()
        missing = env.call("exec", verifier, "sh", "-c", "test ! -e /opt/hitch && test ! -e /opt/hitch-harness-artifact")
        assert missing.returncode == 0
        print("shared runtime: two candidates, isolated workspaces, verifier excluded, no uploads OK", flush=True)
    finally:
        env.call(*compose, "down", "--timeout", "1", "--volumes")


if __name__ == "__main__":
    asyncio.run(main())
