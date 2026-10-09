"""Deterministic cache/lifecycle regression tests without a Docker daemon."""
import asyncio
import copy
import errno
import json
import logging
import os
from pathlib import Path
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_image_cache as cache_module
real_docker = cache_module.docker
from hitch_image_cache import ImagePreparationCache
from hitch_build_inputs import UnsupportedBuild, pinned_dockerfile
from hitch_compose_preparation import ComposePreparation, _DEFAULT_COMMAND, compose_services

BASE = "example.test/base@sha256:" + "a" * 64


class CacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        if not hasattr(os, "listxattr"):
            # Exercise supported-host cache logic with the same fake Docker
            # backend on macOS. Unsupported metadata inspection is tested below.
            probe = patch.object(os, "listxattr", return_value=[], create=True)
            probe.start()
            self.addCleanup(probe.stop)
        self.temporary = tempfile.TemporaryDirectory()
        # macOS commonly places TMPDIR below the /var -> /private/var symlink.
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "input"
        self.source.mkdir()
        (self.source / "Dockerfile").write_text(f"FROM {BASE}\nCOPY value /value\n")
        (self.source / "value").write_text("first")
        self.builds, self.images, self.tags = [], {}, {}
        self.platform, self.onbuild, self.failure = "amd64", [], False
        self.cache = ImagePreparationCache(self.root / "cache", {})
        self.service = {"platform": "linux/amd64", "build": {"context": str(self.source)}}
        self.mock = patch.object(cache_module, "docker", self.docker)
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.temporary.cleanup()

    async def docker(self, args, **kwargs):
        if args[0] == "info":
            return json.dumps({"ID": "daemon-1", "OSType": "linux", "Architecture": "x86_64"})
        if args == ["buildx", "inspect"]:
            return "Name: unit-test\nDriver: docker\nBuildKit version: v1\n"
        if args[:2] == ["buildx", "ls"]:
            return json.dumps({"Name": "unit-test", "Driver": "docker", "Nodes": [{"Name": "one", "Version": "v1"}]})
        if args[:2] == ["image", "inspect"]:
            ref = args[-1]
            if ref == BASE:
                return json.dumps({"Id": "sha256:" + "b" * 64, "Os": "linux", "Architecture": self.platform, "Config": {"OnBuild": self.onbuild}})
            info = self.images.get(self.tags.get(ref, ref))
            return json.dumps(info) if info else None
        if args[:2] == ["buildx", "build"]:
            self.builds.append({"args": args, "content": (Path(args[-1]) / "value").read_text()})
            await asyncio.sleep(0.05)
            if self.failure:
                raise RuntimeError("injected build failure")
            key = next(value.partition("=")[2] for value in args if value.startswith("io.hitch.prepared-key="))
            image = "sha256:" + cache_module.digest([key, len(self.builds)])
            info = {"Id": image, "Os": "linux", "Architecture": self.platform, "Config": {"Labels": {"io.hitch.prepared-key": key}}}
            self.images[image] = info
            self.tags[args[args.index("--tag") + 1]] = image
            return ""
        raise AssertionError(args)

    async def test_independent_tasks_and_verifier_contexts_share_identical_inputs(self):
        first = await self.cache.prepare(self.service)
        other = self.root / "different-task-tests"
        import shutil
        shutil.copytree(self.source, other)
        second_service = {"build": {"context": str(other)}, "platform": "linux/amd64", "labels": {"task": "another"}, "volumes": ["/different/log:/logs"]}
        second = await ImagePreparationCache(self.root / "cache", {}).prepare(second_service)
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])
        self.assertEqual(first["image"], second["image"])
        self.assertEqual(len(self.builds), 1)
        self.assertEqual(list((self.root / "cache").glob(".context-*")), [])

    async def test_bytes_modes_args_target_dockerignore_invalidate(self):
        previous = await self.cache.prepare(self.service)
        original = (self.source / "value").stat()
        for change in [
            lambda: (self.source / "value").write_text("other"),
            lambda: (self.source / "value").chmod(0o755),
            lambda: self.service["build"].update(args={"VAR": "x"}),
            lambda: self.service["build"].update(target="stage"),
            lambda: (self.source / ".dockerignore").write_text("ignored\n"),
            lambda: (self.source / "Dockerfile").write_text(f"FROM {BASE}\nCOPY value /changed\n"),
        ]:
            change()
            os.utime(self.source / "value", ns=(original.st_atime_ns, original.st_mtime_ns))
            current = await self.cache.prepare(self.service)
            self.assertFalse(current["cache_hit"])
            self.assertNotEqual(previous["cache_key"], current["cache_key"])
            previous = current

    async def test_parallel_dedup_and_evicted_or_mismatched_images(self):
        receipts = await asyncio.gather(*(ImagePreparationCache(self.root / "cache", {}).prepare(self.service) for _ in range(5)))
        self.assertEqual(sum(not r["cache_hit"] for r in receipts), 1)
        self.assertEqual(len(self.builds), 1)
        self.images.clear()
        new = await self.cache.prepare(self.service)
        self.assertFalse(new["cache_hit"])
        self.images[new["image"]]["Config"]["Labels"].clear()
        self.assertFalse((await self.cache.prepare(self.service))["cache_hit"])
        self.assertEqual(len(self.builds), 3)

    async def test_failure_and_cancellation_do_not_publish_or_hold_locks(self):
        self.failure = True
        with self.assertRaisesRegex(RuntimeError, "injected"):
            await self.cache.prepare(self.service)
        self.assertEqual(list((self.root / "cache").glob("image-*.json")), [])
        self.failure = False
        task = asyncio.create_task(self.cache.prepare(self.service))
        while len(self.builds) < 2:
            await asyncio.sleep(0.001)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(list((self.root / "cache").glob(".context-*")), [])
        self.assertFalse((await asyncio.wait_for(self.cache.prepare(self.service), 2))["cache_hit"])

    async def test_build_consumes_snapshot_even_if_original_changes(self):
        original = self.docker
        async def mutation(args, **kwargs):
            if args[:2] == ["buildx", "build"]:
                (self.source / "value").write_text("mutated")
            return await original(args, **kwargs)
        with patch.object(cache_module, "docker", mutation):
            await self.cache.prepare(self.service)
        self.assertEqual(self.builds[0]["content"], "first")
        self.assertFalse((await self.cache.prepare(self.service))["cache_hit"])

    async def test_uninspectable_metadata_falls_back_without_publishing(self):
        async def compose_call(args):
            self.assertEqual(args, ["config", "--format", "json"])
            return SimpleNamespace(stdout=json.dumps({"services": {"main": self.service}}))

        cases = (
            ("missing-api", None, "context-xattr-inspection"),
            ("unsupported-api", Mock(side_effect=NotImplementedError), "context-xattr-inspection"),
            ("unsupported-filesystem", Mock(side_effect=OSError(errno.ENOTSUP, "unsupported")), "context-xattr-inspection"),
            ("unreadable-metadata", Mock(side_effect=OSError(errno.EACCES, "denied")), "context-xattr-inspection"),
            ("partially-copied", Mock(side_effect=[[], [], OSError(errno.EACCES, "denied")]), "context-xattr-inspection"),
            ("present-metadata", Mock(return_value=["user.fixture"]), "context-xattrs"),
        )
        for name, probe, reason in cases:
            with self.subTest(case=name):
                host_os = SimpleNamespace(**vars(os))
                if probe is None:
                    del host_os.listxattr
                else:
                    host_os.listxattr = probe
                environment = SimpleNamespace(
                    _compose_env_vars=lambda: {}, logger=logging.getLogger("test"),
                    trial_paths=SimpleNamespace(trial_dir=self.root / "trial"), session_id=name,
                )
                preparation = ComposePreparation(environment, cache_directory=str(self.root / "cache"))
                with patch("hitch_build_inputs.os", host_os):
                    self.assertIsNone(await preparation.build(compose_call))
                self.assertEqual(preparation.receipts, [{"event": "fallback", "reason": reason}])
                self.assertEqual(preparation.overlay, {})
                self.assertIsNone(preparation.path)
                self.assertEqual(self.builds, [])
                self.assertEqual(list((self.root / "cache").glob("image-*.json")), [])
                self.assertEqual(list((self.root / "cache").glob(".context-*")), [])

    async def test_unsupported_build_inputs_and_base_triggers_fall_back(self):
        for addition in ({"secrets": ["secret"]}, {"ssh": ["default"]}, {"pull": True}, {"no_cache": True}, {"additional_contexts": {"x": "service:peer"}}, {"args": {"UNRESOLVED": None}}, {"labels": {"io.hitch.prepared-key": "mine"}}):
            with self.subTest(addition=addition), self.assertRaises(UnsupportedBuild):
                await self.cache.prepare({"build": {**self.service["build"], **addition}})
        for content in ("FROM mutable:latest", f"FROM {BASE}\nADD https://host/file /file", f"FROM {BASE}\nRUN --mount=type=secret,id=x cat /run/secrets/x", f"FROM {BASE}\nCOPY --from=mutable:latest /x /x", f"# syntax=docker/dockerfile:1\nFROM {BASE}", f"# ignored \\\nFROM mutable:latest AS one\nFROM {BASE}"):
            (self.source / "Dockerfile").write_text(content)
            with self.subTest(content=content), self.assertRaises(UnsupportedBuild):
                await self.cache.prepare(self.service)
        (self.source / "Dockerfile").write_text(f"FROM {BASE}")
        self.onbuild = ["ADD https://host/file /file"]
        with self.assertRaisesRegex(UnsupportedBuild, "inherited-onbuild"):
            await self.cache.prepare(self.service)
        self.onbuild = []
        (self.source / "link").symlink_to(self.root)
        with self.assertRaisesRegex(UnsupportedBuild, "special-context-entry"):
            await self.cache.prepare(self.service)
        self.assertEqual(len(self.builds), 0)

    async def test_platform_and_implicit_build_values_do_not_alias(self):
        first = await self.cache.prepare(self.service)
        proxy_cache = ImagePreparationCache(self.root / "cache", {"HTTPS_PROXY": "http://private:secret@host"})
        second = await proxy_cache.prepare(self.service)
        self.assertNotEqual(first["cache_key"], second["cache_key"])
        self.assertFalse(second["cache_hit"])
        self.platform = "arm64"
        third = await self.cache.prepare({**self.service, "platform": "linux/arm64"})
        self.assertNotEqual(second["cache_key"], third["cache_key"])
        for path in (self.root / "cache").glob("*.json"):
            self.assertNotIn("secret@host", path.read_text())

    async def test_readonly_context_and_unsafe_cache_directory(self):
        nested = self.source / "readonly"
        nested.mkdir(); (nested / "file").write_text("x"); nested.chmod(0o555)
        await self.cache.prepare(self.service)
        nested.chmod(0o755)
        bad = self.root / "link-cache"; bad.symlink_to(self.root / "cache")
        with self.assertRaises(ValueError):
            ImagePreparationCache(bad, {})
        with self.assertRaisesRegex(UnsupportedBuild, "cache-inside-context"):
            await ImagePreparationCache(self.source / "cache", {}).prepare(self.service)

    async def test_effective_builder_and_docker_client_proxies_invalidate(self):
        first = await self.cache.prepare(self.service)
        original = self.docker
        async def changed_builder(args, **kwargs):
            if args == ["buildx", "inspect"]: return "Name: changed\nDriver: docker-container\nBuildKit version: v2\n"
            if args[:2] == ["buildx", "ls"]: return json.dumps({"Name": "changed", "Driver": "docker-container", "Nodes": [{"Name": "one", "Version": "v2"}]})
            return await original(args, **kwargs)
        with patch.object(cache_module, "docker", changed_builder):
            changed = await ImagePreparationCache(self.root / "cache", {}).prepare(self.service)
        self.assertNotEqual(first["cache_key"], changed["cache_key"])
        home = self.root / "client-home"; (home / ".docker").mkdir(parents=True)
        (home / ".docker/config.json").write_text(json.dumps({"proxies": {"default": {"httpProxy": "http://changed"}}}))
        proxied = await ImagePreparationCache(self.root / "cache", {"HOME": str(home)}).prepare(self.service)
        self.assertNotEqual(first["cache_key"], proxied["cache_key"])

    async def test_builder_map_order_activity_and_platform_order_are_not_inputs(self):
        original = self.docker
        reverse = False
        async def reordered(args, **kwargs):
            if args[:2] == ["buildx", "ls"]:
                return json.dumps({"Name": "unit-test", "Driver": "docker", "LastActivity": str(reverse), "Nodes": [{"Name": "one", "Version": "v1", "Status": str(reverse),
                    "Platforms": ["linux/arm64", "linux/amd64"] if reverse else ["linux/amd64", "linux/arm64"],
                    "DriverOpts": {"b": "2", "a": "1"} if reverse else {"a": "1", "b": "2"}}]})
            return await original(args, **kwargs)
        with patch.object(cache_module, "docker", reordered):
            first = await ImagePreparationCache(self.root / "cache", {}).prepare(self.service)
            reverse = True
            second = await ImagePreparationCache(self.root / "cache", {}).prepare(self.service)
        self.assertTrue(second["cache_hit"])
        self.assertEqual(first["cache_key"], second["cache_key"])

    async def test_distinct_cold_builds_obey_shared_slot_limit(self):
        original = self.docker
        active, maximum = 0, 0
        async def observed(args, **kwargs):
            nonlocal active, maximum
            build = args[:2] == ["buildx", "build"]
            if build: active += 1; maximum = max(maximum, active)
            try: return await original(args, **kwargs)
            finally:
                if build: active -= 1
        with patch.object(cache_module, "docker", observed):
            await asyncio.gather(*(ImagePreparationCache(self.root / "cache", {}, slots=2).prepare(
                {"build": {"context": str(self.source), "args": {"VALUE": str(index)}}}) for index in range(5)))
        self.assertEqual(maximum, 2)

    async def test_cancelling_docker_waits_for_process_exit(self):
        executable = self.root / "docker"; marker = self.root / "pid"
        executable.write_text(f'#!{sys.executable}\nimport os,time\nopen({str(marker)!r},"w").write(str(os.getpid()))\ntime.sleep(60)\n')
        executable.chmod(0o700)
        task = asyncio.create_task(real_docker(["buildx", "build"], env={**os.environ, "PATH": str(self.root)}))
        async with asyncio.timeout(5):
            while not marker.exists(): await asyncio.sleep(0.01)
        pid = int(marker.read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        with self.assertRaises(ProcessLookupError): os.kill(pid, 0)

    async def test_repeated_cancellation_waits_for_stubborn_child(self):
        executable = self.root / "docker"; marker = self.root / "pid"
        executable.write_text(f'#!{sys.executable}\nimport os,time,signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen({str(marker)!r},"w").write(str(os.getpid()))\ntime.sleep(60)\n')
        executable.chmod(0o700)
        task = asyncio.create_task(real_docker(["buildx", "build"], env={**os.environ, "PATH": str(self.root)}))
        async with asyncio.timeout(5):
            while not marker.exists(): await asyncio.sleep(0.01)
        pid = int(marker.read_text())
        task.cancel(); await asyncio.sleep(0.05); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(task, 8)
        with self.assertRaises(ProcessLookupError): os.kill(pid, 0)

    async def test_cancellation_stops_descendant_after_docker_cli_exits(self):
        executable = self.root / "docker"
        marker = self.root / "child"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import os, signal, time\n"
            "if os.fork(): os._exit(0)\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            f"open({str(marker)!r}, 'w').write(str(os.getpid()))\n"
            "time.sleep(60)\n"
        )
        executable.chmod(0o700)
        processes = []
        spawn = asyncio.create_subprocess_exec

        async def observed_spawn(*args, **kwargs):
            process = await spawn(*args, **kwargs)
            processes.append(process)
            return process

        with patch.object(cache_module.asyncio, "create_subprocess_exec", observed_spawn):
            task = asyncio.create_task(real_docker(["buildx", "build"], env={**os.environ, "PATH": str(self.root)}))
            pid = None
            try:
                async with asyncio.timeout(5):
                    while not marker.exists() or not processes or processes[0].returncode is None:
                        await asyncio.sleep(0.01)
                pid = int(marker.read_text())
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 8)
                # The orphan can briefly remain a zombie until init reaps it.
                # A closed inherited pipe proves it cannot continue the build.
                self.assertTrue(processes[0].stdout.at_eof())
                self.assertTrue(processes[0].stderr.at_eof())
            finally:
                if pid is not None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)


class ComposeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name).resolve()
        self.env = SimpleNamespace(_environment_docker_compose_path=self.root / "compose.yaml", extra_docker_compose_paths=[],
            _compose_env_vars=lambda: {}, _main_image_name="sha256:" + "c" * 64,
            logger=logging.getLogger("test"), trial_paths=SimpleNamespace(trial_dir=self.root / "trial"), session_id="case__verifier__one")
        self.spec = {"services": {"main": {"command": _DEFAULT_COMMAND, "image": self.env._main_image_name}}}
        self.image = {"Os": "linux", "Config": {}}
        self.prep = ComposePreparation(self.env, managed_keepalive=True)

    def tearDown(self):
        if self.prep.temporary: self.prep.temporary.cleanup()
        self.temp.cleanup()

    async def compose_call(self, args):
        self.assertEqual(args, ["config", "--format", "json"])
        return SimpleNamespace(stdout=json.dumps(self.spec))

    async def docker(self, args, **kwargs):
        return json.dumps(self.image)

    async def test_only_harbor_keepalive_is_managed(self):
        with patch("hitch_compose_preparation.docker", self.docker):
            await self.prep.runtime(self.compose_call)
        self.assertIn('$$child', self.prep.path.read_text())
        self.assertEqual(self.prep.receipts[-1]["event"], "managed-keepalive")

    async def test_custom_runtime_declarations_and_entrypoints_are_preserved(self):
        for key in ("command", "entrypoint", "init", "stop_signal", "stop_grace_period", "pre_stop"):
            for content in (json.dumps({"services": {"main": {key: None}}}), f"services:\n  main:\n    {key}: null\n"):
                with self.subTest(key=key, content=content):
                    self.env._environment_docker_compose_path.write_text(content)
                    candidate = ComposePreparation(self.env, managed_keepalive=True)
                    await candidate.runtime(self.compose_call)
                    self.assertIsNone(candidate.path)
        self.env._environment_docker_compose_path.unlink()
        for config in ({"Entrypoint": ["/custom"]}, {"StopSignal": "SIGQUIT"}):
            self.image["Config"] = config
            candidate = ComposePreparation(self.env, managed_keepalive=True)
            with patch("hitch_compose_preparation.docker", self.docker): await candidate.runtime(self.compose_call)
            self.assertIsNone(candidate.path)

    async def test_force_build_bypasses_cache(self):
        self.prep.cache_directory = str(self.root / "cache")
        self.prep.force_build = True
        async def forbidden(*args): raise AssertionError("cache must not inspect force-build inputs")
        self.assertIsNone(await self.prep.build(forbidden))

    async def test_compose_warnings_do_not_break_json_or_change_services(self):
        self.assertEqual(compose_services('warning: ${UNSET} defaults to empty\n' + json.dumps(self.spec)), self.spec['services'])
        with self.assertRaises(UnsupportedBuild): compose_services('warning only')
        with self.assertRaises(UnsupportedBuild): compose_services(json.dumps(self.spec) + '\n{other invalid output}')


if __name__ == "__main__": unittest.main(verbosity=2)
