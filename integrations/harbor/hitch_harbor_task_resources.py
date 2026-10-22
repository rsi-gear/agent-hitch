"""Inspect Harbor task and Compose resource declarations without starting Docker."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from importlib.metadata import PackageNotFoundError, version
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml
from harbor.models.task.config import TaskConfig, VerifierEnvironmentMode
from harbor.models.task.verifier_mode import (
    resolve_effective_verifier_env_config,
    resolve_task_verifier_mode,
)


def inspect_task(task_dir: Path) -> dict[str, Any]:
    try:
        backend_version = version("harbor")
    except PackageNotFoundError:
        backend_version = None
    task_file = task_dir / "task.toml"
    if not task_file.is_file():
        raise ValueError(f"task.toml is missing: {task_file}")
    with task_file.open("rb") as handle:
        raw_config = tomllib.load(handle)
    config = TaskConfig.model_validate(raw_config)
    if getattr(config, "steps", None):
        raise ValueError("multi_step_resource_topology_unsupported: step environments cannot be bounded by the single-step resource contract")
    _validate_native_topology(raw_config)
    services = _compose_services(task_dir / "environment" / "docker-compose.yaml")
    runtime_platform = _compose_runtime_platform(
        task_dir / "environment" / "docker-compose.yaml"
    )
    if "main" not in {service["name"] for service in services}:
        services.append({"name": "main", "replicas": 1})
    services.sort(key=lambda service: service["name"].encode("utf-8"))

    verifier_mode = resolve_task_verifier_mode(config)
    separate = verifier_mode == VerifierEnvironmentMode.SEPARATE
    verifier_environment = resolve_effective_verifier_env_config(config, None)
    # A separate verifier uses tests/ as its own Docker build context. The
    # current resource overlay can enforce its main container, but cannot yet
    # enforce independent limits on verifier-owned Compose sidecars. Never
    # silently model that topology as a single verifier container.
    if separate and (task_dir / "tests" / "docker-compose.yaml").exists():
        raise ValueError("verifier_compose_topology_unsupported: separate verifier Compose environments require a resource overlay capability")
    dependencies = _verifier_dependencies(task_dir, config, services, separate)
    main_egress = _requires_egress(
        config.environment,
        [config.agent.network_mode] if separate else [config.agent.network_mode, config.verifier.network_mode],
        task_dir / "environment" / "docker-compose.yaml",
    )
    verifier_egress = bool(
        separate
        and verifier_environment is not None
        and _requires_egress(verifier_environment, [config.verifier.network_mode], task_dir / "tests" / "docker-compose.yaml")
    )
    images, fallbacks, builds = _environment_images(
        config.environment, "task", task_dir / "environment", "environment"
    )
    if separate and verifier_environment is not None:
        verifier_images, verifier_fallbacks, verifier_builds = _environment_images(
            verifier_environment, "verifier", task_dir / "tests", "tests"
        )
        images.extend(verifier_images)
        fallbacks.extend(verifier_fallbacks)
        builds.extend(verifier_builds)
    compose_images, compose_fallbacks, compose_builds = _compose_images(
        task_dir / "environment" / "docker-compose.yaml"
    )
    images.extend(compose_images)
    fallbacks.extend(compose_fallbacks)
    if any(entry["service"] == "main" and entry["code"] == "backend-build" for entry in compose_fallbacks):
        # The native main definition may contain args, aliases or another
        # context. A default Dockerfile prebuild must not override that choice.
        builds = [entry for entry in builds if entry["source"] != "task"]
    builds.extend(compose_builds)
    return {
        "schema_version": "1",
        **({"backend_version": backend_version} if backend_version else {}),
        **({"runtime_platform": runtime_platform} if runtime_platform is not None else {}),
        "task": _environment_resources(config.environment),
        "verifier": {
            "separate": separate,
            **({"environment": _environment_resources(verifier_environment)} if verifier_environment is not None else {}),
        },
        "compose_services": services,
        "verifier_compose_services": [{"name": "main", "replicas": 1}] if separate else [],
        **({"lifecycle": {
            "contract": "harbor-native-docker-single-step-v1",
            "capability": "phase-exclusive-teardown-v1",
            "verifier_mode": "separate" if separate else "shared",
            "verifier_dependencies": dependencies,
        }} if config.environment.os.value == "linux" and (
            verifier_environment is None or verifier_environment.os.value == "linux"
        ) else {}),
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


def _requires_egress(environment: Any, phase_modes: list[Any], compose_file: Path) -> bool:
    if environment.os.value != "linux":
        return False
    baseline = environment.network_mode
    # Match HitchHarborDockerEnvironment._static_no_network. A no-network
    # policy cannot have allowed_hosts, so equal modes imply equal policies.
    # Hitch's supported job config supplies no extra host/Compose overrides.
    if (baseline.value == "no-network" and not compose_file.exists()
            and all(mode is None or mode.value == "no-network" for mode in phase_modes)):
        return False
    return any(mode is not None and mode.value != "public" for mode in [baseline, *phase_modes])


def _validate_native_topology(raw_config: dict[str, Any]) -> None:
    """TaskConfig permits unknown keys; topology-changing extras must not vanish."""
    environments = [raw_config.get("environment", {})]
    verifier = raw_config.get("verifier", {})
    if isinstance(verifier, dict):
        environments.append(verifier.get("environment", {}))
    for environment in environments:
        if isinstance(environment, dict) and any(key in environment for key in (
            "type", "class_path", "import_path", "kwargs", "extra_docker_compose",
            "extra_docker_compose_paths", "environment_dir",
        )):
            raise ValueError("custom_environment_topology_unsupported: task environment contains provider-specific topology")


def _strict_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"hitch.resources.json contains a duplicate field: {key}")
        result[key] = value
    return result


def _artifact_dependency(service: Any, source: Any) -> dict[str, str]:
    if not isinstance(service, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", service):
        raise ValueError("verifier_artifact_dependency_invalid: service must be a fixed Compose service name")
    if (not isinstance(source, str) or not source.startswith("/") or any(char in source for char in "\x00\r\n")
            or any(char in source for char in "*$?[]{}")
            or ".." in source.replace("\\", "/").split("/")):
        raise ValueError("verifier_artifact_dependency_invalid: artifact source must be a fixed path (absolute, without control characters)")
    return {"service": service, "path": source}


def _verifier_dependencies(
    task_dir: Path, config: Any, services: list[dict[str, Any]], separate: bool,
) -> dict[str, Any]:
    service_names = {entry["name"] for entry in services}
    artifacts = []
    for artifact in getattr(config, "artifacts", []):
        source = artifact if isinstance(artifact, str) else artifact.source
        service = "main" if isinstance(artifact, str) else (artifact.service or "main")
        entry = _artifact_dependency(service, source)
        if service not in service_names:
            raise ValueError(f"verifier_artifact_service_missing: {service}")
        artifacts.append(entry)
    for hook in getattr(config.verifier, "collect", []):
        if hook.service not in service_names:
            raise ValueError(f"verifier_collect_service_missing: {hook.service}")
    key = lambda entry: (entry["service"], entry["path"])
    artifacts.sort(key=key)
    if len({key(entry) for entry in artifacts}) != len(artifacts):
        raise ValueError("verifier_artifact_dependency_invalid: duplicate native artifact")
    result = {
        "inputs": "artifacts-only" if separate else "backend-defined",
        "live_services": [],
        "artifacts": artifacts,
    }
    extension = task_dir / "hitch.resources.json"
    if not extension.exists() and not extension.is_symlink():
        return result
    if extension.is_symlink() or not extension.is_file() or extension.stat().st_size > 1024 * 1024:
        raise ValueError("hitch.resources.json must be a regular file of at most 1 MiB")
    declaration = json.loads(extension.read_text(encoding="utf-8"), object_pairs_hook=_strict_json_object)
    if (not isinstance(declaration, dict) or set(declaration) != {"schema_version", "verifier_dependencies"}
            or declaration["schema_version"] != "1"):
        raise ValueError("hitch.resources.json fields or schema_version are invalid")
    dependency = declaration["verifier_dependencies"]
    if not isinstance(dependency, dict) or set(dependency) != {"inputs", "live_services", "artifacts"}:
        raise ValueError("hitch.resources.json verifier_dependencies fields are invalid")
    inputs, live, declared = dependency["inputs"], dependency["live_services"], dependency["artifacts"]
    if inputs not in {"artifacts-only", "live-services", "backend-defined"} or not isinstance(live, list) or not isinstance(declared, list):
        raise ValueError("hitch.resources.json verifier_dependencies values are invalid")
    if any(not isinstance(name, str) or name not in service_names for name in live) or len(set(live)) != len(live):
        raise ValueError("verifier_live_dependency_invalid: services must name unique existing agent services")
    if (inputs == "artifacts-only" and live) or (inputs == "live-services" and not live):
        raise ValueError("verifier_dependency_conflict: inputs and live_services disagree")
    if live or inputs == "live-services":
        raise ValueError("verifier_live_dependency_unsupported: this native resource contract cannot retain live agent services for a separate verifier")
    if not separate and inputs == "artifacts-only":
        raise ValueError("verifier_dependency_conflict: shared verification uses the live agent environment")
    normalized = []
    for entry in declared:
        if not isinstance(entry, dict) or set(entry) != {"service", "path"}:
            raise ValueError("hitch.resources.json artifact fields are invalid")
        normalized.append(_artifact_dependency(entry["service"], entry["path"]))
    if sorted(normalized, key=key) != artifacts:
        raise ValueError("verifier_artifact_dependency_mismatch: extension artifacts must match native task artifacts")
    # backend-defined delegates to the resolved native single-step semantics.
    return result


def _compose_runtime_platform(compose_file: Path) -> str | None:
    if not compose_file.exists():
        return None
    document = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        return None
    services = document.get("services")
    main = services.get("main") if isinstance(services, dict) else None
    raw = main.get("platform") if isinstance(main, dict) else None
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError("Compose main platform must be a string")
    normalized = {
        "linux/x86_64": "linux/amd64",
        "linux/aarch64": "linux/arm64",
    }.get(raw.strip().lower(), raw.strip().lower())
    if normalized not in {"linux/amd64", "linux/arm64"}:
        raise ValueError(f"Compose main platform is unsupported: {raw}")
    return normalized


def _environment_resources(environment: Any) -> dict[str, Any]:
    gpus = getattr(environment, "gpus", None)
    if gpus is not None and (isinstance(gpus, bool) or not isinstance(gpus, int) or gpus < 0):
        raise ValueError("Environment GPU request must use a fixed nonnegative count")
    if gpus:
        raise ValueError("native_gpu_resource_topology_unsupported: native environment GPU declarations require a device-aware execution contract")
    return {
        **({"cpu_millis": environment.cpus * 1000} if environment.cpus is not None else {}),
        **({"memory_bytes": environment.memory_mb * 1024 * 1024} if environment.memory_mb is not None else {}),
        **({"gpu_count": gpus} if gpus else {}),
    }


def _environment_images(
    environment: Any, source: str, context_dir: Path, context: str
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]]]:
    reference = getattr(environment, "docker_image", None)
    # Native Compose may override the default main build, image or platform.
    # Independent verifier Compose requires its own discovery contract.
    if source == "verifier" and (context_dir / "docker-compose.yaml").exists():
        return [], [{"source": source, "service": "main", "code": "backend-build"}], []
    if reference is None:
        dockerfile = context_dir / "Dockerfile"
        if (dockerfile.is_file() and context_dir.resolve() == context_dir.absolute()
                and dockerfile.resolve() == dockerfile.absolute()):
            return [], [], [{
                "source": source,
                "service": "main",
                "context": context,
                "dockerfile": "Dockerfile",
            }]
        return [], [{"source": source, "service": "main", "code": "backend-build"}], []
    if not isinstance(reference, str) or not reference or "$" in reference:
        return [], [{"source": source, "service": "main", "code": "dynamic-image"}], []
    return [{"source": source, "service": "main", "reference": reference}], [], []


def _compose_images(
    compose_file: Path,
) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]]]:
    if not compose_file.exists():
        return [], [], []
    document = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
    if document is None or not isinstance(document, dict):
        return [], [], []
    raw_services = document.get("services")
    if not isinstance(raw_services, dict):
        return [], [], []
    images: list[dict[str, str]] = []
    fallbacks: list[dict[str, str]] = []
    builds = None if "include" in document or "extends" in document else _independent_compose_builds(raw_services, compose_file.parent)
    for name, raw in raw_services.items():
        if not isinstance(name, str) or not isinstance(raw, dict):
            continue
        reference = raw.get("image")
        if raw.get("build") is not None:
            if builds is None:
                fallbacks.append({"source": "compose", "service": name, "code": "backend-build"})
        elif isinstance(reference, str) and reference and "$" not in reference:
            images.append({"source": "compose", "service": name, "reference": reference})
        elif reference is not None:
            fallbacks.append({"source": "compose", "service": name, "code": "dynamic-image"})
    return images, fallbacks, builds or []


def _independent_compose_builds(services, environment):
    """Only prebuild the plain unnamed topology; other Compose inputs stay native.

    Named images can consume another service's generated project tag. Reject
    the whole composition rather than infer aliases before Compose resolves it.
    Main must be the same Dockerfile already handled by task image planning.
    """
    builds = []
    try:
        for name, service in services.items():
            if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}", name):
                return None
            if not isinstance(service, dict) or service.get("image") or "extends" in service or "profiles" in service:
                return None
            for mount in service.get("volumes") or []:
                if isinstance(mount, dict) and mount.get("type") == "image":
                    return None
            build = service.get("build")
            if build is None:
                continue
            if service.get("pull_policy") is not None:
                return None
            if isinstance(build, str):
                build = {"context": build}
            if not isinstance(build, dict) or set(build) - {"context", "dockerfile"}:
                return None
            context = build.get("context", ".")
            dockerfile = build.get("dockerfile", "Dockerfile")
            if any(not isinstance(value, str) or not value or any(c in value for c in ("$", "\\", "\0"))
                   or Path(value).is_absolute() or ".." in Path(value).parts for value in (context, dockerfile)):
                return None
            if any(part in ("", ".", "..") for part in dockerfile.split("/")):
                return None
            directory = environment / context
            if directory.resolve() != directory.absolute() or not directory.is_dir():
                return None
            source = directory / dockerfile
            if source.resolve() != source.absolute() or not source.is_file():
                return None
            platform = service.get("platform")
            if platform not in ("linux/amd64", "linux/arm64"):
                # A project .env can change Docker's default platform. Only an
                # explicit service platform is independent of those defaults.
                return None
            relative_context = directory.relative_to(environment).as_posix()
            if name == "main":
                if relative_context != "." or dockerfile != "Dockerfile":
                    return None
                continue
            builds.append({"source": "compose", "service": name,
                           "context": (Path("environment") / relative_context).as_posix(), "dockerfile": dockerfile,
                           **({"platform": platform} if platform else {})})
    except (OSError, ValueError):
        return None
    return builds


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
        if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", name) or not isinstance(raw, dict):
            raise ValueError("Compose service declaration is invalid")
        if any(key in raw for key in ("profiles", "extends", "provider")):
            raise ValueError(f"Compose resource discovery does not support profiles/extends/provider: {name}")
        if "deploy" in raw and not isinstance(raw["deploy"], dict):
            raise ValueError(f"Compose deploy must be a fixed mapping: {name}")
        deploy = raw.get("deploy") if isinstance(raw.get("deploy"), dict) else {}
        restart_policy = deploy.get("restart_policy")
        if raw.get("restart", "no") not in ("no", False) or (restart_policy is not None and (
            not isinstance(restart_policy, dict) or restart_policy.get("condition", "any") != "none"
        )):
            raise ValueError(f"Compose automatic restart is unsupported by the phase lifecycle: {name}")
        if deploy.get("mode", "replicated") != "replicated":
            raise ValueError(f"Compose deployment mode must use bounded replicas: {name}")
        if "scale" in raw and "replicas" in deploy and raw["scale"] != deploy["replicas"]:
            raise ValueError(f"Compose replicas declarations conflict: {name}")
        if "resources" in deploy and not isinstance(deploy["resources"], dict):
            raise ValueError(f"Compose resources must be a fixed mapping: {name}")
        deploy_resources = deploy.get("resources") if isinstance(deploy.get("resources"), dict) else {}
        if any(key in deploy_resources and not isinstance(deploy_resources[key], dict) for key in ("limits", "reservations")):
            raise ValueError(f"Compose resource limits/reservations must be fixed mappings: {name}")
        limits = deploy_resources.get("limits") if isinstance(deploy_resources.get("limits"), dict) else {}
        reservations = deploy_resources.get("reservations") if isinstance(deploy_resources.get("reservations"), dict) else {}
        cpu_values = [_cpu_millis(value, name) for value in (raw.get("cpus"), limits.get("cpus")) if value is not None]
        memory_values = [_memory_bytes(value, name) for value in (raw.get("mem_limit"), limits.get("memory")) if value is not None]
        gpu_values = [_gpu_count(value, name) for value in (raw.get("gpus"), reservations.get("devices")) if value is not None]
        replicas = raw.get("scale", deploy.get("replicas", 1))
        if isinstance(replicas, bool) or not isinstance(replicas, int) or replicas < 1:
            raise ValueError(f"Compose service replicas must be a positive integer: {name}")
        if name == "main" and replicas != 1:
            raise ValueError("Compose main requires exactly one replica for native execution")
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
    if not decimal.is_finite() or decimal != decimal.to_integral_value() or decimal <= 0:
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
