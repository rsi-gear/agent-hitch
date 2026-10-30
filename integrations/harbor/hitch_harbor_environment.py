"""Harbor Docker environment that stamps lease ownership on Compose resources."""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
from contextlib import AsyncExitStack, asynccontextmanager
from functools import wraps
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
_LABEL_ROLE = "io.hitch.environment-role"
_REQUIRED_LABELS = {
    _LABEL_ROOT,
    _LABEL_PROVIDER,
    _LABEL_EVAL,
    _LABEL_WORK,
    _LABEL_LEASE,
    _LABEL_EPOCH,
}
_ALLOWED_LABELS = _REQUIRED_LABELS | {_LABEL_TASK}
_COMPOSE_RESET_MARKER = "__HITCH_COMPOSE_RESET_NULL__"
_GPU_OVERRIDE_PREFIX = "__HITCH_GPU_OVERRIDE_"
_HOST_CREDENTIAL_HELPER_ENV = "HITCH_HOST_CREDENTIAL_HELPER_JSON"


class _SharedRuntimeConfigurationError(ValueError):
    """No candidate was started; cleanup must preserve existing images."""


def _candidate_session(session_id: str, trial_name: str | None) -> bool:
    # Keep role selection self-contained: historical verifier repairs replace
    # only this provider and retain the original runtime's module membership.
    # Verifier sessions may truncate their role marker or use a step named env.
    if trial_name is not None:
        return session_id == f"{trial_name}__env"
    return session_id.endswith("__env") and "__verifier__" not in session_id


class HitchHarborDockerEnvironment(DockerEnvironment):
    """Use Harbor's Docker semantics with a final ownership-label overlay."""

    _hitch_static_no_network = False
    _hitch_preparation = None

    def __init__(
        self,
        *args: Any,
        hitch_ownership_labels: Mapping[str, str] | None = None,
        hitch_service_resource_limits: Mapping[str, Mapping[str, int]] | None = None,
        hitch_resolved_images: Mapping[str, str] | None = None,
        hitch_prebuilt_task_image: str | None = None,
        hitch_prebuilt_service_images: Mapping[str, str] | None = None,
        hitch_prebuilt_verifier_image: str | None = None,
        hitch_verifier_resolved_images: Mapping[str, str] | None = None,
        hitch_model_proxy_host_gateway: bool = False,
        hitch_main_gpu_count: int = 0,
        hitch_shared_runtime: Mapping[str, str] | None = None,
        hitch_image_cache_dir: str | None = None,
        hitch_image_build_slots: int = 2,
        hitch_managed_keepalive: bool = False,
        hitch_phase_resource_contract: Mapping[str, Any] | None = None,
        hitch_phase_verifier_source: Mapping[str, str] | None = None,
        hitch_agent_environment_role: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._hitch_phase_resources = None
        phase_contract = None
        if hitch_phase_resource_contract is not None:
            from hitch_phase_resources import validate_phase_contract
            phase_contract = validate_phase_contract(hitch_phase_resource_contract)
        elif hitch_phase_verifier_source is not None:
            raise ValueError("Hitch verifier source requires a phase resource contract")
        self._hitch_ownership_labels = _validate_labels(hitch_ownership_labels)
        if hitch_agent_environment_role not in (None, "agent", "shared") or (hitch_agent_environment_role and not self._hitch_ownership_labels):
            raise ValueError("Hitch observation environment role is invalid")
        if phase_contract is not None and hitch_agent_environment_role == "shared":
            raise ValueError("Separate phase contract cannot use a shared observation role")
        self._hitch_service_resource_limits = _validate_resource_limits(
            hitch_service_resource_limits
        )
        self._hitch_resolved_images = _validate_resolved_images(hitch_resolved_images)
        self._hitch_prebuilt_task_image = _validate_prebuilt_task_image(
            hitch_prebuilt_task_image
        )
        if hitch_prebuilt_service_images is not None and not isinstance(hitch_prebuilt_service_images, Mapping):
            raise ValueError("Hitch prebuilt service images must be a mapping")
        self._hitch_prebuilt_service_images = dict(hitch_prebuilt_service_images or {})
        for service, image in self._hitch_prebuilt_service_images.items():
            if (not isinstance(service, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}", service)
                    or service == MAIN_SERVICE_NAME):
                raise ValueError("Hitch prebuilt service name is invalid")
            if image is None:
                raise ValueError("Hitch prebuilt service image is required")
            _validate_prebuilt_task_image(image)
        # Harbor passes environment kwargs to separate verifiers too. A planned
        # candidate image must never replace a verifier's independent context.
        session_id = kwargs.get("session_id", args[2] if len(args) > 2 else "")
        trial_paths = kwargs.get("trial_paths", args[3] if len(args) > 3 else None)
        trial_name = trial_paths.trial_dir.name if trial_paths is not None else None
        candidate = _candidate_session(session_id, trial_name)
        self._hitch_environment_role = "candidate" if candidate or not session_id else "verifier"
        verifier_image = _validate_prebuilt_task_image(hitch_prebuilt_verifier_image)
        verifier_images = _validate_resolved_images(hitch_verifier_resolved_images)
        if session_id and not candidate:
            self._hitch_prebuilt_task_image = verifier_image
            self._hitch_prebuilt_service_images = {}
            # Absence retains the historical provider contract. New plans pass
            # even an empty map to prevent candidate registry substitutions.
            if hitch_verifier_resolved_images is not None:
                self._hitch_resolved_images = verifier_images
        if hitch_image_cache_dir is not None and (not isinstance(hitch_image_cache_dir, str) or not Path(hitch_image_cache_dir).is_absolute()):
            raise ValueError("Hitch image cache directory must be absolute")
        if not isinstance(hitch_managed_keepalive, bool):
            raise ValueError("Hitch managed keepalive flag is invalid")
        self._hitch_preparation = None
        if hitch_image_cache_dir or hitch_managed_keepalive:
            from hitch_compose_preparation import ComposePreparation
            self._hitch_preparation = ComposePreparation(self, hitch_image_cache_dir, hitch_image_build_slots, hitch_managed_keepalive)
        if not isinstance(hitch_model_proxy_host_gateway, bool):
            raise ValueError("Hitch model proxy host gateway flag is invalid")
        self._hitch_model_proxy_host_gateway = hitch_model_proxy_host_gateway
        if isinstance(hitch_main_gpu_count, bool) or not isinstance(hitch_main_gpu_count, int) or hitch_main_gpu_count < 0:
            raise ValueError("Hitch main GPU count is invalid")
        self._hitch_main_gpu_count = hitch_main_gpu_count
        self._hitch_shared_runtime = None
        if hitch_shared_runtime is not None:
            import hitch_shared_runtime as shared_runtime
            self._hitch_shared_runtime = shared_runtime.configure(hitch_shared_runtime, candidate)
        self._hitch_ownership_temp_dir: tempfile.TemporaryDirectory[str] | None = None
        self._hitch_ownership_compose_path: Path | None = None
        self._hitch_phase_compose_path: Path | None = None
        self._hitch_candidate_recycler = None
        positional = list(args)
        task_env_config = kwargs.get("task_env_config")
        task_env_position: int | None = None
        if task_env_config is None and len(positional) >= 5:
            task_env_position = 4
            task_env_config = positional[task_env_position]
        self._hitch_static_no_network = _static_no_network(positional, kwargs, task_env_config)
        self._hitch_static_network_receipt = None
        if task_env_config is not None:
            requested = getattr(task_env_config, "docker_image", None)
            resolved = self._hitch_prebuilt_task_image or self._hitch_resolved_images.get(requested)
            if resolved is not None:
                updated = task_env_config.model_copy(update={"docker_image": resolved})
                if task_env_position is None:
                    kwargs["task_env_config"] = updated
                else:
                    positional[task_env_position] = updated
        super().__init__(*positional, **kwargs)
        self._hitch_observation_role = None
        self._hitch_observation_requested = phase_contract is not None or hitch_agent_environment_role is not None
        trial_paths = getattr(self, "trial_paths", None)
        session = getattr(self, "session_id", None)
        if self._hitch_observation_requested and trial_paths is not None and isinstance(session, str) and self._hitch_ownership_labels:
            from hitch_phase_resources import _verifier_session
            trial_name = Path(trial_paths.trial_dir).name
            if session == _verifier_session(trial_name):
                self._hitch_observation_role = "verifier"
            elif session == trial_name + "__env":
                self._hitch_observation_role = "agent" if phase_contract else hitch_agent_environment_role
        if phase_contract is not None:
            from hitch_phase_resources import PhaseResourceBarrier
            self._hitch_phase_resources = PhaseResourceBarrier(self, phase_contract, hitch_phase_verifier_source)
        self._hitch_benchmark = None
        self._hitch_benchmark_platform = None
        directory = getattr(self, "environment_dir", None)
        if directory and (directory.parent / ".hitch-benchmark.json").is_file():
            self._hitch_benchmark_platform = "linux/amd64"
        if directory and directory.name == "environment" and (directory.parent / ".hitch-benchmark.json").is_file():
            from hitch_benchmark import BenchmarkSession, descriptor
            self._hitch_benchmark = BenchmarkSession(self, descriptor(directory))
        if (
            self._hitch_ownership_labels
            or self._hitch_environment_role
            or self._hitch_service_resource_limits
            or self._hitch_resolved_images
            or self._hitch_prebuilt_task_image
            or self._hitch_prebuilt_service_images
            or self._hitch_model_proxy_host_gateway
            or self._hitch_main_gpu_count > 0
            or self._hitch_benchmark_platform
            or self._hitch_static_no_network
            or self._hitch_shared_runtime
        ):
            self._hitch_ownership_compose_path = self._write_ownership_overlay()

    @property
    def _docker_compose_paths(self) -> list[Path]:
        if self._hitch_static_no_network and (self._environment_docker_compose_path.exists() or self.extra_docker_compose_paths):
            raise ValueError("static no-network requires a single Dockerfile/image environment without Compose additions")
        paths = list(super()._docker_compose_paths)
        if self._hitch_ownership_compose_path is not None:
            paths.append(self._hitch_ownership_compose_path)
        if self._hitch_preparation and self._hitch_preparation.path is not None:
            paths.append(self._hitch_preparation.path)
        if self._hitch_phase_compose_path is not None:
            paths.append(self._hitch_phase_compose_path)
        return paths

    @property
    def _main_image_name(self):
        preparation = getattr(self, "_hitch_preparation", None)
        return preparation.images.get(MAIN_SERVICE_NAME, super()._main_image_name) if preparation else super()._main_image_name

    async def _hitch_prepared_compose_command(self, command, *args, **kwargs):
        run = super()._run_docker_compose_command
        if command[:1] == ["up"] and self._hitch_shared_runtime:
            import hitch_shared_runtime as shared_runtime
            from hitch_compose_preparation import compose_services
            # Resolve the task's merged/interpolated configuration before our
            # bind mounts can hide a conflicting task mount. Revalidate on every
            # start, and never expose host snapshots to a privileged candidate.
            try:
                self._hitch_ownership_compose_path = self._write_ownership_overlay()
                resolved = await run(["config", "--format", "json"])
                shared_runtime.reject_conflicts(compose_services(resolved.stdout))
                self._hitch_ownership_compose_path = self._write_ownership_overlay(include_shared_runtime=True)
            except Exception as error:
                raise _SharedRuntimeConfigurationError(str(error)) from error
        preparation = self._hitch_preparation
        if command[:1] == ["down"] and "--rmi" in command and (self._hitch_ownership_labels
                or self._hitch_prebuilt_task_image or self._hitch_prebuilt_service_images or preparation and preparation.images):
            index = command.index("--rmi")
            if command[index + 1:index + 2] == ["local"]:
                # Image pruning enumerates the daemon's image metadata before
                # Compose can remove networks/volumes. Keep shared images for
                # Hitch image GC; physical cleanup remains owner-scoped.
                command = command[:index] + command[index + 2:]
        if preparation:
            if command == ["build"]:
                cached = await preparation.build(run)
                if cached is not None:
                    return cached
            elif command[:1] == ["up"]:
                # If Harbor selected a prebuilt image and skipped build, retain
                # Compose's original image/pull-policy choices, including any
                # sidecars. An implicit up is not an explicit build request.
                await preparation.runtime(run)
        phase = getattr(self, "_hitch_phase_resources", None)
        if phase is not None and command[:1] == ["up"]:
            # Validate the final topology, including preparation and shared-runtime
            # overlays, immediately before Docker can create any container.
            configured = await run(["config", "--format", "json"], timeout_sec=30)
            phase.validate_compose(json.loads(configured.stdout))
        return await run(command, *args, **kwargs)

    def _requires_egress_control(self, *, startup_network_policy, phase_network_policies):
        if self._hitch_static_no_network:
            return False
        return super()._requires_egress_control(startup_network_policy=startup_network_policy, phase_network_policies=phase_network_policies)

    @property
    def capabilities(self):
        result = super().capabilities
        if self._hitch_static_no_network:
            return result.model_copy(update={"disable_internet": True, "dynamic_network_policy": False})
        return result

    def _compose_env_vars(self, include_os_env=True):
        result = super()._compose_env_vars(include_os_env=include_os_env)
        # The host-only helper command is not a task Compose interpolation
        # input. The agent reads it directly from its trusted host process.
        result.pop(_HOST_CREDENTIAL_HELPER_ENV, None)
        return result

    async def hitch_exec_with_private_env(self, command, *, env, cwd=None, timeout_sec=None, user=None):
        """Execute one Target without placing per-exec credential values in argv."""
        from hitch_private_exec import exec_with_private_environment
        return await exec_with_private_environment(
            self,
            command,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
            user=user,
        )

    async def hitch_verify_shared_runtime(self, controller_payload, artifact_directory):
        if self._hitch_shared_runtime is None:
            return False
        import hitch_shared_runtime as shared_runtime
        return await shared_runtime.verify_environment(self, controller_payload, artifact_directory)

    async def _apply_network_policy(self, network_policy):
        if self._hitch_static_no_network:
            if network_policy != self.network_policy:
                raise ValueError("static no-network cannot change runtime network policy")
            return
        await super()._apply_network_policy(network_policy)

    async def _verify_static_network(self):
        result = await self._run_docker_compose_command(["ps", "--all", "--quiet", MAIN_SERVICE_NAME])
        identity = result.stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise RuntimeError("static no-network requires exactly one owned main container")
        template = '{"mode":{{json .HostConfig.NetworkMode}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}}}'
        process = await asyncio.create_subprocess_exec("docker", "inspect", "--format", template, identity,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), 15)
        finally:
            if process.returncode is None:
                process.kill(); await process.wait()
        if process.returncode != 0 or len(stdout) > 65536:
            raise RuntimeError("could not verify static no-network container")
        inspected = json.loads(stdout)
        if inspected.get("mode") != "none" or set(inspected.get("networks") or {}) != {"none"} or inspected.get("ports"):
            raise RuntimeError("Docker did not enforce the static no-network declaration")
        self._hitch_static_network_receipt = {"container_id": identity, "network_mode": "none", "host_ports": False}

    async def recycle_candidate_phase(self, phase_index: int) -> dict[str, Any]:
        """Replace only main after the supervisor has exported the retired run.

        Does not start a model or prepare a tool binding. The native task VM and
        service containers remain live. Failures require whole-trial cleanup.
        """
        if self._hitch_candidate_recycler is None:
            from hitch_candidate_recycle import CandidateRecycler
            self._hitch_candidate_recycler = CandidateRecycler(self)
        return await self._hitch_candidate_recycler.recycle(phase_index)

    async def start(self, force_build: bool):
        try:
            if self._hitch_preparation:
                self._hitch_preparation.reset(force_build)
            await self._hitch_phase_guard("before_start")
            await super().start(force_build)
            await self._hitch_phase_guard("after_start")
            self._hitch_observation_event(getattr(self, "_hitch_observation_role", None))
            if self._hitch_static_no_network:
                await self._verify_static_network()
            if self._hitch_benchmark:
                await self._hitch_benchmark.prepare()
        except BaseException as error:
            # Harbor may abort setup before entering its normal teardown path.
            try:
                await self.stop(delete=not isinstance(error, _SharedRuntimeConfigurationError))
            except BaseException:
                pass
            raise

    async def stop_service(self, service: str) -> None:
        try:
            if service == MAIN_SERVICE_NAME:
                await self._hitch_phase_guard("before_main_stop")
            await super().stop_service(service)
            if service == MAIN_SERVICE_NAME:
                await self._hitch_phase_guard("after_main_stop")
                if getattr(self, "_hitch_phase_resources", None) is not None:
                    self._hitch_observation_event("artifact-collection")
            if service == MAIN_SERVICE_NAME and self._hitch_benchmark:
                await self._hitch_benchmark.snapshot()
        except BaseException as error:
            self._hitch_phase_failure(error)
            if self._hitch_benchmark:
                self._hitch_benchmark.failure = {"phase": "quiesce", "error": type(error).__name__}
                self._hitch_benchmark.write_journal()
            raise

    async def stop(self, delete: bool):
        self._hitch_observation_event(None)
        failure = None
        try:
            try:
                await self._hitch_phase_guard("before_stop")
            except BaseException as error:
                # Cleanup still runs after a failed barrier; it cannot clear it.
                failure = error
            if self._hitch_benchmark and self._hitch_benchmark.started:
                try:
                    await super().stop_service(MAIN_SERVICE_NAME)
                finally:
                    await self._hitch_benchmark.cleanup()
        finally:
            try:
                await super().stop(delete)
                await self._hitch_phase_guard("after_stop")
            except BaseException as error:
                self._hitch_phase_failure(error)
                raise
        if failure is not None:
            raise failure

    def _hitch_observation_event(self, phase: str | None) -> None:
        role = getattr(self, "_hitch_observation_role", None)
        if role is None:
            return
        try:
            from hitch_phase_resources import _atomic_json, _now
            _atomic_json(Path(self.trial_paths.trial_dir) / f"hitch-environment-observation-{role}.json", {
                "schema_version": "1", "ownership": self._hitch_ownership_labels,
                "environment_role": role, "phase": phase, "session_id": self.session_id, "at": _now(),
            })
        except Exception:
            # Observation availability must never prevent environment cleanup.
            pass

    async def _hitch_phase_guard(self, operation: str, *args: Any) -> None:
        if getattr(self, "_hitch_phase_resources", None) is None:
            return
        try:
            await getattr(self._hitch_phase_resources, operation)(*args)
        except BaseException as error:
            self._hitch_phase_failure(error)
            raise

    def _hitch_phase_failure(self, error: BaseException) -> None:
        if getattr(self, "_hitch_phase_resources", None) is not None:
            # Docker's exception can contain command output; keep it out of receipts.
            from hitch_phase_resources import PhaseResourceError
            reason = str(error) if isinstance(error, PhaseResourceError) else type(error).__name__
            self._hitch_phase_resources.fail(reason)

    async def _run_docker_compose_command(self, command, *args, **kwargs):
        phase = getattr(self, "_hitch_phase_resources", None)
        try:
            if phase is not None and command and command[0] in ("up", "create", "run", "start", "restart"):
                if command[0] != "up":
                    from hitch_phase_resources import PhaseResourceError
                    raise PhaseResourceError("phase_transition_unconfirmed: unplanned container start")
                await self._hitch_phase_guard("before_start")
            if phase is not None and command and command[0] in ("stop", "down") and not args:
                kwargs.setdefault("timeout_sec", 30)
            result = await self._hitch_prepared_compose_command(command, *args, **kwargs)
            if phase is not None and command and command[0] in ("stop", "down") and result.return_code != 0:
                from hitch_phase_resources import PhaseResourceError
                raise PhaseResourceError("phase_transition_unconfirmed: Docker stop command failed")
            return result
        except BaseException as error:
            if phase is not None and command and command[0] in ("up", "create", "run", "start", "restart", "stop", "down"):
                self._hitch_phase_failure(error)
            raise

    async def service_exec(self, command, *, service=None, **kwargs):
        await self._hitch_phase_guard("before_sidecar_operation", service)
        return await super().service_exec(command, service=service, **kwargs)

    async def service_download_file(self, source_path, target_path, *, service=None):
        await self._hitch_phase_guard("before_sidecar_operation", service, True)
        return await super().service_download_file(source_path, target_path, service=service)

    async def service_download_dir(self, source_dir, target_dir, *, service=None):
        await self._hitch_phase_guard("before_sidecar_operation", service, True)
        return await super().service_download_dir(source_dir, target_dir, service=service)

    def _write_ownership_overlay(self, *, include_shared_runtime=False) -> Path:
        if include_shared_runtime and self._hitch_shared_runtime:
            import hitch_shared_runtime as shared_runtime
        services = {MAIN_SERVICE_NAME}
        if self._enable_egress_control:
            services.add(self._EGRESS_CONTROL_SERVICE_NAME)
        networks = {"default"}
        volumes: set[str] = set()
        external_networks: set[str] = set()
        external_volumes: set[str] = set()
        build_services: set[str] = set()
        declared_platforms: set[str] = set()
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
                    if 'platform' in config:
                        if config['platform'] is not None:
                            declared_platforms.add(name)
                        else:
                            declared_platforms.discard(name)
                    if "build" in config and config.get("build") is not None:
                        build_services.add(name)
                    reference = config.get("image")
                    resolved = self._hitch_resolved_images.get(reference)
                    if resolved is not None:
                        image_overlays[name] = resolved
                    elif reference is not None:
                        image_overlays.pop(name, None)
            _collect_resources(document.get("networks"), networks, external_networks, "networks", source)
            _collect_resources(document.get("volumes"), volumes, external_volumes, "volumes", source)

        labels = dict(self._hitch_ownership_labels)
        if getattr(self, "_hitch_observation_role", None):
            labels["io.hitch.environment-role"] = self._hitch_observation_role
        service_overlays: dict[str, dict[str, Any]] = {}
        if not set(self._hitch_prebuilt_service_images).issubset(services):
            raise ValueError("Hitch prebuilt image names an unknown Compose service")
        for name in sorted(services):
            config: dict[str, Any] = {}
            if name == MAIN_SERVICE_NAME and include_shared_runtime and self._hitch_shared_runtime:
                config["volumes"] = shared_runtime.compose_mounts(self._hitch_shared_runtime)
            # The benchmark default must not replace explicit per-service
            # architecture, e.g. an ARM QEMU sidecar beside an AMD64 candidate.
            if getattr(self, "_hitch_benchmark_platform", None) and name not in declared_platforms:
                config["platform"] = self._hitch_benchmark_platform
            config["labels"] = dict(labels)
            if not self._hitch_observation_requested:
                config["labels"][_LABEL_ROLE] = self._hitch_environment_role
            if name == MAIN_SERVICE_NAME and self._hitch_static_no_network:
                config["network_mode"] = "none"
            resolved_image = image_overlays.get(name)
            if name == MAIN_SERVICE_NAME and self._hitch_prebuilt_task_image:
                resolved_image = self._hitch_prebuilt_task_image
            if name in self._hitch_prebuilt_service_images:
                resolved_image = self._hitch_prebuilt_service_images[name]
            if resolved_image is not None:
                config["image"] = resolved_image
            if name == MAIN_SERVICE_NAME and self._hitch_prebuilt_task_image or name in self._hitch_prebuilt_service_images:
                config["pull_policy"] = "never"
            if (
                (name == MAIN_SERVICE_NAME and self._hitch_prebuilt_task_image
                 or name in self._hitch_prebuilt_service_images)
                and name in build_services
            ):
                # Compose's normal merge semantics retain an earlier build stanza
                # when an overlay only supplies image (or even build: null).  The
                # !reset tag is the supported way to make a successful Hitch
                # prebuild authoritative and prevent a second mutable-context build.
                config["build"] = _COMPOSE_RESET_MARKER
                config["pull_policy"] = "never"
            if name == MAIN_SERVICE_NAME and self._hitch_model_proxy_host_gateway:
                config["extra_hosts"] = ["host.docker.internal:host-gateway"]
            if name == MAIN_SERVICE_NAME and self._hitch_main_gpu_count > 0:
                config["deploy"] = {
                    "resources": {
                        "reservations": {
                            "devices": f"{_GPU_OVERRIDE_PREFIX}{self._hitch_main_gpu_count}__"
                        }
                    }
                }
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
                if limits.get("gpu_count", 0) > 0:
                    config["deploy"] = {
                        "resources": {
                            "reservations": {
                                "devices": f"{_GPU_OVERRIDE_PREFIX}{limits['gpu_count']}__"
                            }
                        }
                    }
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
        target = Path(self._hitch_ownership_temp_dir.name) / "docker-compose-hitch-ownership.yaml"
        contents = json.dumps(overlay, indent=2, sort_keys=True)
        contents = contents.replace(
            f'"build": "{_COMPOSE_RESET_MARKER}"',
            '"build": !reset null',
        )
        contents = re.sub(
            rf'"devices": "{_GPU_OVERRIDE_PREFIX}([1-9][0-9]*)__"',
            lambda match: '"devices": !override [{"capabilities": ["gpu"], "count": ' + match.group(1) + '}]',
            contents,
        )
        target.write_text(contents, encoding="utf-8")
        return target


def _static_no_network(positional, kwargs, task_env_config) -> bool:
    """Use Docker's isolated namespace only when no phase needs connectivity.

    Compose tasks and dynamic policies retain Harbor's egress-control path.
    A single image/Dockerfile has no sibling-service network to preserve.
    """
    policy = kwargs.get("network_policy", positional[6] if len(positional) > 6 else None)
    phases = kwargs.get("phase_network_policies", positional[7] if len(positional) > 7 else ()) or ()
    directory = kwargs.get("environment_dir", positional[0] if positional else None)
    return bool(
        getattr(getattr(task_env_config, "os", None), "value", None) == "linux"
        and getattr(getattr(policy, "network_mode", None), "value", None) == "no-network"
        and all(phase == policy for phase in phases)
        and directory is not None
        and not (Path(directory) / "docker-compose.yaml").exists()
        and not kwargs.get("extra_docker_compose")
    )


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
        or not isinstance(labels.get(_LABEL_PROVIDER), str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", labels[_LABEL_PROVIDER])
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
            or set(resources) - {"cpu_millis", "memory_bytes", "gpu_count"}
            or not {"cpu_millis", "memory_bytes"} <= set(resources)
            or isinstance(resources.get("cpu_millis"), bool)
            or not isinstance(resources.get("cpu_millis"), int)
            or resources["cpu_millis"] < 1
            or isinstance(resources.get("memory_bytes"), bool)
            or not isinstance(resources.get("memory_bytes"), int)
            or resources["memory_bytes"] < 1
            or ("gpu_count" in resources and (
                isinstance(resources.get("gpu_count"), bool)
                or not isinstance(resources.get("gpu_count"), int)
                or resources["gpu_count"] < 1
            ))
        ):
            raise ValueError("Hitch Docker service resource limits are invalid")
        result[name] = {
            "cpu_millis": resources["cpu_millis"],
            "memory_bytes": resources["memory_bytes"],
            **({"gpu_count": resources["gpu_count"]} if "gpu_count" in resources else {}),
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


def _validate_prebuilt_task_image(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or re.fullmatch(r"sha256:[a-f0-9]{64}", value) is None:
        raise ValueError("Hitch prebuilt task image is invalid")
    return value


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


class VerifierEnvironmentStartError(RuntimeError):
    """Independent environment startup failed before scoring was entered."""


class VerifierEnvironmentStartTimeoutError(VerifierEnvironmentStartError):
    """Independent environment startup timed out before scoring was entered."""


def _install_verifier_start_timeout_hook():
    # Keep this hook in the provider: historical verifier repair is deliberately
    # authorized to replace this single file, without adding runtime modules.
    try:
        from harbor.trial.trial import Trial
    except ImportError:
        return  # Minimal provider smoke fixtures do not import Harbor trials.
    original = Trial._separate_verifier_env
    if getattr(original, "_hitch_verifier_start_timeout_hook", False):
        return

    @asynccontextmanager
    @wraps(original)
    async def separate_verifier_env(trial, *args, **kwargs):
        async with AsyncExitStack() as stack:
            try:
                environment = await stack.enter_async_context(original(trial, *args, **kwargs))
            except asyncio.TimeoutError as error:
                if trial.config.environment.import_path != "hitch_harbor_environment:HitchHarborDockerEnvironment":
                    raise
                raise VerifierEnvironmentStartTimeoutError(
                    f"Verifier environment startup timed out (environment build budget: {trial._environment_build_timeout_sec} seconds)"
                ) from error
            except Exception as error:
                if trial.config.environment.import_path != "hitch_harbor_environment:HitchHarborDockerEnvironment":
                    raise
                raise VerifierEnvironmentStartError("Verifier environment startup failed") from error
            # Scoring, context-exit errors and external cancellation retain
            # their native semantics, including __aexit__ suppression.
            yield environment

    separate_verifier_env._hitch_verifier_start_timeout_hook = True
    Trial._separate_verifier_env = separate_verifier_env


_install_verifier_start_timeout_hook()
