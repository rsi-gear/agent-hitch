"""Inspect Harbor task and Compose resource declarations without starting Docker."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml
from harbor.models.task.config import TaskConfig, VerifierEnvironmentMode


def inspect_task(task_dir: Path) -> dict[str, Any]:
    task_file = task_dir / "task.toml"
    if not task_file.is_file():
        raise ValueError(f"task.toml is missing: {task_file}")
    with task_file.open("rb") as handle:
        config = TaskConfig.model_validate(tomllib.load(handle))
    services = _compose_services(task_dir / "environment" / "docker-compose.yaml")
    if "main" not in {service["name"] for service in services}:
        services.append({"name": "main", "replicas": 1})
    services.sort(key=lambda service: service["name"].encode("utf-8"))

    verifier_mode = config.verifier.environment_mode
    separate = verifier_mode == VerifierEnvironmentMode.SEPARATE or (
        verifier_mode is None and config.verifier.environment is not None
    )
    verifier_environment = config.verifier.environment
    if separate and verifier_environment is None:
        verifier_environment = config.environment
    main_egress = config.environment.os.value == "linux" and any(
        mode is not None and mode.value != "public"
        for mode in (
            config.environment.network_mode,
            config.agent.network_mode,
            None if separate else config.verifier.network_mode,
        )
    )
    verifier_egress = bool(
        separate
        and verifier_environment is not None
        and verifier_environment.os.value == "linux"
        and any(
            mode is not None and mode.value != "public"
            for mode in (verifier_environment.network_mode, config.verifier.network_mode)
        )
    )
    images, fallbacks, builds = _environment_images(
        config.environment, "task", task_dir / "environment"
    )
    if separate and verifier_environment is not None:
        verifier_images, verifier_fallbacks, verifier_builds = _environment_images(
            verifier_environment, "verifier", None
        )
        images.extend(verifier_images)
        fallbacks.extend(verifier_fallbacks)
        builds.extend(verifier_builds)
    compose_images, compose_fallbacks = _compose_images(
        task_dir / "environment" / "docker-compose.yaml"
    )
    images.extend(compose_images)
    fallbacks.extend(compose_fallbacks)
    return {
        "schema_version": "1",
        "task": _environment_resources(config.environment),
        "verifier": {
            "separate": separate,
            **({"environment": _environment_resources(verifier_environment)} if verifier_environment is not None else {}),
        },
        "compose_services": services,
        "provider_sidecars": {
            "main_egress": main_egress,
            "verifier_egress": verifier_egress,
        },
        "environment_images": sorted(
            images, key=lambda entry: (entry["source"], entry["service"])
        ),
        "environment_image_fallbacks": sorted(
            fallbacks, key=lambda entry: (entry["source"], entry["service"])
        ),
        "environment_builds": sorted(
            builds, key=lambda entry: (entry["source"], entry["service"])
        ),
    }


def _environment_resources(environment: Any) -> dict[str, Any]:
    return {
        **({"cpu_millis": environment.cpus * 1000} if environment.cpus is not None else {}),
        **({"memory_bytes": environment.memory_mb * 1024 * 1024} if environment.memory_mb is not None else {}),
    }


def _environment_images(
    environment: Any, source: str, context_dir: Path | None
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]]]:
    reference = getattr(environment, "docker_image", None)
    if reference is None:
        if context_dir is not None and (context_dir / "Dockerfile").is_file():
            return [], [], [{
                "source": source,
                "service": "main",
                "context": "environment",
                "dockerfile": "Dockerfile",
            }]
        return [], [{"source": source, "service": "main", "code": "backend-build"}], []
    if not isinstance(reference, str) or not reference or "$" in reference:
        return [], [{"source": source, "service": "main", "code": "dynamic-image"}], []
    return [{"source": source, "service": "main", "reference": reference}], [], []


def _compose_images(
    compose_file: Path,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    if not compose_file.exists():
        return [], []
    document = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
    if document is None or not isinstance(document, dict):
        return [], []
    raw_services = document.get("services")
    if not isinstance(raw_services, dict):
        return [], []
    images: list[dict[str, str]] = []
    fallbacks: list[dict[str, str]] = []
    for name, raw in raw_services.items():
        if not isinstance(name, str) or not isinstance(raw, dict):
            continue
        reference = raw.get("image")
        if raw.get("build") is not None:
            fallbacks.append({"source": "compose", "service": name, "code": "backend-build"})
        elif isinstance(reference, str) and reference and "$" not in reference:
            images.append({"source": "compose", "service": name, "reference": reference})
        elif reference is not None:
            fallbacks.append({"source": "compose", "service": name, "code": "dynamic-image"})
    return images, fallbacks


def _compose_services(compose_file: Path) -> list[dict[str, Any]]:
    if not compose_file.exists():
        return []
    document = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
    if document is None:
        return []
    if not isinstance(document, dict) or "include" in document:
        raise ValueError("Compose resource discovery requires one mapping without include")
    raw_services = document.get("services")
    if not isinstance(raw_services, dict):
        raise ValueError("Compose services must be a mapping")
    result: list[dict[str, Any]] = []
    for name, raw in raw_services.items():
        if not isinstance(name, str) or not name or not isinstance(raw, dict):
            raise ValueError("Compose service declaration is invalid")
        if raw.get("profiles") or raw.get("extends"):
            raise ValueError(f"Compose resource discovery does not support profiles/extends: {name}")
        deploy = raw.get("deploy") if isinstance(raw.get("deploy"), dict) else {}
        deploy_resources = deploy.get("resources") if isinstance(deploy.get("resources"), dict) else {}
        limits = deploy_resources.get("limits") if isinstance(deploy_resources.get("limits"), dict) else {}
        reservations = deploy_resources.get("reservations") if isinstance(deploy_resources.get("reservations"), dict) else {}
        cpu_values = [_cpu_millis(value, name) for value in (raw.get("cpus"), limits.get("cpus")) if value is not None]
        memory_values = [_memory_bytes(value, name) for value in (raw.get("mem_limit"), limits.get("memory")) if value is not None]
        gpu_values = [_gpu_count(value, name) for value in (raw.get("gpus"), reservations.get("devices")) if value is not None]
        replicas = raw.get("scale", deploy.get("replicas", 1))
        if isinstance(replicas, bool) or not isinstance(replicas, int) or replicas < 1:
            raise ValueError(f"Compose service replicas must be a positive integer: {name}")
        result.append({
            "name": name,
            "replicas": replicas,
            **({"cpu_millis": max(cpu_values)} if cpu_values else {}),
            **({"memory_bytes": max(memory_values)} if memory_values else {}),
            **({"gpu_count": max(gpu_values)} if gpu_values else {}),
        })
    return result


def _gpu_count(value: Any, service: str) -> int:
    if value == "all":
        raise ValueError(f"Compose GPU request must use a fixed count: {service}")
    if not isinstance(value, list) or not value:
        raise ValueError(f"Compose GPU request is invalid: {service}")
    total = 0
    for request in value:
        if not isinstance(request, dict):
            raise ValueError(f"Compose GPU request is invalid: {service}")
        capabilities = request.get("capabilities")
        if not isinstance(capabilities, list) or "gpu" not in capabilities:
            continue
        count = request.get("count")
        device_ids = request.get("device_ids")
        if count is not None and device_ids is not None:
            raise ValueError(f"Compose GPU request cannot set count and device_ids: {service}")
        if device_ids is not None:
            if not isinstance(device_ids, list) or not device_ids or any(not isinstance(item, str) or not item for item in device_ids):
                raise ValueError(f"Compose GPU device_ids are invalid: {service}")
            total += len(device_ids)
        elif isinstance(count, int) and not isinstance(count, bool) and count > 0:
            total += count
        else:
            raise ValueError(f"Compose GPU request must use a fixed count: {service}")
    if total < 1:
        raise ValueError(f"Compose GPU request has no gpu capability: {service}")
    return total


def _cpu_millis(value: Any, service: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"Compose CPU limit is not numeric: {service}")
    try:
        decimal = Decimal(str(value).strip()) * 1000
    except InvalidOperation as error:
        raise ValueError(f"Compose CPU limit is not numeric: {service}") from error
    if decimal != decimal.to_integral_value() or decimal <= 0:
        raise ValueError(f"Compose CPU limit must be positive whole millicores: {service}")
    return int(decimal)


def _memory_bytes(value: Any, service: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Compose memory limit is invalid: {service}")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError(f"Compose memory limit must be positive: {service}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"Compose memory limit is invalid: {service}")
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b?)?\s*", value, re.IGNORECASE)
    if not match:
        raise ValueError(f"Compose memory limit is not a fixed size: {service}")
    unit = (match.group(2) or "b").lower()
    powers = {"b": 0, "k": 1, "kb": 1, "ki": 1, "kib": 1, "m": 2, "mb": 2, "mi": 2, "mib": 2,
              "g": 3, "gb": 3, "gi": 3, "gib": 3, "t": 4, "tb": 4, "ti": 4, "tib": 4,
              "p": 5, "pb": 5, "pi": 5, "pib": 5, "e": 6, "eb": 6, "ei": 6, "eib": 6}
    bytes_value = Decimal(match.group(1)) * (1024 ** powers[unit])
    if bytes_value != bytes_value.to_integral_value() or bytes_value <= 0:
        raise ValueError(f"Compose memory limit is not a whole positive byte size: {service}")
    return int(bytes_value)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: hitch_harbor_task_resources.py <task-directory>")
    print(json.dumps(inspect_task(Path(sys.argv[1]).resolve()), separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
