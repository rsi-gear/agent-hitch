"""Deterministic cache/lifecycle regression tests without a Docker daemon."""
import asyncio
import errno
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_image_cache as cache_module
from hitch_image_cache import ImagePreparationCache
from hitch_build_inputs import UnsupportedBuild, pinned_dockerfile
from hitch_compose_preparation import ComposePreparation

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
        self.active_context = "unit-test"
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
        if args == ["context", "show"]:
            return self.active_context + "\n"
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

    async def test_dockerfile_encoding_failure_preserves_source_and_cleans_snapshot(self):
        dockerfile = self.source / "Dockerfile"
        for comment in (b"# caf\xe9\n", b"# truncated \xe2\x82\n"):
            original = comment + f"FROM {BASE}\nCOPY value /value\n".encode()
            dockerfile.write_bytes(original)
            with self.subTest(comment=comment), self.assertRaisesRegex(UnsupportedBuild, "^dockerfile-encoding$"):
                await self.cache.prepare(self.service)
            self.assertEqual(dockerfile.read_bytes(), original)
            self.assertEqual(list(self.cache.directory.glob(".context-*")), [])
            self.assertEqual(list(self.cache.directory.glob("image-*.json")), [])
            self.assertEqual(self.builds, [])
        # Unicode comments remain eligible when they are valid UTF-8.
        original = ("# café 中文\n" + f"FROM {BASE}\nCOPY value /value\n").encode()
        dockerfile.write_bytes(original)
        first = await self.cache.prepare(self.service)
        second = await self.cache.prepare(self.service)
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])
        self.assertEqual(first["image"], second["image"])
        self.assertEqual(dockerfile.read_bytes(), original)

    async def test_legacy_builder_and_unavailable_capabilities_use_native_compose(self):
        cases = [({"DOCKER_BUILDKIT": value}, None, None, "legacy-builder") for value in ("0", "false", "False", "f")]
        for command in (("info",), ("buildx", "inspect"), ("buildx", "ls"), ("context", "show")):
            for error in (RuntimeError("plugin unavailable"), TimeoutError(), OSError("unavailable")):
                cases.append(({}, command, error, "builder-capabilities"))
        for settings, command, failure, reason in cases:
            with self.subTest(settings=settings, command=command, failure=type(failure).__name__):
                env = SimpleNamespace(_compose_env_vars=lambda: settings, logger=logging.getLogger("test"),
                                      trial_paths=SimpleNamespace(trial_dir=self.root / "trial"), session_id="candidate")
                prep = ComposePreparation(env, cache_directory=str(self.root / "cache"))
                async def compose(args, **kwargs):
                    document = ({"services": {"main": self.service}} if args[0] == "config"
                                else {"target": {"main": {}}})
                    return SimpleNamespace(stdout=json.dumps(document), return_code=0)
                async def unavailable(args, **kwargs):
                    if command is None:
                        self.fail("legacy builder must not require Buildx probes")
                    if tuple(args[:len(command)]) == command:
                        raise failure
                    return await self.docker(args, **kwargs)
                with patch.object(cache_module, "docker", unavailable):
                    self.assertIsNone(await prep.build(compose))
                self.assertEqual(prep.receipts, [{"event": "fallback", "reason": reason}])
                self.assertEqual(prep.overlay, {})
                self.assertIsNone(prep.path)
        self.assertEqual(self.builds, [])
        with patch.object(cache_module, "docker", AsyncMock(side_effect=asyncio.CancelledError)), \
             self.assertRaises(asyncio.CancelledError):
            await self.cache.identity()

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

    async def test_optional_image_inspection_failures_preserve_native_compose(self):
        async def compose_call(args, **kwargs):
            if args == ["build", "--print"]:
                return SimpleNamespace(return_code=0, stdout=json.dumps({"target": {"main": {}}}))
            self.assertEqual(args, ["config", "--format", "json"])
            return SimpleNamespace(stdout=json.dumps({"services": {"main": self.service}}))

        for stage in ("base", "registry", "cached"):
            errors = (TimeoutError("metadata timeout"), OSError(errno.EIO, "metadata unavailable"),
                      json.JSONDecodeError("invalid metadata", "x", 0), asyncio.CancelledError("cancelled"))
            for index, error in enumerate(errors):
                with self.subTest(stage=stage, error=type(error).__name__):
                    directory = self.root / f"inspection-{stage}-{index}"
                    cache = ImagePreparationCache(directory, {})
                    selected = BASE
                    if stage == "cached":
                        selected = (await cache.prepare(self.service))["image"]
                    records = {p.name: p.read_bytes() for p in directory.glob("image-*.json")}
                    before = len(self.builds)

                    async def unavailable(args, **kwargs):
                        if args[:2] == ["image", "inspect"] and args[-1] == selected:
                            if stage == "registry":
                                return None
                            raise error
                        if stage == "registry" and args[:3] == ["buildx", "imagetools", "inspect"]:
                            raise error
                        return await self.docker(args, **kwargs)

                    environment = SimpleNamespace(_compose_env_vars=lambda: {}, logger=logging.getLogger("test"),
                        trial_paths=SimpleNamespace(trial_dir=self.root / "trial"), session_id=f"{stage}-{index}")
                    preparation = ComposePreparation(environment, cache_directory=str(directory))
                    with patch.object(cache_module, "docker", unavailable):
                        if isinstance(error, asyncio.CancelledError):
                            with self.assertRaises(asyncio.CancelledError) as raised:
                                await preparation.build(compose_call)
                            self.assertIs(raised.exception, error)
                            self.assertEqual(preparation.receipts, [])
                        else:
                            self.assertIsNone(await preparation.build(compose_call))
                            reason = "base-config-unavailable" if stage == "registry" else "image-inspection"
                            self.assertEqual(preparation.receipts, [{"event": "fallback", "reason": reason}])
                    self.assertEqual(len(self.builds), before)
                    self.assertEqual(preparation.images, {})
                    self.assertIsNone(preparation.path)
                    self.assertEqual({p.name: p.read_bytes() for p in directory.glob("image-*.json")}, records)
                    self.assertEqual(list(directory.glob(".context-*")), [])

    async def test_built_image_inspection_failure_remains_an_error(self):
        errors = (TimeoutError("final verification timeout"), OSError(errno.EIO, "image unavailable"),
                  json.JSONDecodeError("invalid metadata", "x", 0), asyncio.CancelledError("cancelled"))
        for index, error in enumerate(errors):
            with self.subTest(error=type(error).__name__):
                cache = ImagePreparationCache(self.root / f"built-inspection-{index}", {})

                async def unavailable(args, **kwargs):
                    if args[:2] == ["image", "inspect"] and args[-1].startswith("hitch-prepared:"):
                        raise error
                    return await self.docker(args, **kwargs)

                before = len(self.builds)
                with patch.object(cache_module, "docker", unavailable), self.assertRaises(type(error)) as raised:
                    await cache.prepare(self.service)
                self.assertIs(raised.exception, error)
                self.assertEqual(len(self.builds), before + 1)
                self.assertEqual(list(cache.directory.glob("image-*.json")), [])
                self.assertEqual(list(cache.directory.glob(".context-*")), [])

    async def test_uninspectable_metadata_falls_back_without_publishing(self):
        async def compose_call(args, **kwargs):
            if args == ["build", "--print"]:
                return SimpleNamespace(return_code=0, stdout=json.dumps({"target": {"main": {}}}))
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

    async def test_unreadable_ignored_context_entries_fall_back_without_publishing(self):
        # COPY . needs the full context. Literal-source builds can now omit
        # unrelated unreadable files without depending on ignore semantics.
        (self.source / "Dockerfile").write_text(f"FROM {BASE}\nCOPY . /all\n")
        ignored = self.source / "ignored"
        (self.source / ".dockerignore").write_text("ignored\n")
        async def compose_call(args, **kwargs):
            if args == ["build", "--print"]:
                return SimpleNamespace(return_code=0, stdout=json.dumps({"target": {"main": {"platforms": ["linux/amd64"]}}}))
            return SimpleNamespace(stdout=json.dumps({"services": {"main": self.service}}))

        for directory in (False, True):
            with self.subTest(directory=directory):
                if directory:
                    ignored.mkdir()
                    original = Path.iterdir
                    def enumerate_source(path):
                        if path == ignored:
                            raise PermissionError(errno.EACCES, "unreadable ignored directory")
                        return original(path)
                    probe = patch.object(Path, "iterdir", enumerate_source)
                else:
                    ignored.write_text("unreadable to Docker's non-root caller")
                    original = os.open
                    def open_source(path, *args, **kwargs):
                        if Path(path) == ignored:
                            raise PermissionError(errno.EACCES, "unreadable ignored file")
                        return original(path, *args, **kwargs)
                    probe = patch.object(os, "open", open_source)
                environment = SimpleNamespace(_compose_env_vars=lambda: {}, logger=logging.getLogger("test"),
                    trial_paths=SimpleNamespace(trial_dir=self.root / "trial"), session_id="ignored-input")
                preparation = ComposePreparation(environment, str(self.root / "cache"))
                try:
                    with probe:
                        self.assertIsNone(await preparation.build(compose_call))
                    self.assertEqual(preparation.receipts, [{"event": "fallback", "reason": "context-read"}])
                    self.assertEqual(self.builds, [])
                    self.assertEqual(list((self.root / "cache").glob("image-*.json")), [])
                    self.assertEqual(list((self.root / "cache").glob(".context-*")), [])
                finally:
                    if directory:
                        ignored.rmdir()
                    else:
                        ignored.unlink()

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
        (self.source / "Dockerfile").write_text(f"FROM {BASE}\nCOPY . /all\n")
        (self.source / "link").symlink_to(self.root)
        with self.assertRaisesRegex(UnsupportedBuild, "special-context-entry"):
            await self.cache.prepare(self.service)
        self.assertEqual(len(self.builds), 0)

    async def test_literal_copy_ignores_unrelated_task_data_and_subtrees(self):
        unused = self.source / "unused-source"
        unused.mkdir()
        (unused / "large-file").write_bytes(b"x" * 1024 * 1024)
        original = Path.iterdir
        def no_unused_walk(path):
            if path == unused:
                raise AssertionError("walked unrelated source tree")
            return original(path)
        with patch.object(Path, "iterdir", no_unused_walk):
            first = await self.cache.prepare(self.service)
            (unused / "large-file").write_text("another task")
            second = await self.cache.prepare(self.service)
        self.assertTrue(second["cache_hit"])
        self.assertEqual(first["cache_key"], second["cache_key"])
        self.assertEqual(len(self.builds), 1)

    async def test_copied_directory_and_ignore_file_changes_still_invalidate(self):
        folder = self.source / "inputs"
        folder.mkdir()
        (folder / "data").write_text("one")
        (self.source / "Dockerfile").write_text(f'FROM {BASE}\nCOPY ["inputs/", "value", "/data/"]\n')
        first = await self.cache.prepare(self.service)
        (folder / "data").write_text("two")
        second = await self.cache.prepare(self.service)
        self.assertNotEqual(first["cache_key"], second["cache_key"])
        (self.source / "Dockerfile.dockerignore").write_text("inputs/data\n")
        third = await self.cache.prepare(self.service)
        self.assertNotEqual(second["cache_key"], third["cache_key"])

    async def test_dynamic_and_wildcard_copy_keep_the_full_context(self):
        (self.source / "payCOPY").write_text("joined continuation operand")
        for instruction in ("COPY . /data", "COPY v* /data/", "COPY ${FILE} /data/",
                            "COPY --parents value /data/", "COPY ./value /data",
                            "COPY va\\\nlue /data", "COPY value pay\\ \nCOPY value /data/",
                            "COPY value pay\\\t\nCOPY value /data/",
                            "COPY foo\u00a0bar /data"):
            with self.subTest(instruction=instruction):
                (self.source / "Dockerfile").write_text(f"FROM {BASE}\n{instruction}\n")
                unused = self.source / "unselected"
                unused.write_text("first")
                first = await self.cache.prepare(self.service)
                unused.write_text("other")
                second = await self.cache.prepare(self.service)
                self.assertNotEqual(first["cache_key"], second["cache_key"])

    async def test_nonstandard_line_separators_preserve_native_build_fallback(self):
        (self.source / "Dockerfile").write_text(f"FROM {BASE}\nCOPY foo\u2028bar /data\n")
        with self.assertRaisesRegex(UnsupportedBuild, "dockerfile-instruction"):
            await self.cache.prepare(self.service)
        self.assertEqual(self.builds, [])

    async def test_changed_dockerfile_cannot_publish_a_pruned_snapshot(self):
        original = Path.read_bytes
        count = 0
        def changing(path):
            nonlocal count
            value = original(path)
            if path == self.source / "Dockerfile":
                count += 1
                if count == 1:
                    path.write_text(f"FROM {BASE}\nCOPY . /data\n")
            return value
        with patch.object(Path, "read_bytes", changing), self.assertRaisesRegex(UnsupportedBuild, "context-changed"):
            await self.cache.prepare(self.service)
        self.assertEqual(self.builds, [])

    async def test_snapshot_destination_failure_remains_an_error(self):
        original = Path.open
        def full_destination(path, *args, **kwargs):
            if args and args[0] == "xb":
                raise OSError(errno.ENOSPC, "snapshot destination is full")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", full_destination), self.assertRaises(OSError) as raised:
            await self.cache.prepare(self.service)
        self.assertEqual(raised.exception.errno, errno.ENOSPC)
        self.assertEqual(self.builds, [])
        self.assertEqual(list((self.root / "cache").glob("image-*.json")), [])
        self.assertEqual(list((self.root / "cache").glob(".context-*")), [])

    async def test_literal_dollars_in_build_values_use_native_compose(self):
        for kind in ("args", "labels"):
            for values in ({"LITERAL": "$$foo"}, {"dollar$key": "value"}):
                with self.subTest(kind=kind, values=values), self.assertRaisesRegex(UnsupportedBuild, "escaped-build-values"):
                    await self.cache.prepare({"build": {**self.service["build"], kind: values}})
        self.assertEqual(self.builds, [])

    async def test_literal_dollars_in_build_paths_use_native_compose(self):
        for name in ("source$one", "source$$one"):
            directory = self.root / name
            directory.mkdir()
            (directory / "Dockerfile").write_text(f"FROM {BASE}\nCOPY value /value\n")
            (directory / "value").write_text(name)
        for name in ("Dockerfile$one", "Dockerfile$$one"):
            (self.source / name).write_text(f"FROM {BASE}\nCOPY value /value\n")
        for build in ({"context": str(self.root / "source$$one")},
                      {"context": str(self.source), "dockerfile": "Dockerfile$$one"}):
            with self.subTest(build=build), self.assertRaisesRegex(UnsupportedBuild, "escaped-build-paths"):
                await self.cache.prepare({"build": build})
        self.assertEqual(self.builds, [])

    async def test_base_variants_and_old_receipts_cannot_certify_the_wrong_config(self):
        cases = [
            ({"Os": "linux", "Architecture": "arm64", "Variant": "v9", "Config": {}},
             {"os": "linux", "architecture": "arm64", "variant": "v8", "config": {"OnBuild": ["ADD https://fixture.invalid /value"]}},
             "inherited-onbuild"),
            (None, {"os": "linux", "architecture": "arm64", "variant": "v9", "config": {}}, "base-config-unavailable"),
            ({"Os": "linux", "Architecture": "arm64", "Variant": "v8", "Config": {"OnBuild": ["ADD https://fixture.invalid /value"]}},
             None, "inherited-onbuild"),
        ]
        for index, (local, remote, reason) in enumerate(cases):
            cache = ImagePreparationCache(self.root / f"variant-{index}", {})
            legacy = cache.directory / f"base-{cache_module.digest(['base-v1', BASE, 'linux/arm64'])}.json"
            legacy.write_text(json.dumps({"base": BASE, "platform": "linux/arm64", "no_onbuild": True}))
            with self.subTest(case=index), patch.object(cache, "inspect", AsyncMock(return_value=local)), \
                 patch.object(cache_module, "docker", AsyncMock(return_value=json.dumps(remote))), \
                 self.assertRaisesRegex(UnsupportedBuild, reason):
                await cache.check_bases([BASE], "linux/arm64")
            self.assertEqual(list(cache.directory.glob("base-*.json")), [legacy])

    async def test_context_recovery_preserves_live_legacy_and_symlink_entries(self):
        directory = self.root / "cache"
        legacy = directory / ".context-legacy"; legacy.mkdir()
        (legacy / "value").write_text("unrecognized")
        outside = self.root / "outside"; outside.mkdir()
        (outside / "value").write_text("outside")
        (directory / ".context-symlink").symlink_to(outside, target_is_directory=True)
        async with cache_module.context_snapshot(directory) as live:
            (live / "value").write_text("live")
            async with cache_module.context_snapshot(directory):
                self.assertEqual((live / "value").read_text(), "live")
        self.assertFalse(live.exists())
        self.assertEqual((legacy / "value").read_text(), "unrecognized")
        self.assertEqual((outside / "value").read_text(), "outside")

    async def test_context_recovery_removes_a_dead_copiers_readonly_partial_tree(self):
        code = """
import asyncio, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from hitch_image_cache import context_snapshot
async def main():
    async with context_snapshot(Path(sys.argv[2])) as stage:
        context = stage / 'context'
        context.mkdir()
        (context / 'value').write_text('partial copy')
        context.chmod(0o555)
        os._exit(0)
asyncio.run(main())
"""
        directory = self.root / "cache"
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", "-c", code,
            str(Path(cache_module.__file__).parent), str(directory))
        self.assertEqual(await process.wait(), 0)
        abandoned = list(directory.glob(".context-*"))
        self.assertEqual(len(abandoned), 1)
        async with cache_module.context_snapshot(directory):
            self.assertFalse(abandoned[0].exists())
        self.assertEqual(list(directory.glob(".context-*")), [])

    async def test_hardlink_topology_cannot_alias_an_independent_warm_context(self):
        other = self.source / "other"
        other.write_text((self.source / "value").read_text())
        await self.cache.prepare(self.service)
        other.unlink()
        os.link(self.source / "value", other)
        with self.assertRaisesRegex(UnsupportedBuild, "context-hardlinks"):
            await self.cache.prepare(self.service)
        self.assertEqual(len(self.builds), 1)
        self.assertEqual(list((self.root / "cache").glob(".context-*")), [])

    async def test_git_metadata_requests_bypass_relocated_contexts(self):
        await self.cache.prepare(self.service)
        for name in ("BUILDX_GIT_LABELS", "BUILDX_GIT_CHECK_DIRTY"):
            for value in ("1", "true", "full"):
                with self.subTest(name=name, value=value):
                    cache = ImagePreparationCache(self.root / "cache", {name: value})
                    with self.assertRaisesRegex(UnsupportedBuild, "git-build-metadata"):
                        await cache.prepare(self.service)
            disabled = ImagePreparationCache(self.root / "cache", {name: "false"})
            self.assertIn("image", await disabled.prepare(self.service))

    async def test_custom_frontend_arguments_and_source_policies_bypass_warm_cache(self):
        await self.cache.prepare(self.service)
        for reference in ("example.test/frontend:latest", BASE):
            with self.subTest(frontend=reference), self.assertRaisesRegex(UnsupportedBuild, "custom-frontend"):
                await self.cache.prepare({"build": {**self.service["build"], "args": {"BUILDKIT_SYNTAX": reference}}})
        policy = self.root / "source-policy.json"
        for contents in ('{"rules":[]}', '{"rules":[{"action":"DENY"}]}'):
            policy.write_text(contents)
            configured = ImagePreparationCache(self.root / "cache", {"EXPERIMENTAL_BUILDKIT_SOURCE_POLICY": str(policy)})
            with self.subTest(policy=contents), self.assertRaisesRegex(UnsupportedBuild, "source-policy"):
                await configured.prepare(self.service)
        self.assertEqual(len(self.builds), 1)

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
            with self.assertRaisesRegex(UnsupportedBuild, "nondefault-builder"):
                await ImagePreparationCache(self.root / "cache", {}).prepare(self.service)
        self.active_context = "another-docker-context"
        with self.assertRaisesRegex(UnsupportedBuild, "nondefault-builder"):
            await ImagePreparationCache(self.root / "cache", {}).prepare(self.service)
        self.active_context = "unit-test"
        args = self.builds[0]["args"]
        self.assertEqual(args[args.index("--builder") + 1], "unit-test")
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



if __name__ == "__main__": unittest.main(verbosity=2)
