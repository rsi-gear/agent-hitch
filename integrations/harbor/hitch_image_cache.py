"""Host-local, cross-process preparation cache for resolved Compose builds."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

from hitch_build_inputs import UnsupportedBuild, build_spec, digest, pinned_dockerfile, remove_snapshot, snapshot_context

_IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
_PROXY_NAMES = ("HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY")
_LOCK_FDS = ContextVar("hitch_build_lock_fds", default=())


async def docker(args, *, env, timeout=600, check=True):
    """Keep command lifetime and cache locks tied to the worker's liveness."""
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, "-I", "-B", str(Path(__file__).with_name("hitch_build_process.py")), "docker", *args,
        env=env, start_new_session=True, pass_fds=_LOCK_FDS.get(), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    ))
    process = communication = None
    try:
        # Do not lose ownership if cancellation arrives during process creation.
        process = await asyncio.shield(spawning)
        communication = asyncio.create_task(communicate(process))
        stdout, _ = await asyncio.wait_for(asyncio.shield(communication), timeout)
    except BaseException:
        async def stop():
            owned = process if process is not None else await spawning
            owned.stdin.close()
            await (communication if communication is not None else communicate(owned))

        cleanup = asyncio.create_task(stop())
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                # Repeated cancellation cannot release image/slot locks early.
                pass
        cleanup.result()
        raise
    finally:
        if process is not None:
            process.stdin.close()
    if check and process.returncode:
        # Do not surface build args, proxy credentials or registry stderr.
        raise RuntimeError(f"Hitch image preparation Docker {args[0]} failed ({process.returncode})")
    return stdout.decode("utf-8", errors="strict") if process.returncode == 0 else None


async def communicate(process):
    stdout, stderr = await asyncio.gather(process.stdout.read(), process.stderr.read())
    try:
        # Unlike Process.communicate(), keep stdin open while Docker runs. The
        # supervisor also waits for descendants holding either output pipe.
        process.stdin.write(b"1")
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    await process.wait()
    return stdout, stderr


@asynccontextmanager
async def lock(paths):
    handles = []
    acquired = None
    token = None
    try:
        for path in paths:
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            handles.append(os.fdopen(fd, "a"))
        while acquired is None:
            for handle in handles:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = handle
                    break
                except BlockingIOError:
                    pass
            if acquired is None:
                await asyncio.sleep(0.05)
        token = _LOCK_FDS.set((*_LOCK_FDS.get(), acquired.fileno()))
        yield
    finally:
        if token is not None:
            _LOCK_FDS.reset(token)
        for handle in handles:
            handle.close()


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".record-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path):
    try:
        if path.is_symlink() or path.stat().st_size > 65536:
            return None
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def image_matches_platform(info, platform):
    variants = (None, "", "v8") if platform == "linux/arm64" else (None, "")
    return (isinstance(info, dict)
            and f"{info.get('Os', info.get('os'))}/{info.get('Architecture', info.get('architecture'))}" == platform
            and info.get("Variant", info.get("variant")) in variants)


def recover_contexts(directory):
    # Called under the registry lock. Legacy/unrecognized directories have no
    # ownership proof and are retained. Never use PID age or a time threshold.
    for candidate in directory.glob(".context-*"):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        try:
            fd = os.open(candidate / ".owner.lock", os.O_RDWR | os.O_NOFOLLOW)
        except OSError:
            continue
        with os.fdopen(fd, "a") as owner:
            info = os.fstat(owner.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                continue
            try:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            if candidate.exists():
                remove_snapshot(candidate)


@asynccontextmanager
async def context_snapshot(directory):
    temporary = owner = token = None
    try:
        # Serialize publication of the directory and its already-held lock.
        # No copier/builder starts before ownership has been established.
        async with lock([directory / "context-registry.lock"]):
            recover_contexts(directory)
            temporary = Path(tempfile.mkdtemp(dir=directory, prefix=".context-"))
            fd = os.open(temporary / ".owner.lock", os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            owner = os.fdopen(fd, "a")
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Supervisors inherit this descriptor along with key/slot locks. A
        # dead parent cannot make a live build's context eligible for recovery.
        token = _LOCK_FDS.set((*_LOCK_FDS.get(), owner.fileno()))
        yield temporary
    finally:
        try:
            if temporary is not None:
                remove_snapshot(temporary)
        finally:
            if token is not None:
                _LOCK_FDS.reset(token)
            if owner is not None:
                owner.close()


class ImagePreparationCache:
    def __init__(self, directory, env, slots=2):
        self.directory = Path(directory)
        if not self.directory.is_absolute() or self.directory.resolve() != self.directory:
            raise ValueError("Hitch image cache requires an absolute non-symlink directory")
        if isinstance(slots, bool) or not isinstance(slots, int) or not 1 <= slots <= 64:
            raise ValueError("Hitch image build slots must be between 1 and 64")
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.stat().st_uid != os.getuid() or self.directory.stat().st_mode & 0o022:
            raise ValueError("Hitch image cache must be owned by this user and not writable by others")
        self.env, self.slots, self.daemon = env, slots, None

    async def identity(self):
        if self.env.get("DOCKER_BUILDKIT", "").lower() in ("0", "f", "false"):
            raise UnsupportedBuild("legacy-builder")
        try:
            return await self._identity()
        except UnsupportedBuild:
            raise
        except (RuntimeError, TimeoutError, OSError, ValueError, TypeError, AttributeError) as error:
            # Optional capability probes must not prevent native Compose
            # builds. Actual image build failures remain errors in prepare().
            raise UnsupportedBuild("builder-capabilities") from error

    async def _identity(self):
        # Source policies can deny or remap even digest-pinned base inputs.
        # Their files and external policy dependencies are outside this key.
        if self.env.get("EXPERIMENTAL_BUILDKIT_SOURCE_POLICY") or self.env.get("BUILDX_DEFAULT_POLICY"):
            raise UnsupportedBuild("source-policy")
        # Buildx discovers enclosing Git state from the context's location,
        # which an independent snapshot deliberately does not retain.
        for name in ("BUILDX_GIT_LABELS", "BUILDX_GIT_CHECK_DIRTY"):
            if self.env.get(name, "").lower() not in ("", "0", "f", "false"):
                raise UnsupportedBuild("git-build-metadata")
        if self.daemon is None:
            raw = await docker(["info", "--format", "{{json .}}"], env=self.env, timeout=30)
            data = json.loads(raw)
            architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(data.get("Architecture"), data.get("Architecture"))
            if not data.get("ID") or data.get("OSType") != "linux":
                raise UnsupportedBuild("daemon-platform")
            name = self.env.get("BUILDX_BUILDER")
            if not name:
                inspected = await docker(["buildx", "inspect"], env=self.env, timeout=30)
                match = re.search(r"(?m)^Name:\s+(\S+)", inspected)
                name = match[1] if match else None
            # Human inspect output iterates driver-option maps in random order.
            # Use structured data and discard activity, status and GC counters.
            listing = await docker(["buildx", "ls", "--format", "{{json .}}"], env=self.env, timeout=30)
            builders = [json.loads(line) for line in listing.splitlines() if line.strip()]
            selected = next((entry for entry in builders if entry.get("Name") == name), None)
            if not selected or not selected.get("Driver") or not selected.get("Nodes"):
                raise UnsupportedBuild("builder-identity")
            # A custom builder can run on a different architecture and have
            # different defaults from the daemon Compose will use. Optimize
            # only the current Docker context's built-in builder; let native
            # Compose select and configure all other builders.
            if selected["Driver"] != "docker" or (await docker(["context", "show"], env=self.env, timeout=30)).strip() != name:
                raise UnsupportedBuild("nondefault-builder")
            nodes = []
            for node in selected["Nodes"]:
                normalized = {key: node.get(key) for key in ("Name", "Endpoint", "DriverOpts", "Flags", "Version", "ProxyConfig", "Labels")}
                normalized.update({key: sorted(node.get(key) or []) for key in ("Platforms", "IDs")})
                nodes.append(normalized)
            builder = {"name": name, "driver": selected["Driver"], "nodes": sorted(nodes, key=lambda n: str(n["Name"]))}
            config = Path(self.env.get("DOCKER_CONFIG") or str(Path(self.env.get("HOME") or Path.home()) / ".docker")) / "config.json"
            try:
                proxies = json.loads(config.read_text()).get("proxies", {})
            except FileNotFoundError:
                proxies = {}
            except (OSError, ValueError, AttributeError) as error:
                raise UnsupportedBuild("docker-client-config") from error
            self.daemon = {"id": data["ID"], "platform": f"linux/{architecture}", "builder": digest(builder), "builder_name": name, "proxy_config": digest(proxies)}
        return self.daemon

    async def inspect(self, image, *, platform=None):
        selection = ["--platform", platform] if platform else []
        raw = await docker(["image", "inspect", *selection, "--format", "{{json .}}", image], env=self.env, timeout=30, check=False)
        return json.loads(raw) if raw else None

    async def _inspect_for_reuse(self, image, *, platform=None):
        try:
            return await self.inspect(image, platform=platform)
        except (TimeoutError, OSError, ValueError) as error:
            # A failed optional probe cannot certify reuse, but must not block
            # native Compose. Post-build verification remains strict below.
            raise UnsupportedBuild("image-inspection") from error

    async def check_bases(self, bases, platform):
        # Digest-pinned base definitions can contain inherited ONBUILD triggers.
        # Inspect the immutable config once; a registry error falls back to Harbor.
        for base in bases:
            # Older receipts did not validate variant selection.
            key = digest(["base-v2", base, platform])
            path = self.directory / f"base-{key}.json"
            async with lock([self.directory / f"base-{key}.lock"]):
                cached = read_json(path)
                if cached == {"base": base, "platform": platform, "no_onbuild": True}:
                    continue
                # Ask Docker to select the requested index member. A default
                # inspection can refer to another pre-pulled variant, even
                # when its config omits the optional Variant field. Older
                # daemons lacking this option use the registry/fallback path.
                info = await self._inspect_for_reuse(base, platform=platform)
                if not image_matches_platform(info, platform):
                    try:
                        raw = await docker(["buildx", "imagetools", "inspect", base, "--format", "{{json .Image}}"], env=self.env, timeout=30)
                        info = json.loads(raw)
                        info = info.get(platform, info)
                        config = info.get("config")
                        if not isinstance(config, dict) or not image_matches_platform(info, platform):
                            raise UnsupportedBuild("base-platform")
                    except (RuntimeError, asyncio.TimeoutError, OSError, ValueError, AttributeError) as error:
                        raise UnsupportedBuild("base-config-unavailable") from error
                else:
                    config = info.get("Config", {})
                if config.get("OnBuild") or config.get("onbuild"):
                    raise UnsupportedBuild("inherited-onbuild")
                atomic_json(path, {"base": base, "platform": platform, "no_onbuild": True})

    async def prepare(self, service):
        started = time.monotonic()
        phases = {}
        daemon = await self.identity()
        source, spec = build_spec(service, self.env.get("DOCKER_DEFAULT_PLATFORM") or daemon["platform"])
        if self.directory.is_relative_to(source):
            raise UnsupportedBuild("cache-inside-context")
        async with context_snapshot(self.directory) as temporary:
            context = temporary / "context"
            phase = time.monotonic()
            context_digest = await snapshot_context(source, context, spec["dockerfile"])
            phases["snapshot_seconds"] = time.monotonic() - phase
            bases = pinned_dockerfile(context / spec["dockerfile"])
            phase = time.monotonic()
            await self.check_bases(bases, spec["platform"])
            phases["base_check_seconds"] = time.monotonic() - phase
            implicit = {name: self.env.get(name) for name in (
                "BUILDX_BUILDER", "BUILDKIT_HOST", "SOURCE_DATE_EPOCH",
                *_PROXY_NAMES, *(name.lower() for name in _PROXY_NAMES),
            )}
            implicit.update({name: value for name, value in self.env.items() if name.startswith(("BUILDX_", "BUILDKIT_"))})
            key = digest({"schema": 2, "context": context_digest, "build": spec, "daemon": daemon,
                          "implicit": implicit})
            record = self.directory / f"image-{key}.json"
            tag = f"hitch-prepared:{digest(str(self.directory))[:16]}-{key}"
            phase = time.monotonic()
            async with lock([self.directory / f"image-{key}.lock"]):
                phases["key_lock_wait_seconds"] = time.monotonic() - phase
                cached = read_json(record)
                if isinstance(cached, dict) and cached.get("key") == key and _IMAGE_ID.fullmatch(str(cached.get("image"))):
                    phase = time.monotonic()
                    info = await self._inspect_for_reuse(cached["image"])
                    phases["probe_seconds"] = time.monotonic() - phase
                    if self.valid_image(info, key, spec["platform"]):
                        return {"image": info["Id"], "cache_key": key, "cache_hit": True, "seconds": time.monotonic() - started, "phases": phases}
                slots = [self.directory / f"slot-{digest(daemon['id'])}-{index}.lock" for index in range(self.slots)]
                phase = time.monotonic()
                async with lock(slots):
                    phases["build_slot_wait_seconds"] = time.monotonic() - phase
                    args = ["buildx", "build", "--builder", daemon["builder_name"], "--load", "--progress", "plain", "--platform", spec["platform"],
                            "--file", str(context / spec["dockerfile"]), "--tag", tag]
                    if spec["target"]:
                        args.extend(["--target", spec["target"]])
                    for key_name, value in sorted(spec["args"].items()):
                        args.extend(["--build-arg", f"{key_name}={value}"])
                    for key_name, value in sorted(spec["labels"].items()):
                        args.extend(["--label", f"{key_name}={value}"])
                    args.extend(["--label", f"io.hitch.prepared-key={key}", str(context)])
                    phase = time.monotonic()
                    await docker(args, env=self.env, timeout=None)
                    phases["build_seconds"] = time.monotonic() - phase
                    info = await self.inspect(tag)
                    if not self.valid_image(info, key, spec["platform"]):
                        raise RuntimeError("Hitch prepared image identity/platform mismatch")
                    atomic_json(record, {"key": key, "image": info["Id"], "platform": spec["platform"], "tag": tag})
                    return {"image": info["Id"], "cache_key": key, "cache_hit": False, "seconds": time.monotonic() - started, "phases": phases}

    @staticmethod
    def valid_image(info, key, platform):
        return (isinstance(info, dict) and _IMAGE_ID.fullmatch(str(info.get("Id")))
                and image_matches_platform(info, platform)
                and (info.get("Config", {}).get("Labels") or {}).get("io.hitch.prepared-key") == key)
