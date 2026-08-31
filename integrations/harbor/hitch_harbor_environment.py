"""Harbor Docker environment that stamps lease ownership on Compose resources."""

from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path
from typing import Any, Mapping

import yaml
from harbor.constants import MAIN_SERVICE_NAME
from harbor.environments.docker.docker import DockerEnvironment

_LABEL_ROOT = "io.hitch.root-id"
_LABEL_PROVIDER = "io.hitch.provider"
_LABEL_EVAL = "io.hitch.eval-id"
_LABEL_WORK = "io.hitch.work-id"
_LABEL_LEASE = "io.hitch.lease-id"
_LABEL_EPOCH = "io.hitch.lease-epoch"
_LABEL_TASK = "io.hitch.task-id"
_REQUIRED_LABELS = {
    _LABEL_ROOT,
    _LABEL_PROVIDER,
    _LABEL_EVAL,
    _LABEL_WORK,
    _LABEL_LEASE,
    _LABEL_EPOCH,
}
_ALLOWED_LABELS = _REQUIRED_LABELS | {_LABEL_TASK}


class HitchHarborDockerEnvironment(DockerEnvironment):
    """Use Harbor's Docker semantics with a final ownership-label overlay."""

    def __init__(
        self,
        *args: Any,
        hitch_ownership_labels: Mapping[str, str] | None = None,
        hitch_service_resource_limits: Mapping[str, Mapping[str, int]] | None = None,
        hitch_resolved_images: Mapping[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        self._hitch_ownership_labels = _validate_labels(hitch_ownership_labels)
        self._hitch_service_resource_limits = _validate_resource_limits(
            hitch_service_resource_limits
        )
        self._hitch_resolved_images = _validate_resolved_images(hitch_resolved_images)
        self._hitch_ownership_temp_dir: tempfile.TemporaryDirectory[str] | None = None
        self._hitch_ownership_compose_path: Path | None = None
        positional = list(args)
        task_env_config = kwargs.get("task_env_config")
        task_env_position: int | None = None
        if task_env_config is None and len(positional) >= 5:
            task_env_position = 4
            task_env_config = positional[task_env_position]
        if task_env_config is not None:
            requested = getattr(task_env_config, "docker_image", None)
            resolved = self._hitch_resolved_images.get(requested)
            if resolved is not None:
                updated = task_env_config.model_copy(update={"docker_image": resolved})
                if task_env_position is None:
                    kwargs["task_env_config"] = updated
                else:
                    positional[task_env_position] = updated
        super().__init__(*positional, **kwargs)
        if (
            self._hitch_ownership_labels
            or self._hitch_service_resource_limits
            or self._hitch_resolved_images
        ):
            self._hitch_ownership_compose_path = self._write_ownership_overlay()

    @property
    def _docker_compose_paths(self) -> list[Path]:
        paths = list(super()._docker_compose_paths)
        if self._hitch_ownership_compose_path is not None:
            paths.append(self._hitch_ownership_compose_path)
        return paths

    def _write_ownership_overlay(self) -> Path:
        services = {MAIN_SERVICE_NAME}
        if self._enable_egress_control:
            services.add(self._EGRESS_CONTROL_SERVICE_NAME)
        networks = {"default"}
        volumes: set[str] = set()
        external_networks: set[str] = set()
        external_volumes: set[str] = set()
        image_overlays: dict[str, str] = {}
        sources = [self._environment_docker_compose_path, *self.extra_docker_compose_paths]
        for source in sources:
            if not source.exists():
                continue
            document = yaml.safe_load(source.read_text(encoding="utf-8"))
            if document is None:
                continue
            if not isinstance(document, dict):
                raise ValueError(f"Docker Compose ownership source must be a mapping: {source}")
            services.update(_mapping_names(document.get("services"), "services", source))
            for name, config in (document.get("services") or {}).items():
                if isinstance(config, dict):
                    reference = config.get("image")
                    resolved = self._hitch_resolved_images.get(reference)
                    if resolved is not None:
                        image_overlays[name] = resolved
                    elif reference is not None:
                        image_overlays.pop(name, None)
            _collect_resources(document.get("networks"), networks, external_networks, "networks", source)
            _collect_resources(document.get("volumes"), volumes, external_volumes, "volumes", source)

        labels = dict(self._hitch_ownership_labels)
        service_overlays: dict[str, dict[str, Any]] = {}
        for name in sorted(services):
            config: dict[str, Any] = {}
            if labels:
                config["labels"] = labels
            resolved_image = image_overlays.get(name)
            if resolved_image is not None:
                config["image"] = resolved_image
            if name != MAIN_SERVICE_NAME and self._hitch_service_resource_limits:
                limits = self._hitch_service_resource_limits.get(name)
                if limits is None:
                    raise ValueError(
                        f"Docker Compose sidecar has no Hitch resource limit: {name}"
                    )
                config.update({
                    "cpus": limits["cpu_millis"] / 1000,
                    "mem_limit": limits["memory_bytes"],
                })
            service_overlays[name] = config
        overlay = {
            "services": service_overlays,
            "networks": {
                name: {"labels": labels}
                for name in sorted(networks - external_networks)
            },
            "volumes": {
                name: {"labels": labels}
                for name in sorted(volumes - external_volumes)
            },
        }
        self._hitch_ownership_temp_dir = tempfile.TemporaryDirectory(
            prefix="hitch-harbor-ownership-"
        )
        target = Path(self._hitch_ownership_temp_dir.name) / "docker-compose-hitch-ownership.json"
        target.write_text(json.dumps(overlay, indent=2, sort_keys=True), encoding="utf-8")
        return target


def _mapping_names(value: Any, label: str, source: Path) -> set[str]:
    if value is None:
        return set()
    if not isinstance(value, dict) or any(not isinstance(name, str) or not name for name in value):
        raise ValueError(f"Docker Compose {label} must be a named mapping: {source}")
    return set(value)


def _collect_resources(
    value: Any,
    names: set[str],
    external: set[str],
    label: str,
    source: Path,
) -> None:
    for name in _mapping_names(value, label, source):
        names.add(name)
        config = value[name]
        if isinstance(config, dict) and bool(config.get("external")):
            external.add(name)


def _validate_labels(value: Mapping[str, str] | None) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping) or set(value) - _ALLOWED_LABELS or not _REQUIRED_LABELS <= set(value):
        raise ValueError("Hitch Docker ownership label fields are invalid")
    labels = dict(value)
    if (
        not re.fullmatch(r"[a-f0-9]{24}", labels.get(_LABEL_ROOT, ""))
        or labels.get(_LABEL_PROVIDER) != "local-docker"
        or not re.fullmatch(r"eval_[a-f0-9]{32}", labels.get(_LABEL_EVAL, ""))
        or not re.fullmatch(r"work_[a-f0-9]{32}", labels.get(_LABEL_WORK, ""))
        or not re.fullmatch(r"lease_[a-f0-9]{32}", labels.get(_LABEL_LEASE, ""))
        or not re.fullmatch(r"[1-9][0-9]*", labels.get(_LABEL_EPOCH, ""))
        or any(not isinstance(entry, str) or not entry or len(entry) > 4096 or "\x00" in entry or "\n" in entry or "\r" in entry for entry in labels.values())
    ):
        raise ValueError("Hitch Docker ownership label values are invalid")
    return dict(sorted(labels.items()))


def _validate_resource_limits(
    value: Mapping[str, Mapping[str, int]] | None,
) -> dict[str, dict[str, int]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("Hitch Docker service resource limits are invalid")
    result: dict[str, dict[str, int]] = {}
    for name, resources in value.items():
        if (
            not isinstance(name, str)
            or not name
            or name == MAIN_SERVICE_NAME
            or len(name) > 255
            or any(character in name for character in ("\x00", "\n", "\r"))
            or not isinstance(resources, Mapping)
            or set(resources) != {"cpu_millis", "memory_bytes"}
            or isinstance(resources.get("cpu_millis"), bool)
            or not isinstance(resources.get("cpu_millis"), int)
            or resources["cpu_millis"] < 1
            or isinstance(resources.get("memory_bytes"), bool)
            or not isinstance(resources.get("memory_bytes"), int)
            or resources["memory_bytes"] < 1
        ):
            raise ValueError("Hitch Docker service resource limits are invalid")
        result[name] = {
            "cpu_millis": resources["cpu_millis"],
            "memory_bytes": resources["memory_bytes"],
        }
    return dict(sorted(result.items()))


def _validate_resolved_images(value: Mapping[str, str] | None) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("Hitch resolved image mapping is invalid")
    result: dict[str, str] = {}
    for requested, resolved in value.items():
        if (
            not _valid_image_reference(requested)
            or not _valid_image_reference(resolved)
            or re.search(r"@sha256:[a-f0-9]{64}$", resolved) is None
            or _image_repository(requested) != _image_repository(resolved)
        ):
            raise ValueError("Hitch resolved image mapping is invalid")
        result[requested] = resolved
    return dict(sorted(result.items()))


def _valid_image_reference(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= 1024
        and not any(character.isspace() or character == "\x00" for character in value)
        and "://" not in value
        and "$" not in value
    )


def _image_repository(reference: str) -> str:
    without_digest = reference.split("@", 1)[0]
    slash = without_digest.rfind("/")
    colon = without_digest.rfind(":")
    return without_digest[:colon] if colon > slash else without_digest
