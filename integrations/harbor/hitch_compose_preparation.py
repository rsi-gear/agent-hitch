"""Prepare immutable images and Harbor's own keepalive without pooling tasks."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile

import yaml

from hitch_build_inputs import UnsupportedBuild, build_spec, digest, pinned_dockerfile
from hitch_image_cache import ImagePreparationCache, atomic_json, docker

_DEFAULT_COMMAND = ["sh", "-c", "sleep infinity"]
_MANAGED_COMMAND = ["sh", "-c", 'trap \'kill "$child"; wait "$child"; exit 0\' TERM INT; sleep infinity & child=$!; wait "$child"']


def compose_services(output):
    # Harbor merges stderr into stdout. Benign Compose interpolation warnings
    # may precede the document; only accept a complete trailing JSON object.
    lines = output.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.lstrip().startswith("{"):
            try:
                document = json.loads("".join(lines[index:]))
                if isinstance(document, dict) and isinstance(document.get("services"), dict):
                    return document["services"]
            except ValueError:
                pass
    raise UnsupportedBuild("compose-config-output")


class ComposePreparation:
    def __init__(self, environment, cache_directory=None, build_slots=2, managed_keepalive=False):
        self.environment = environment
        self.cache_directory, self.build_slots = cache_directory, build_slots
        self.managed_keepalive = managed_keepalive
        self.images = {}
        self.overlay = {}
        self.path = None
        self.temporary = None
        self.receipts = []
        self.force_build = False
        self.runtime_prepared = False

    def reset(self, force_build):
        if self.temporary is not None:
            self.temporary.cleanup()
        self.images, self.overlay, self.receipts = {}, {}, []
        self.path, self.temporary = None, None
        self.runtime_prepared, self.force_build = False, force_build
        if force_build and self.cache_directory:
            self.record({"event": "bypass", "reason": "force-build"})

    async def build(self, run):
        if not self.cache_directory or self.force_build:
            return None
        env = self.environment
        cache = ImagePreparationCache(self.cache_directory, env._compose_env_vars(), self.build_slots)
        result = await run(["config", "--format", "json"])
        try:
            services = compose_services(result.stdout)
            builds = {name: value for name, value in services.items() if value.get("build")}
            # A composition with unsupported inputs uses its original build path
            # as a whole, including inter-service dependencies and extra contexts.
            daemon = await cache.identity()
            for service in builds.values():
                context, spec = build_spec(service, cache.env.get("DOCKER_DEFAULT_PLATFORM") or daemon["platform"])
                pinned_dockerfile(context / spec["dockerfile"])
            prepared = {name: await cache.prepare(value) for name, value in builds.items()}
        except UnsupportedBuild as error:
            self.record({"event": "fallback", "reason": str(error)})
            return None
        for name, receipt in prepared.items():
            self.images[name] = receipt["image"]
            self.overlay[name] = {"image": receipt["image"], "build": "__RESET__", "pull_policy": "never"}
            self.record({"event": "image", "service": name, **receipt})
        if prepared:
            self.write_overlay()
        return result.model_copy(update={"stdout": "", "stderr": ""})

    async def runtime(self, run):
        if self.runtime_prepared or not self.managed_keepalive:
            return
        self.runtime_prepared = True
        env = self.environment
        if getattr(env, "_is_windows_container", False) or self.custom_keepalive():
            return
        result = await run(["config", "--format", "json"])
        try:
            service = compose_services(result.stdout)["main"]
        except UnsupportedBuild:
            return
        if service.get("command") != _DEFAULT_COMMAND or service.get("entrypoint"):
            return
        raw = await docker(["image", "inspect", "--format", "{{json .}}", service.get("image") or env._main_image_name],
                           env=env._compose_env_vars(), timeout=30, check=False)
        if not raw:
            return
        image = json.loads(raw)
        config = image.get("Config", {})
        stop_signal = service.get("stop_signal", config.get("StopSignal") or "SIGTERM")
        if image.get("Os") != "linux" or config.get("Entrypoint") or stop_signal not in ("SIGTERM", "SIGINT", "15", "2"):
            return
        self.overlay.setdefault("main", {})["command"] = _MANAGED_COMMAND
        self.write_overlay()
        self.record({"event": "managed-keepalive", "service": "main"})

    def custom_keepalive(self):
        env = self.environment
        for source in [env._environment_docker_compose_path, *env.extra_docker_compose_paths]:
            if source.exists():
                document = yaml.safe_load(source.read_text())
                main = (document or {}).get("services", {}).get("main", {})
                if any(key in main for key in ("command", "entrypoint", "init", "stop_signal", "stop_grace_period", "pre_stop")):
                    return True
        return False

    def write_overlay(self):
        if self.temporary is None:
            self.temporary = tempfile.TemporaryDirectory(prefix="hitch-compose-prepared-")
            self.path = Path(self.temporary.name) / "compose.yaml"
        # Compose interpolates '$' even in JSON/YAML list-form commands.
        content = json.dumps({"services": self.overlay}, sort_keys=True).replace("$", "$$")
        self.path.write_text(content.replace('"build": "__RESET__"', '"build": !reset null'))

    def record(self, value):
        self.receipts.append(value)
        env = self.environment
        env.logger.info("Hitch image preparation: %s", json.dumps(value, sort_keys=True))
        # Host-only evidence; do not expose context paths/args/credentials or
        # mount this cache into candidates, sidecars, or verifier containers.
        directory = env.trial_paths.trial_dir
        directory.mkdir(parents=True, exist_ok=True)
        atomic_json(directory / f"hitch-preparation-{digest(env.session_id)[:16]}.json", {
            "schema_version": "1", "session_id": env.session_id, "events": self.receipts,
        })
