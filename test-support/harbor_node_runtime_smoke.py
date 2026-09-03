"""Offline Node selection regressions; no Harbor installation or network needed."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any

from bridge_smoke import ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
bridge = load_bridge(str(Path(__file__).resolve().parents[1] / "integrations/harbor/hitch_harbor_agent.py"))


class Environment:
    def __init__(self, system: bool = False, platform: str = "linux-x64", failure: str = "") -> None:
        self.system = system
        self.platform = platform
        self.failure = failure
        self.commands: list[str] = []
        self.uploads: list[str] = []

    async def exec(self, command: str, **kwargs: Any) -> ExecResult:
        self.commands.append(command)
        if command.startswith("node -e "):
            if self.failure == "wrong-version":
                return ExecResult(stdout="v20.0.0", return_code=1)
            return ExecResult(return_code=0 if self.system else 127)
        if "uname -m" in command:
            return ExecResult(stdout=self.platform + "\n")
        if command == "getconf GNU_LIBC_VERSION":
            return ExecResult(stdout="glibc 2.36\n", return_code=1 if self.failure == "libc" else 0)
        if command.startswith("command -v sha256sum") and self.failure == "prerequisite":
            return ExecResult(return_code=1)
        if "| sha256sum -c -" in command and self.failure == "checksum":
            return ExecResult(stderr="checksum mismatch", return_code=1)
        if "tar --no-same-owner" in command and self.failure == "extract":
            return ExecResult(stderr="unexpected EOF", return_code=2)
        if "/unpacked/bin/node -e " in command and self.failure == "loader":
            return ExecResult(stderr="error while loading shared libraries: libstdc++.so.6", return_code=127)
        if command.startswith("mkdir -m 755") and self.failure == "mkdir":
            return ExecResult(stderr="permission denied", return_code=1)
        return ExecResult()

    async def upload_file(self, source: Path, target: str) -> None:
        self.uploads.append(target)


class NodeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="hitch-node-bridge-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifact = self.root / "artifact"
        self.bundle = self.artifact / ".hitch-node-runtime"
        self.bundle.mkdir(parents=True)
        self.archive = self.bundle / "node-runtime.tar.gz"
        self.archive.write_bytes(b"offline archive fixture")
        self.runtime = {
            "schema_version": "1", "recipe_version": "1", "node_version": "v22.23.0",
            "platform": "linux-x64", "libc": "glibc", "builder_image_id": "sha256:" + "a" * 64,
            "archive_sha256": "sha256:" + hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            "archive_bytes": self.archive.stat().st_size,
        }
        self.write_runtime()
        self.agent = bridge.HitchHarborAgent(
            logs_dir=self.root / "logs", harness_ref="pi@version:1.2.3",
            revision_identity="sha256:" + "a" * 64, hitch_runtime_dir=str(self.root),
        )
        self.agent._artifact_host_directory = self.artifact
        self.agent._artifact_manifest = {"platform": "linux-x64"}
        self.agent.harness_artifact = {"artifact_id": "sha256:" + "b" * 64}
        self.repin()

    def write_runtime(self) -> None:
        self.runtime.pop("runtime_id", None)
        self.runtime["runtime_id"] = "sha256:" + hashlib.sha256(
            json.dumps(self.runtime, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        (self.bundle / "node-runtime.json").write_text(json.dumps(self.runtime))

    def repin(self) -> None:
        self.agent.harness_artifact["artifact_integrity"] = bridge.artifact_directory_integrity(self.artifact)

    async def failure(self, env: Environment, code: str) -> None:
        with self.assertRaises(bridge.HitchBridgeError) as caught:
            await self.agent._ensure_node(env)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.agent._node_prefix(), "")
        evidence = json.loads((self.root / "logs/hitch-node-runtime.json").read_text())
        self.assertEqual(evidence["code"], code)
        self.assert_no_network(env)

    def assert_no_network(self, env: Environment) -> None:
        for command in env.commands:
            self.assertNotRegex(command, r"curl|wget|nvm|apt-get|npm install|git clone|\.bashrc")

    async def test_system_node_reused_without_bundle(self) -> None:
        self.agent._artifact_host_directory = None
        env = Environment(system=True)
        await self.agent._ensure_node(env)
        self.assertEqual(len(env.commands), 1)
        self.assertIn("v22.23.0", env.commands[0])
        self.assertIn("process.arch", env.commands[0])
        self.assertEqual(env.uploads, [])
        self.assertEqual(self.agent._node_prefix(), "")
        self.assert_no_network(env)

    async def test_offline_install_with_no_node(self) -> None:
        env = Environment()
        await self.agent._ensure_node(env)
        self.assertEqual(len(env.uploads), 1)
        self.assertRegex(self.agent._node_prefix(), r"export PATH=/opt/hitch-node-runtime-[a-f0-9]{32}/ready/bin:")
        self.assertIn('"$PATH"', self.agent._node_prefix())
        self.assertTrue(any("mv " in command and "/ready" in command for command in env.commands))
        self.assertFalse(any(command.startswith("rm -rf") for command in env.commands))
        evidence = json.loads((self.root / "logs/hitch-node-runtime.json").read_text())
        self.assertEqual(evidence["runtime_id"], self.runtime["runtime_id"])
        self.assert_no_network(env)

    async def test_legacy_artifact_missing_runtime(self) -> None:
        self.agent._artifact_host_directory = None
        await self.failure(Environment(), "hitch_node_runtime_missing")

    async def test_wrong_version_gets_isolated_runtime(self) -> None:
        env = Environment(failure="wrong-version")
        await self.agent._ensure_node(env)
        self.assertTrue(self.agent._node_prefix().startswith("export PATH=/opt/hitch-node-runtime-"))
        self.assertFalse(any("/usr/local/bin" in command for command in env.commands))
        self.assert_no_network(env)

    async def test_host_archive_corruption_fails_before_upload(self) -> None:
        self.archive.write_bytes(b"corrupt bytes")
        env = Environment()
        await self.failure(env, "hitch_node_runtime_integrity_mismatch")
        self.assertEqual(env.uploads, [])

    async def test_sidecar_cannot_self_authenticate(self) -> None:
        self.archive.write_bytes(b"replaced archive")
        self.runtime["archive_sha256"] = "sha256:" + hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.runtime["archive_bytes"] = self.archive.stat().st_size
        self.write_runtime()
        env = Environment()
        await self.failure(env, "hitch_node_runtime_integrity_mismatch")
        self.assertEqual(env.uploads, [])

    async def test_platform_mismatch_fails_before_upload(self) -> None:
        env = Environment(platform="linux-arm64")
        await self.failure(env, "hitch_node_runtime_incompatible")
        self.assertEqual(env.uploads, [])

    async def test_unsupported_libc_fails_before_upload(self) -> None:
        env = Environment(failure="libc")
        await self.failure(env, "hitch_node_runtime_incompatible")
        self.assertEqual(env.uploads, [])

    async def test_missing_tools_fail_without_package_install(self) -> None:
        env = Environment(failure="prerequisite")
        await self.failure(env, "hitch_node_runtime_prerequisite_missing")
        self.assertEqual(env.uploads, [])

    async def test_upload_corruption_fails_before_extraction(self) -> None:
        env = Environment(failure="checksum")
        await self.failure(env, "hitch_node_runtime_integrity_mismatch")
        self.assertFalse(any("tar --no-same-owner" in command for command in env.commands))
        self.assertRegex(env.commands[-1], r"^rm -rf -- /opt/hitch-node-runtime-[a-f0-9]{32}$")

    async def test_partial_extraction_not_activated(self) -> None:
        env = Environment(failure="extract")
        await self.failure(env, "hitch_node_runtime_install_failed")
        self.assertFalse(any("/unpacked/bin/node" in command for command in env.commands))

    async def test_missing_system_library_is_explicit(self) -> None:
        await self.failure(Environment(failure="loader"), "hitch_node_runtime_incompatible")

    async def test_mkdir_failure_does_not_remove_unowned_path(self) -> None:
        env = Environment(failure="mkdir")
        await self.failure(env, "hitch_node_runtime_install_failed")
        self.assertFalse(any(command.startswith("rm -rf") for command in env.commands))

    async def test_escaping_symlink_rejected(self) -> None:
        (self.artifact / "escape").symlink_to("../outside")
        env = Environment()
        await self.failure(env, "hitch_node_runtime_integrity_mismatch")
        self.assertEqual(env.uploads, [])


if __name__ == "__main__":
    unittest.main()
