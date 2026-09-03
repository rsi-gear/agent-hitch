"""Harbor custom agent that runs an immutable harness through Hitch in a trial container."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shlex
import stat as stat_module
import tempfile
import time
import uuid
from urllib.parse import urlparse
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, NamedTuple

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

CONTROLLER_RUNTIME_MANIFEST_VERSION = "2"
HARNESS_ARTIFACT_REMOTE_ROOT = "/opt/hitch-harness-artifact"
HITCH_BRIDGE_ERROR_LOG = "/logs/agent/hitch-bridge-error.json"
HITCH_DIAGNOSTIC_MAX_BYTES = 8 * 1024
HITCH_BRIDGE_ERROR_MAX_BYTES = 64 * 1024
HITCH_RESULT_MISSING_EXIT = 44
HITCH_RESULT_NOT_FILE_EXIT = 45
PHASE_EXPORT_MODULE = "dist/src/runs/phase-bundle.js"
PHASE_CONTROL_MODULE = "dist/src/runs/phase-cancellation.js"


def artifact_directory_integrity(directory: Path, captured_files: dict[str, bytes] | None = None) -> str:
    """Match artifacts/integrity.ts, including modes and internal symlinks."""
    root = Path(os.path.abspath(directory))
    digest = hashlib.sha256()

    def visit(parent: Path) -> None:
        # JS Array.sort compares UTF-16 code units, not Unicode code points.
        for entry in sorted(parent.iterdir(), key=lambda item: item.name.encode("utf-16-be", "surrogatepass")):
            if parent == root and entry.name == "artifact.json":
                continue
            relative = entry.relative_to(root).as_posix()
            info = entry.lstat()
            mode = info.st_mode & 0o7777
            if stat_module.S_ISDIR(info.st_mode):
                digest.update(f"d\0{relative}\0{mode}\0".encode())
                visit(entry)
            elif stat_module.S_ISREG(info.st_mode):
                digest.update(f"f\0{relative}\0{mode}\0{info.st_size}\0".encode())
                capture = captured_files is not None and relative in captured_files
                if capture and info.st_size > 16_384:
                    raise RuntimeError("captured artifact metadata exceeds its size limit")
                content = bytearray()
                with entry.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                        if capture:
                            content.extend(chunk)
                            if len(content) > 16_384:
                                raise RuntimeError("captured artifact metadata exceeds its size limit")
                if capture and captured_files is not None:
                    captured_files[relative] = bytes(content)
                digest.update(b"\0")
            elif stat_module.S_ISLNK(info.st_mode):
                target = os.readlink(entry)
                if not Path(os.path.abspath(entry.parent / target)).is_relative_to(root):
                    raise RuntimeError("artifact symlink escapes the artifact directory")
                digest.update(f"l\0{relative}\0{target}\0".encode())
            else:
                raise RuntimeError("artifact contains a special file")

    visit(root)
    return "sha256:" + digest.hexdigest()


class PreparedPhase(NamedTuple):
    run_id: str
    instruction: str
    context_json: str
    parent_json: str
    identity: str
    deadline_ns: int

    def __repr__(self) -> str:
        return f"PreparedPhase(run_id={self.run_id!r})"


class HitchBridgeError(RuntimeError):
    """Stable Harbor-facing infrastructure failure with structured evidence."""

    def __init__(self, code: str, message: str, evidence: dict[str, Any]) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.evidence = evidence


class HitchHarborAgent(BaseAgent):
    """Upload Hitch into a Harbor environment and delegate the agent phase to it."""

    def __init__(
        self,
        logs_dir: Path,
        harness_ref: str,
        revision_identity: str,
        hitch_runtime_dir: str,
        candidate_id: str = "candidate-1",
        controller_runtime_id: str | None = None,
        harness_artifact: dict[str, Any] | None = None,
        node_version: str = "v22.23.0",
        # Legacy parameters are accepted only so old persisted jobs fail at
        # the explicit artifact handoff boundary instead of leaking unknown
        # kwargs into Harbor's BaseAgent. New jobs pass neither value.
        harness_artifact_cache_dir: str | None = None,
        local_source_transport: dict[str, Any] | None = None,
        hitch_timeout_ms: int = 900_000,
        agent_args: list[str] | None = None,
        credential_names: list[str] | None = None,
        workdir: str | None = None,
        eval_id: str | None = None,
        benchmark_id: str | None = None,
        benchmark_revision: str | None = None,
        verifier_identity: str | None = None,
        logical_attempt: int | None = None,
        model_capture: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.harness_ref = harness_ref
        self.revision_identity = revision_identity
        self.hitch_runtime_dir = Path(hitch_runtime_dir)
        self.controller_runtime_id = controller_runtime_id
        self.harness_artifact = dict(harness_artifact) if harness_artifact else None
        if harness_artifact_cache_dir is not None:
            raise ValueError("trial-side harness artifact caches are no longer supported")
        if not isinstance(node_version, str) or re.fullmatch(r"v\d+\.\d+\.\d+", node_version) is None:
            raise ValueError("node_version must be an exact stable Node.js version")
        self.required_node_version = node_version
        self._node_bin_directory: str | None = None
        if local_source_transport is not None:
            raise ValueError("trial-side local source transports are no longer supported")
        self.candidate_id = candidate_id
        self.hitch_timeout_ms = int(hitch_timeout_ms)
        self.agent_args = list(agent_args or [])
        raw_credential_names = list(credential_names or [])
        if (
            any(not isinstance(name, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is None for name in raw_credential_names)
            or len(set(raw_credential_names)) != len(raw_credential_names)
        ):
            raise ValueError("credential_names must contain unique environment variable names")
        self.credential_names = sorted(raw_credential_names)
        if workdir is not None and (not isinstance(workdir, str) or not workdir.strip()):
            raise ValueError("workdir must be a non-empty string when provided")
        self.workdir = workdir.strip() if isinstance(workdir, str) else None
        self._workdir_source: str | None = "agent_config" if self.workdir is not None else None
        self.eval_id = eval_id
        self.benchmark_id = benchmark_id
        self.benchmark_revision = benchmark_revision
        self.verifier_identity = verifier_identity
        if logical_attempt is not None and (isinstance(logical_attempt, bool) or not isinstance(logical_attempt, int) or logical_attempt < 1):
            raise ValueError("logical_attempt must be a positive integer")
        self.logical_attempt = logical_attempt
        self.model_capture = _validate_model_capture(model_capture)
        self._hitch_version: str | None = None
        self._entrypoint: str | None = None
        self._artifact_manifest: dict[str, Any] | None = None
        self._artifact_host_directory: Path | None = None
        self._artifact_uploaded = False
        self._artifact_transport_status: str | None = None
        self._setup_complete = False
        self._phase_export_available = False
        self._phase_supervision_available = False
        self._prepared_phase: PreparedPhase | None = None
        self._prepared_phase_keys: set[tuple[str, int]] = set()
        self._phase_group_contracts: dict[str, tuple[str, str, int]] = {}
        self._phase_inflight = False
        self._active_phase: PreparedPhase | None = None
        self._phase_cancel_lock: asyncio.Lock | None = None
        self._phase_cancel_receipts: dict[str, dict[str, Any]] = {}
        self._phase_control_tokens: dict[str, str] = {}

    @staticmethod
    def name() -> str:
        return "hitch"

    def version(self) -> str | None:
        return self._hitch_version

    async def setup(self, environment: BaseEnvironment) -> None:
        started_ns = time.monotonic_ns()
        self._setup_complete = False
        try:
            await self._setup(environment)
            self._setup_complete = True
        finally:
            self._write_phase_timing("setup", started_ns)

    async def _setup(self, environment: BaseEnvironment) -> None:
        if not self.hitch_runtime_dir.is_dir():
            raise RuntimeError(f"Hitch runtime directory does not exist: {self.hitch_runtime_dir}")
        # The manifest declares the CLI entrypoint (relative to the upload
        # root). The bridge must not hardcode the TypeScript build layout
        # (spec §4.3): read the manifest and execute its declared entrypoint.
        manifest_path = self.hitch_runtime_dir / "manifest.json"
        if not manifest_path.is_file():
            raise RuntimeError(f"Hitch runtime bundle has no manifest: {self.hitch_runtime_dir}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != CONTROLLER_RUNTIME_MANIFEST_VERSION:
            raise RuntimeError(
                f"unsupported controller runtime manifest schema {manifest.get('schema_version')!r}; "
                f"expected {CONTROLLER_RUNTIME_MANIFEST_VERSION!r}"
            )
        entrypoint = self._validate_entrypoint(manifest)
        self._entrypoint = entrypoint
        # Verify the bundle identity on the Python side before anything is
        # uploaded: the declared runtime_id must match the identity the Harbor
        # job pinned, and the payload must still match the manifest's declared
        # digests (closing the TOCTOU window between the TS-side verification
        # and the actual container upload, spec §4.6).
        self._verify_manifest_identity(manifest)
        self._verify_payload(manifest)
        self._phase_export_available = {PHASE_EXPORT_MODULE, PHASE_CONTROL_MODULE}.issubset({file.get("path") for file in manifest["files"]})
        self._phase_supervision_available = self._phase_export_available and "integrations/harbor/hitch_phase_supervisor.py" in {file.get("path") for file in manifest["files"]}
        if self.harness_artifact is None:
            raise RuntimeError("hitch-artifact-materialize: Harbor requires a dedicated-builder artifact")
        try:
            self._artifact_manifest = self._verify_harness_artifact_host()
            self._artifact_host_directory = Path(str(self.harness_artifact["directory"]))
        except Exception as error:
            raise RuntimeError(f"hitch-artifact-materialize: {error}") from error
        payload_dir = self.hitch_runtime_dir / "payload"
        if not payload_dir.is_dir():
            raise RuntimeError(f"Hitch runtime bundle has no payload directory: {self.hitch_runtime_dir}")
        await self._resolve_workdir(environment)
        # Upload the cached bundle's payload (package.json + dist/) as the
        # package root under /opt/hitch; the local cache path is host-side
        # bookkeeping and is not identity (spec §4.2).
        await environment.upload_dir(payload_dir, "/opt/hitch")
        await self._ensure_node(environment)
        platform = await self._container_platform(environment)
        node_version = await self._container_node_version(environment)
        if self._artifact_manifest is None or not self._artifact_compatible(
            self._artifact_manifest, platform, node_version
        ):
            raise RuntimeError(
                "hitch-artifact-platform: dedicated-builder artifact is incompatible with "
                f"trial runtime {platform}/{node_version}"
            )
        await self._upload_harness_artifact(environment, self._artifact_host_directory)
        self._artifact_transport_status = "dedicated_builder_upload"
        entry = self._remote_entry(entrypoint)
        version = await self._exec(environment, f"{self._node_prefix()} node {entry} --version")
        self._hitch_version = (version.stdout or "").strip() or None

    async def _resolve_workdir(self, environment: BaseEnvironment) -> str:
        """Resolve Harbor's effective task directory and prove it is usable.

        Harbor environments already combine task-level ``[environment].workdir``
        with the container image's ``WORKDIR``. Honor an explicit bridge
        override, then the task configuration, then ask the running container
        for its default cwd instead of assuming a global path such as /app.
        """
        candidate = self.workdir
        source = self._workdir_source
        task_config = getattr(environment, "task_env_config", None)
        task_workdir = getattr(task_config, "workdir", None)
        discovery: ExecResult | None = None
        if candidate is None and isinstance(task_workdir, str) and task_workdir.strip():
            candidate = task_workdir.strip()
            source = "task_environment"
        if candidate is None:
            discovery = await environment.exec("pwd -P")
            candidate = (discovery.stdout or "").strip()
            source = "container_workdir"
            if discovery.return_code != 0 or not candidate:
                detail = self._exec_diagnostic(discovery)
                await self._raise_workdir_error(
                    environment,
                    "Could not determine the Harbor task working directory from the container "
                    f"(exit={discovery.return_code}): {detail}",
                    source=source,
                    candidate=candidate or None,
                    probe=discovery,
                )
        if (
            candidate is None
            or not PurePosixPath(candidate).is_absolute()
            or "\x00" in candidate
            or "\n" in candidate
            or "\r" in candidate
        ):
            await self._raise_workdir_error(
                environment,
                f"Harbor task working directory must be an absolute POSIX path; got {candidate!r} "
                f"from {source or 'unknown'}",
                source=source,
                candidate=candidate,
                probe=discovery,
            )

        exists = await environment.exec(f"test -d {shlex.quote(candidate)}", cwd="/")
        if exists.return_code != 0:
            detail = self._exec_diagnostic(exists)
            await self._raise_workdir_error(
                environment,
                f"Harbor task working directory does not exist or is not a directory: {candidate} "
                f"(source={source}, exit={exists.return_code}): {detail}",
                source=source,
                candidate=candidate,
                probe=exists,
            )

        usable = await environment.exec("pwd -P", cwd=candidate)
        resolved = (usable.stdout or "").strip()
        if usable.return_code != 0 or not resolved or not PurePosixPath(resolved).is_absolute():
            detail = self._exec_diagnostic(usable)
            await self._raise_workdir_error(
                environment,
                f"Harbor task working directory exists but cannot be used to start the Hitch agent: {candidate} "
                f"(source={source}, exit={usable.return_code}): {detail}",
                source=source,
                candidate=candidate,
                probe=usable,
            )
        self.workdir = resolved
        self._workdir_source = source
        return resolved

    async def _raise_workdir_error(
        self,
        environment: BaseEnvironment,
        message: str,
        *,
        source: str | None,
        candidate: str | None,
        probe: ExecResult | None,
    ) -> None:
        evidence: dict[str, Any] = {
            "schema_version": "1",
            "code": "hitch_workdir_invalid",
            "message": self._bounded_tail(message, 2048),
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "eval_id": self.eval_id,
            "workdir": {
                "source": source,
                "candidate": candidate,
                "return_code": probe.return_code if probe is not None else None,
                "stdout_tail": self._bounded_tail(probe.stdout or "") if probe is not None else "",
                "stderr_tail": self._bounded_tail(probe.stderr or "") if probe is not None else "",
            },
        }
        await self._write_bridge_error(environment, evidence)
        raise HitchBridgeError("hitch_workdir_invalid", message, evidence)

    def _require_workdir(self) -> str:
        if self.workdir is None:
            raise RuntimeError("Hitch agent setup() must resolve the Harbor task working directory before run()")
        return self.workdir

    def _write_phase_timing(self, phase: str, started_ns: int) -> None:
        if phase not in {"setup", "agent"}:
            raise ValueError("invalid Harbor agent phase timing")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        target = self.logs_dir / "hitch-phase-timings.json"
        value: dict[str, Any] = {"schema_version": "1", "phases": {}}
        try:
            existing = json.loads(target.read_text(encoding="utf-8")) if target.is_file() else None
            if isinstance(existing, dict) and existing.get("schema_version") == "1" and isinstance(existing.get("phases"), dict):
                value = existing
        except (OSError, json.JSONDecodeError):
            pass
        value["phases"][phase] = {
            "duration_ms": max(0, (time.monotonic_ns() - started_ns) // 1_000_000),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(target)

    def _verify_harness_artifact_host(self) -> dict[str, Any]:
        """Pin host artifact metadata before Harbor copies the directory."""
        transport = self.harness_artifact or {}
        required = {
            "directory", "artifact_id", "artifact_integrity", "entrypoint_integrity",
            "harness_id", "revision_identity", "adapter_version", "recipe_version",
            "platform", "node_version", "source_type",
        }
        if set(transport) != required:
            raise RuntimeError("prepared artifact handoff metadata fields are invalid")
        directory = Path(str(transport["directory"]))
        if not directory.is_absolute():
            raise RuntimeError("prepared artifact host path must be absolute")
        try:
            directory_info = directory.lstat()
        except OSError as error:
            raise RuntimeError("prepared artifact directory is missing or unreadable") from error
        if not stat_module.S_ISDIR(directory_info.st_mode) or directory.is_symlink():
            raise RuntimeError("prepared artifact handoff must be a regular directory")
        artifact_file = directory / "artifact.json"
        self._assert_regular_host_file(artifact_file, "prepared artifact manifest", 1024 * 1024)
        try:
            manifest = json.loads(artifact_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError("prepared artifact manifest is unreadable") from error
        pinned = {
            "artifact_id": manifest.get("artifact_id"),
            "artifact_integrity": manifest.get("artifact_integrity"),
            "entrypoint_integrity": manifest.get("entrypoint_integrity"),
            "harness_id": manifest.get("harness_id"),
            "revision_identity": manifest.get("revision_identity"),
            "adapter_version": manifest.get("adapter_version"),
            "recipe_version": manifest.get("recipe_version"),
            "platform": manifest.get("platform"),
            "node_version": manifest.get("toolchain", {}).get("node"),
            "source_type": manifest.get("source_type"),
        }
        if any(transport.get(key) != value for key, value in pinned.items()):
            raise RuntimeError("prepared artifact metadata does not match its manifest")
        if manifest.get("revision_identity") != self.revision_identity:
            raise RuntimeError("prepared artifact revision does not match the job-pinned identity")
        if manifest.get("source_type") == "installed":
            raise RuntimeError("installed harness artifacts cannot cross the container boundary")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(manifest.get("artifact_id", ""))):
            raise RuntimeError("prepared artifact ID is invalid")
        for field in ("artifact_integrity", "entrypoint_integrity", "revision_identity"):
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(manifest.get(field, ""))):
                raise RuntimeError(f"prepared artifact {field} is invalid")
        if not re.fullmatch(r"(?:linux|darwin|win32)-[a-z0-9_]+", str(manifest.get("platform", ""))):
            raise RuntimeError("prepared artifact platform is invalid")
        if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", str(transport.get("node_version", ""))):
            raise RuntimeError("prepared artifact Node.js version is invalid")
        return manifest

    @staticmethod
    def _assert_regular_host_file(path: Path, label: str, maximum: int) -> Any:
        try:
            info = path.lstat()
        except OSError as error:
            raise RuntimeError(f"{label} is missing or unreadable") from error
        if not stat_module.S_ISREG(info.st_mode):
            raise RuntimeError(f"{label} must be a regular file")
        if info.st_size > maximum:
            raise RuntimeError(f"{label} exceeds the size limit ({maximum} bytes)")
        return info

    async def _container_platform(self, environment: BaseEnvironment) -> str:
        result = await self._exec(
            environment,
            f'{self._node_prefix()} node -p "process.platform + \'-\' + process.arch"',
        )
        platform = (result.stdout or "").strip()
        if not re.fullmatch(r"(?:linux|darwin|win32)-[a-z0-9_]+", platform):
            raise RuntimeError("container returned an invalid Node.js platform identity")
        return platform

    async def _container_node_version(self, environment: BaseEnvironment) -> str:
        result = await self._exec(environment, f'{self._node_prefix()} node -p "process.version"')
        version = (result.stdout or "").strip()
        if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
            raise RuntimeError("container returned an invalid Node.js version")
        return version

    @staticmethod
    def _artifact_compatible(manifest: dict[str, Any], platform: str, node_version: str) -> bool:
        return (
            manifest.get("platform") == platform
            and manifest.get("toolchain", {}).get("node") == node_version
        )

    async def _upload_harness_artifact(
        self,
        environment: BaseEnvironment,
        directory: Path | None,
    ) -> None:
        if directory is None:
            raise RuntimeError("prepared artifact host directory is unavailable")
        await environment.upload_dir(directory, HARNESS_ARTIFACT_REMOTE_ROOT)
        self._artifact_uploaded = True

    def _artifact_cli_args(self) -> list[str]:
        if not self._artifact_uploaded or self._artifact_manifest is None:
            return []
        manifest = self._artifact_manifest
        return [
            "--internal-prepared-artifact", HARNESS_ARTIFACT_REMOTE_ROOT,
            "--internal-artifact-id", str(manifest["artifact_id"]),
            "--internal-artifact-integrity", str(manifest["artifact_integrity"]),
            "--internal-artifact-entrypoint-integrity", str(manifest["entrypoint_integrity"]),
            "--internal-artifact-revision-identity", str(manifest["revision_identity"]),
            "--internal-artifact-platform", str(manifest["platform"]),
        ]

    @staticmethod
    def _remote_entry(entrypoint: str) -> str:
        """Shell-quote the full remote path so the entrypoint is always a
        single argv word, even if a (digest-verified) manifest path contains
        shell metacharacters (spec §4.3, §8.5)."""
        return shlex.quote(f"/opt/hitch/{entrypoint}")

    def _verify_manifest_identity(self, manifest: dict[str, Any]) -> None:
        """Assert the canonical digest equals the declared runtime_id and the
        job-pinned controller_runtime_id (spec §4.4, §4.6)."""
        expected_id = manifest.get("runtime_id")
        if not isinstance(expected_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_id):
            raise RuntimeError("controller runtime manifest runtime_id is not a sha256 digest")
        recomputed = "sha256:" + hashlib.sha256(
            canonical_manifest_json(manifest).encode("utf-8")
        ).hexdigest()
        if recomputed != expected_id:
            raise RuntimeError(
                f"controller runtime manifest digest mismatch: recomputed {recomputed}, declared {expected_id}"
            )
        if self.controller_runtime_id is not None and self.controller_runtime_id != expected_id:
            raise RuntimeError(
                f"controller runtime id mismatch: job pinned {self.controller_runtime_id}, manifest declares {expected_id}"
            )

    def _verify_payload(self, manifest: dict[str, Any]) -> None:
        """Re-hash the on-disk payload against the manifest's declared files
        (sizes, executable bits, SHA-256 digests) before upload (spec §4.6)."""
        files = manifest.get("files")
        if not isinstance(files, list):
            raise RuntimeError("controller runtime manifest is missing files")
        payload_dir = self.hitch_runtime_dir / "payload"
        for file in files:
            if not isinstance(file, dict):
                raise RuntimeError("controller runtime manifest file entry is not an object")
            rel = file.get("path")
            size = file.get("size")
            digest = file.get("sha256")
            if not isinstance(rel, str) or not isinstance(size, int) or not isinstance(digest, str):
                raise RuntimeError("controller runtime manifest file entry is malformed")
            target = (payload_dir / rel).resolve()
            if not str(target).startswith(str(payload_dir.resolve())):
                raise RuntimeError(f"controller runtime payload file escapes the payload: {rel}")
            if not target.is_file():
                raise RuntimeError(f"controller runtime payload file is missing: {rel}")
            actual_size = target.stat().st_size
            if actual_size != size:
                raise RuntimeError(
                    f"controller runtime payload size mismatch for {rel}: expected {size}, got {actual_size}"
                )
            actual_digest = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
            if actual_digest != digest:
                raise RuntimeError(f"controller runtime payload digest mismatch for {rel}")

    @staticmethod
    def _validate_entrypoint(manifest: dict[str, Any]) -> str:
        """Return the declared CLI entrypoint, validated against the file set.

        The path must be a declared regular file: not absolute, no traversal,
        no backslashes, no control characters (spec §4.3). It must be one of
        the manifest's files so a manifest can never point execution outside
        the uploaded payload.
        """
        entrypoints = manifest.get("entrypoints")
        if not isinstance(entrypoints, dict):
            raise RuntimeError("controller runtime manifest is missing entrypoints")
        cli = entrypoints.get("cli")
        if not isinstance(cli, dict):
            raise RuntimeError("controller runtime manifest is missing entrypoints.cli")
        if cli.get("launcher") != "node":
            raise RuntimeError("controller runtime CLI launcher must be 'node'")
        entrypoint = cli.get("path")
        if not isinstance(entrypoint, str) or not entrypoint:
            raise RuntimeError("controller runtime manifest CLI entrypoint must be a non-empty path")
        if (
            entrypoint.startswith("/")
            or "\\" in entrypoint
            or entrypoint.startswith("..")
            or "/../" in f"/{entrypoint}"
        ):
            raise RuntimeError(f"controller runtime manifest CLI entrypoint escapes the payload: {entrypoint}")
        if any(ord(ch) < 0x20 for ch in entrypoint):
            raise RuntimeError(f"controller runtime manifest CLI entrypoint contains control characters: {entrypoint!r}")
        files = manifest.get("files")
        if not isinstance(files, list):
            raise RuntimeError("controller runtime manifest is missing files")
        declared = {file.get("path") for file in files if isinstance(file, dict)}
        if entrypoint not in declared:
            raise RuntimeError(f"controller runtime manifest CLI entrypoint is not a declared file: {entrypoint}")
        return entrypoint

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        session = getattr(environment, "_hitch_benchmark", None)
        config = session.config if session else None
        driver = config["task"]["driver"] if config else None
        phases = driver["config"].get("native_phases") if driver and driver["kind"] == "tool-server" else None
        if phases:
            from hitch_phase_supervisor import NativePhaseSupervisor
            task_timeout = int(config["agent_timeout_sec"] * 1000)
            remaining = min(task_timeout, self.hitch_timeout_ms) if self.hitch_timeout_ms > 0 else task_timeout
            result = await NativePhaseSupervisor(
                self, environment, controller={"service": driver["config"]["service"], "argv": phases["argv"]},
                binding={"endpoint": driver["config"]["endpoint"], "tools": config["tools"]},
                task_digest=config["task_digest"], timeout_ms=remaining,
                shutdown_timeout_ms=phases["shutdown_timeout_ms"],
                finalization_timeout_ms=phases.get("finalization_timeout_ms"),
                task_instruction=instruction,
            ).run()
            context.metadata = {"candidate_id": self.candidate_id, "harness_ref": self.harness_ref,
                                "revision_identity": self.revision_identity, "controller_runtime_id": self.controller_runtime_id,
                                "hitch_context_kind": "benchmark_phase_group", "hitch_run_group_id": result["run_group_id"],
                                "hitch_phase_count": len(result["phases"]), "hitch_status": "succeeded",
                                "hitch_phase_supervision": "hitch-native-phases/supervision.json"}
            return
        started_ns = time.monotonic_ns()
        try:
            await self._run(instruction, environment, context)
        finally:
            self._write_phase_timing("agent", started_ns)

    def _phase_identity(self) -> str:
        identity = [self.candidate_id, self.harness_ref, self.revision_identity, self.controller_runtime_id,
                    self.model_name, self.agent_args, self.credential_names, self._require_workdir(),
                    self.eval_id, self.benchmark_id, self.benchmark_revision, self.verifier_identity, self._trial_identity()]
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def prepare_phase(self, *, instruction: str, run_group_id: str, phase_index: int,
                      task_digest: str, remaining_timeout_ms: int) -> PreparedPhase:
        """Reserve identity before private tool binding; does not start a model.

        The supervisor supplies one frozen task digest across all phases and a
        remaining whole-task budget. Time spent binding/uploading consumes that
        budget too. The returned immutable handle is single-use on this agent.
        """
        if not self._setup_complete or not self._phase_export_available:
            raise RuntimeError("phase preparation requires setup with a phase-export capable runtime")
        if self._prepared_phase is not None or self._phase_inflight:
            raise RuntimeError("another candidate phase is already prepared or running")
        if (not isinstance(instruction, str) or not instruction.strip()
                or not isinstance(run_group_id, str) or not re.fullmatch(r"run_group_[a-f0-9]{32}", run_group_id)
                or type(phase_index) is not int or not 1 <= phase_index <= 10000
                or not isinstance(task_digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", task_digest)
                or type(remaining_timeout_ms) is not int or not 1 <= remaining_timeout_ms <= 9007199254740991):
            raise ValueError("invalid candidate phase identity or remaining budget")
        if not all((self.eval_id, self.benchmark_id, self.benchmark_revision, self.verifier_identity)):
            raise ValueError("candidate phases require a complete eval and benchmark identity")
        if (not re.fullmatch(r"eval_[a-f0-9]{32}", self.eval_id)
                or any(not re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in (self.benchmark_revision, self.verifier_identity))):
            raise ValueError("candidate phase eval and benchmark identities must be immutable")
        key = (run_group_id, phase_index)
        if key in self._prepared_phase_keys:
            raise RuntimeError("candidate phase identity was already prepared; implicit retries are forbidden")
        identity = self._phase_identity()
        previous = self._phase_group_contracts.get(run_group_id)
        if (previous is None and phase_index != 1
                or previous is not None and previous != (task_digest, identity, phase_index - 1)):
            raise RuntimeError("candidate phase group must retain its task/candidate identity and consecutive indices")
        trial_id, task_id, attempt = self._trial_identity()
        context = {"kind": "benchmark_phase", "benchmark_id": self.benchmark_id,
                   "benchmark_revision": self.benchmark_revision, "task_id": task_id,
                   "task_digest": task_digest, "verifier_identity": self.verifier_identity,
                   "run_group_id": run_group_id, "phase_index": phase_index}
        parent = {"kind": "eval", "eval_id": self.eval_id, "trial_id": trial_id, "attempt": attempt}
        prepared = PreparedPhase("run_" + uuid.uuid4().hex, instruction, json.dumps(context, sort_keys=True),
                                 json.dumps(parent, sort_keys=True), identity,
                                 time.monotonic_ns() + remaining_timeout_ms * 1_000_000)
        self._phase_control_tokens[prepared.run_id] = secrets.token_hex(32)
        self._prepared_phase_keys.add(key)
        self._phase_group_contracts[run_group_id] = (task_digest, identity, phase_index)
        self._prepared_phase = prepared
        return prepared

    async def run_phase(self, prepared: PreparedPhase, environment: BaseEnvironment, context: AgentContext) -> None:
        if not isinstance(prepared, PreparedPhase) or self._prepared_phase is not prepared or self._phase_inflight:
            raise RuntimeError("candidate phase handle is stale, foreign, or already consumed")
        self._prepared_phase = None  # Every outcome consumes the handle.
        if prepared.identity != self._phase_identity():
            self._phase_control_tokens.pop(prepared.run_id, None)
            raise RuntimeError("candidate identity changed after phase preparation")
        if prepared.deadline_ns <= time.monotonic_ns():
            self._phase_control_tokens.pop(prepared.run_id, None)
            raise RuntimeError("candidate whole-task budget expired before phase start")
        self._phase_inflight = True
        self._active_phase = prepared
        started_ns = time.monotonic_ns()
        try:
            await self._run(prepared.instruction, environment, context, prepared_phase=prepared)
        finally:
            self._phase_inflight = False
            self._active_phase = None
            self._phase_control_tokens.pop(prepared.run_id, None)
            self._write_phase_timing("agent", started_ns)

    @staticmethod
    def _phase_control_path(prepared: PreparedPhase) -> str:
        return f"/tmp/hitch-phase-control-{prepared.run_id}.config.json"

    @staticmethod
    async def _upload_phase_json(environment: BaseEnvironment, target: str, value: dict[str, Any]) -> None:
        # Keep control nonces out of both argv and the mounted agent log tree.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="hitch-phase-control-", delete=False) as handle:
            json.dump(value, handle)
            temporary = Path(handle.name)
        try:
            await environment.upload_file(temporary, target)
            result = await environment.exec(f"chmod 600 {shlex.quote(target)}")
            if result.return_code != 0:
                raise RuntimeError("could not protect candidate phase control input")
        finally:
            temporary.unlink(missing_ok=True)

    async def request_phase_cancellation(self, prepared: PreparedPhase, environment: BaseEnvironment, *, reason: str) -> dict[str, Any]:
        """Request executor cancellation; await run_phase separately for sealed evidence.

        This receipt proves only that the request was delivered, not that the
        model stopped or that a native phase completed. Await this operation
        before recycling the candidate. A caller must separately enforce a
        bounded shutdown/collection allowance and whole-trial failure cleanup.
        """
        if reason not in {"native_phase_reset", "native_task_finished", "task_budget_expired", "cancelled"}:
            raise ValueError("invalid phase cancellation reason")
        if self._phase_cancel_lock is None:
            self._phase_cancel_lock = asyncio.Lock()
        async with self._phase_cancel_lock:
            if not isinstance(prepared, PreparedPhase) or self._active_phase is not prepared:
                raise RuntimeError("candidate phase is not active")
            existing = self._phase_cancel_receipts.get(prepared.run_id)
            if existing is not None:
                if existing["reason"] != reason:
                    raise RuntimeError("candidate phase cancellation reason already fixed")
                if existing["status"] != "delivered":
                    raise RuntimeError("candidate cancellation delivery is incomplete; implicit retries are forbidden")
                return dict(existing)
            phase = json.loads(prepared.context_json)
            record_dir = self.logs_dir.parent / "hitch-phase-control"
            record_dir.mkdir(mode=0o700, exist_ok=True)
            if record_dir.is_symlink() or record_dir.stat().st_mode & 0o077:
                raise RuntimeError("candidate cancellation records require a private host directory")
            record_path = record_dir / f"{prepared.run_id}.request.json"
            receipt = {"schema_version": "hitch-phase-cancel-request@1", "scope": "request-only",
                       "status": "prepared",
                       "request_id": "phase_cancel_" + uuid.uuid4().hex, "run_id": prepared.run_id,
                       "run_group_id": phase["run_group_id"], "phase_index": phase["phase_index"],
                       "reason": reason, "requested_at": datetime.now(timezone.utc).isoformat(),
                       "record_ref": f"hitch-phase-control/{record_path.name}"}
            with record_path.open("x", encoding="utf-8") as handle:
                json.dump(receipt, handle, sort_keys=True)
                handle.write("\n")
            record_path.chmod(0o600)
            self._phase_cancel_receipts[prepared.run_id] = receipt
            try:
                await self._upload_phase_json(environment, self._phase_control_path(prepared).replace(".config.json", ".request.json"), {
                    "schema_version": "hitch-phase-cancel@1", "run_id": prepared.run_id,
                    "token": self._phase_control_tokens[prepared.run_id], "reason": reason,
                })
                receipt["status"] = "delivered"
            except BaseException as error:
                receipt.update(status="delivery_failed", failure_type=type(error).__name__)
                raise
            finally:
                update = record_path.with_suffix(".pending")
                with update.open("x", encoding="utf-8") as handle:
                    json.dump(receipt, handle, sort_keys=True)
                    handle.write("\n")
                update.chmod(0o600)
                update.replace(record_path)
            return dict(receipt)

    async def _run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
        *,
        prepared_phase: PreparedPhase | None = None,
    ) -> None:
        invocation_started_ns = time.monotonic_ns()
        session = getattr(environment, "_hitch_benchmark", None)
        task_budget_ms = self.hitch_timeout_ms
        if prepared_phase is None and session:
            from hitch_benchmark import candidate_instruction
            instruction, task_timeout = candidate_instruction(instruction, environment)
            if task_timeout is not None:
                task_budget_ms = min(task_timeout, task_budget_ms) if task_budget_ms > 0 else task_timeout
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        workdir = self._require_workdir()
        assigned_run_id = prepared_phase.run_id if prepared_phase else "run_" + uuid.uuid4().hex
        run_id = assigned_run_id
        trial_id, task_id, attempt = self._trial_identity()
        context_payload: dict[str, Any] = {"kind": "ad_hoc"}
        parent_payload: dict[str, Any] | None = None
        if prepared_phase is not None:
            context_payload = json.loads(prepared_phase.context_json)
            parent_payload = json.loads(prepared_phase.parent_json)
        elif all((self.eval_id, self.benchmark_id, self.benchmark_revision, self.verifier_identity)):
            workspace_digest = await self._workspace_digest(environment)
            task_digest_input = json.dumps(
                {
                    "benchmark_id": self.benchmark_id,
                    "benchmark_revision": self.benchmark_revision,
                    "task_id": task_id,
                    "instruction": instruction,
                    "initial_workspace_digest": workspace_digest,
                },
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            context_payload = {
                "kind": "benchmark_task",
                "benchmark_id": self.benchmark_id,
                "benchmark_revision": self.benchmark_revision,
                "task_id": task_id,
                "task_digest": "sha256:" + hashlib.sha256(task_digest_input).hexdigest(),
                "verifier_identity": self.verifier_identity,
            }
            parent_payload = {
                "kind": "eval",
                "eval_id": self.eval_id,
                "trial_id": trial_id,
                "attempt": attempt,
            }
        temporary: Path | None = None
        context_temporary: Path | None = None
        parent_temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix="hitch-instruction-",
                suffix=".txt",
                dir=self.logs_dir,
                delete=False,
            ) as handle:
                handle.write(instruction)
                temporary = Path(handle.name)
            remote_instruction = "/tmp/hitch-instruction.txt"
            await environment.upload_file(temporary, remote_instruction)
            context_temporary = self._temporary_json("hitch-context-", context_payload)
            await environment.upload_file(context_temporary, "/tmp/hitch-context.json")
            if parent_payload is not None:
                parent_temporary = self._temporary_json("hitch-parent-", parent_payload)
                await environment.upload_file(parent_temporary, "/tmp/hitch-parent.json")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if context_temporary is not None:
                context_temporary.unlink(missing_ok=True)
            if parent_temporary is not None:
                parent_temporary.unlink(missing_ok=True)

        proxy_environment, proxy_health = await self._model_proxy_environment(environment, run_id)
        if prepared_phase is not None:
            await self._upload_phase_json(environment, self._phase_control_path(prepared_phase), {
                "schema_version": "hitch-phase-control@1", "run_id": run_id, "token": self._phase_control_tokens[run_id],
            })
        if self._entrypoint is None:
            raise RuntimeError("Hitch agent setup() must run before run() to resolve the runtime entrypoint")
        entry = self._remote_entry(self._entrypoint)
        timeout_ms = task_budget_ms
        if prepared_phase is not None:
            timeout_ms = (prepared_phase.deadline_ns - time.monotonic_ns()) // 1_000_000
            if timeout_ms <= 0:
                raise RuntimeError("candidate whole-task budget expired during phase binding/upload")
        elif session:
            preparation_ms = (time.monotonic_ns() - invocation_started_ns) // 1_000_000
            timeout_ms = task_budget_ms - preparation_ms
            (self.logs_dir / "hitch-agent-budget.json").write_text(json.dumps({
                "schema_version": "hitch-agent-budget@1", "run_id": run_id,
                "task_budget_ms": task_budget_ms, "preparation_ms": preparation_ms,
                "hitch_timeout_ms": max(0, timeout_ms),
                "collection_timeout_ms": session.config["profile"]["budget"]["collection_timeout_ms"],
                "scope": "invocation-budget-and-collection-allowance",
            }))
            if timeout_ms <= 0:
                raise RuntimeError("candidate budget expired during input preparation; no model was launched")
        arguments = [
            self._node_prefix(),
            "HITCH_ROOT=/tmp/hitch-state",
            *proxy_environment,
            *(["HITCH_HARBOR_INTERNAL=1"] if self._artifact_uploaded or parent_payload is not None else []),
            f"node {entry} run",
            "--harness",
            shlex.quote(self.harness_ref),
            *self._artifact_cli_args(),
            "--cwd",
            shlex.quote(workdir),
            "--workspace-mode",
            "shared",
            "--prompt-file",
            shlex.quote(remote_instruction),
            "--context-file",
            "/tmp/hitch-context.json",
            "--timeout",
            str(timeout_ms),
            "--output",
            "jsonl",
        ]
        if parent_payload is not None:
            arguments.extend([
                "--parent-file", "/tmp/hitch-parent.json",
                "--internal-run-id", run_id,
            ])
            if prepared_phase is None:
                arguments.append("--internal-defer-benchmark-observation")
            else:
                arguments.extend(["--internal-phase-control", shlex.quote(self._phase_control_path(prepared_phase))])
        if self.model_name:
            arguments.extend(["--model", shlex.quote(self.model_name)])
        for value in self.agent_args:
            arguments.extend(["--agent-arg", shlex.quote(value)])
        for name in self.credential_names:
            arguments.extend(["--internal-credential-name", shlex.quote(name)])
        command = (
            "set -o pipefail; "
            + " ".join(arguments)
            + " 2> >(tee /logs/agent/hitch-stderr.log >&2)"
            + " | tee /logs/agent/hitch-events.jsonl"
        )
        execution = await environment.exec(command, cwd=workdir)
        collection = self._collect_run(
            environment, context, execution, assigned_run_id=assigned_run_id,
            context_payload=context_payload, parent_payload=parent_payload, prepared_phase=prepared_phase,
            workdir=workdir, proxy_health=proxy_health,
        )
        if prepared_phase is not None or not session:
            await collection
            return
        try:
            await asyncio.wait_for(collection, session.config["profile"]["budget"]["collection_timeout_ms"] / 1000)
        except asyncio.TimeoutError as error:
            # A completed process with uncollected evidence is still invalid.
            # Do not fabricate a terminal bundle or relabel it as model success.
            receipt = {"code": "hitch_run_collection_timeout", "run_id": assigned_run_id,
                       "process_return_code": execution.return_code}
            (self.logs_dir / "hitch-collection-timeout.json").write_text(json.dumps(receipt))
            raise RuntimeError("hitch_run_collection_timeout: terminal evidence export exceeded its allowance") from error

    async def _collect_run(
        self, environment: BaseEnvironment, context: AgentContext, execution: ExecResult, *,
        assigned_run_id: str, context_payload: dict[str, Any], parent_payload: dict[str, Any] | None,
        prepared_phase: PreparedPhase | None,
        workdir: str, proxy_health: str,
    ) -> None:
        run_id = assigned_run_id
        trial_id, task_id, attempt = self._trial_identity()
        events = self._events(execution.stdout or "")
        observed_run_id = next((
            value
            for event in events
            for value in [event.get("run_id")]
            if isinstance(value, str) and re.fullmatch(r"run_[a-f0-9]{32}", value)
        ), None)
        if observed_run_id and prepared_phase is None:
            run_id = str(observed_run_id)
        result_path = f"/tmp/hitch-state/runs/{run_id}/result.json"
        quoted_result_path = shlex.quote(result_path)
        result_read = await environment.exec(
            f"""
if [ ! -e {quoted_result_path} ]; then exit {HITCH_RESULT_MISSING_EXIT}; fi
if [ -L {quoted_result_path} ] || [ ! -f {quoted_result_path} ]; then exit {HITCH_RESULT_NOT_FILE_EXIT}; fi
cat -- {quoted_result_path}
""".strip()
        )
        result_copy = await environment.exec(
            f"if [ -f {quoted_result_path} ] && [ ! -L {quoted_result_path} ]; then "
            f"cp -- {quoted_result_path} /logs/agent/hitch-result.json; fi"
        )
        bundle_stage = f"/logs/agent/.hitch-run-bundle.{uuid.uuid4().hex}"
        bundle_marker = json.dumps({
            "schema_version": "1",
            "run_id": run_id,
            "eval_id": self.eval_id,
            "trial_id": trial_id,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }, separators=(",", ":"))
        legacy_export = (
            f"""
set -eu
source_dir={shlex.quote(f'/tmp/hitch-state/runs/{run_id}')}
target_dir=/logs/agent/hitch-run-bundle
stage_dir={shlex.quote(bundle_stage)}
rm -rf "$stage_dir"
mkdir -p "$stage_dir"
for name in request.json resolution.json manifest.json result.json events.jsonl stdout.log stderr.log trajectory.ref.json trajectory; do
  if [ -e "$source_dir/$name" ]; then cp -a "$source_dir/$name" "$stage_dir/$name"; fi
done
printf '%s\n' {shlex.quote(bundle_marker)} > "$stage_dir/bundle.complete.json"
rm -rf "$target_dir"
mv "$stage_dir" "$target_dir"
""".strip()
        )
        if prepared_phase is None:
            bundle_export = await environment.exec(legacy_export)
        else:
            export_input = {"sourceDirectory": f"/tmp/hitch-state/runs/{run_id}", "destinationDirectory": bundle_stage,
                            "expected": {"run_id": run_id, "context": context_payload, "parent": parent_payload,
                                         "revision_identity": self.revision_identity}}
            # Completion is outside the bundle: adding even a marker inside a
            # sealed bundle changes its indexed file set and invalidates it.
            script = (
                f"import {{copySealedPhaseRunBundle}} from 'file:///opt/hitch/{PHASE_EXPORT_MODULE}';"
                "import {open,lstat,rename,writeFile} from 'node:fs/promises';"
                "const input=JSON.parse(process.argv[1]);"
                "const target='/logs/agent/hitch-run-bundle';"
                "const lock=await open('/logs/agent/.hitch-phase-export.lock','wx',0o600);await lock.close();"
                "try{await lstat(target);throw new Error('phase export target already exists')}catch(e){if(e.code!=='ENOENT')throw e;}"
                "const index=await copySealedPhaseRunBundle(input);"
                "await rename(input.destinationDirectory,target);"
                "await writeFile('/logs/agent/hitch-phase.complete.json',JSON.stringify({schema_version:'1',"
                "run_id:index.run_id,bundle_digest:index.bundle_digest,scope:'candidate-evidence-only'}),{flag:'wx',mode:0o600});"
            )
            bundle_export = await environment.exec(
                f"{self._node_prefix()} node --input-type=module -e {shlex.quote(script)} {shlex.quote(json.dumps(export_input))}"
            )
        hitch_result, result_error_code, result_error_message = self._parse_hitch_result(result_read, run_id)
        if prepared_phase is None and hitch_result is not None and getattr(environment, "_hitch_benchmark", None):
            from hitch_benchmark import export_final_response
            await export_final_response(environment, hitch_result)
        primary_code: str | None = None
        primary_message: str | None = None
        if prepared_phase is not None and observed_run_id and observed_run_id != assigned_run_id:
            primary_code = "hitch_phase_run_identity_mismatch"
            primary_message = "Hitch phase emitted a different run ID from its prepared tool binding"
        elif execution.return_code != 0:
            primary_code = "hitch_process_failed"
            diagnostic = self._exec_diagnostic(execution)
            if hitch_result and isinstance(hitch_result.get("error"), dict):
                result_message = hitch_result["error"].get("message")
                if isinstance(result_message, str) and result_message.strip():
                    diagnostic = result_message.strip()
            primary_message = (
                f"Hitch agent run failed with code {execution.return_code} "
                f"(run_id={run_id}, trial_id={trial_id}): {self._bounded_tail(diagnostic)}"
            )
        elif result_error_code is not None:
            primary_code = result_error_code
            primary_message = result_error_message
        elif hitch_result is not None and hitch_result.get("revision_identity") != self.revision_identity:
            primary_code = "hitch_revision_identity_mismatch"
            primary_message = (
                "Hitch resolved a different harness revision inside the trial container "
                f"(run_id={run_id}, trial_id={trial_id}): expected {self.revision_identity}, "
                f"got {hitch_result.get('revision_identity')}"
            )
        elif bundle_export.return_code != 0:
            primary_code = "hitch_run_bundle_export_failed"
            primary_message = f"Hitch run bundle export failed (run_id={run_id}, trial_id={trial_id})"
        elif result_copy.return_code != 0:
            primary_code = "hitch_result_artifact_copy_failed"
            primary_message = f"Hitch result artifact copy failed (run_id={run_id}, trial_id={trial_id})"

        context.metadata = {
            "candidate_id": self.candidate_id,
            "harness_ref": self.harness_ref,
            "revision_identity": self.revision_identity,
            "controller_runtime_id": self.controller_runtime_id,
            "hitch_run_id": run_id,
            "hitch_run_bundle": "hitch-run-bundle",
            "hitch_workdir": workdir,
            "hitch_workdir_source": self._workdir_source,
            "eval_id": self.eval_id,
            "trial_id": trial_id,
            "task_id": task_id,
            "attempt": attempt,
            "model_capture_health": proxy_health,
            "hitch_status": hitch_result.get("status") if hitch_result else None,
            "hitch_artifact_id": hitch_result.get("artifact_id") if hitch_result else None,
        }
        if prepared_phase is not None:
            context.metadata.update(hitch_context_kind="benchmark_phase", hitch_run_group_id=context_payload["run_group_id"],
                                    hitch_phase_index=context_payload["phase_index"],
                                    hitch_phase_bundle_exported=bundle_export.return_code == 0,
                                    hitch_phase_completion="hitch-phase.complete.json")
        if self._artifact_manifest is not None:
            context.metadata["harness_artifact_transport"] = {
                "artifact_id": self._artifact_manifest["artifact_id"],
                "artifact_integrity": self._artifact_manifest["artifact_integrity"],
                "platform": self._artifact_manifest["platform"],
                "node_version": self._artifact_manifest.get("toolchain", {}).get("node"),
                "status": self._artifact_transport_status or "dedicated_builder_upload",
            }
        if primary_code is not None:
            context.metadata["hitch_bridge_error_code"] = primary_code
            context.metadata["hitch_bridge_error_artifact"] = "hitch-bridge-error.json"
            evidence = self._bridge_error_evidence(
                code=primary_code,
                message=primary_message or primary_code,
                trial_id=trial_id,
                task_id=task_id,
                attempt=attempt,
                assigned_run_id=assigned_run_id,
                observed_run_id=str(observed_run_id) if observed_run_id else None,
                result_path=result_path,
                execution=execution,
                result_read=result_read,
                result_diagnostic=result_error_code,
                last_event=events[-1] if events else None,
                bundle_export=bundle_export,
                result_copy=result_copy,
            )
            await self._write_bridge_error(environment, evidence)
            raise HitchBridgeError(primary_code, primary_message or primary_code, evidence)

    async def _model_proxy_environment(
        self,
        environment: BaseEnvironment,
        run_id: str,
    ) -> tuple[list[str], str]:
        if self.model_capture is None:
            return [], "not-configured"
        health = self.model_capture["health_url_template"].replace("{run_id}", run_id)
        script = (
            "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)})"
            ".then(r=>{if(!r.ok)throw new Error('status '+r.status)})"
            ".catch(()=>{console.error('model proxy health check failed');process.exit(1)})"
        )
        probe = await environment.exec(
            f"{self._node_prefix()} node -e {shlex.quote(script)} {shlex.quote(health)}"
        )
        if probe.return_code != 0:
            if self.model_capture["required"]:
                raise RuntimeError("hitch-model-proxy-health: required model proxy is unreachable")
            return [], "degraded-unreachable"
        base = self.model_capture["base_url_template"].replace("{run_id}", run_id)
        return [
            f"OPENAI_BASE_URL={shlex.quote(base.replace('{provider}', 'openai'))}",
            f"ANTHROPIC_BASE_URL={shlex.quote(base.replace('{provider}', 'anthropic'))}",
        ], "healthy"

    @staticmethod
    def _parse_hitch_result(
        result: ExecResult,
        expected_run_id: str,
    ) -> tuple[dict[str, Any] | None, str | None, str | None]:
        if result.return_code != 0:
            if result.return_code == HITCH_RESULT_MISSING_EXIT:
                return None, "hitch_result_missing", f"Hitch result file is missing (run_id={expected_run_id})"
            if result.return_code == HITCH_RESULT_NOT_FILE_EXIT:
                return None, "hitch_result_not_file", f"Hitch result path is not a regular file (run_id={expected_run_id})"
            return None, "hitch_result_read_failed", (
                f"Hitch result file could not be read with code {result.return_code} (run_id={expected_run_id})"
            )
        payload = (result.stdout or "").strip()
        if not payload:
            return None, "hitch_result_empty", f"Hitch result file is empty (run_id={expected_run_id})"
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            return None, "hitch_result_invalid_json", f"Hitch result is not valid JSON (run_id={expected_run_id})"
        if not isinstance(value, dict):
            return None, "hitch_result_schema_invalid", f"Hitch result must be a JSON object (run_id={expected_run_id})"
        error = HitchHarborAgent._result_schema_error(value)
        if error is not None:
            return None, "hitch_result_schema_invalid", f"Hitch result schema is invalid: {error} (run_id={expected_run_id})"
        if value["run_id"] != expected_run_id:
            return None, "hitch_result_run_id_mismatch", (
                f"Hitch result run id mismatch: expected {expected_run_id}, got {value['run_id']}"
            )
        return value, None, None

    @staticmethod
    def _result_schema_error(value: dict[str, Any]) -> str | None:
        if value.get("schema_version") != "1":
            return "schema_version must be '1'"
        run_id = value.get("run_id")
        if not isinstance(run_id, str) or re.fullmatch(r"run_[a-f0-9]{32}", run_id) is None:
            return "run_id is invalid"
        if value.get("status") not in {"succeeded", "failed", "timed_out", "cancelled"}:
            return "status is invalid"
        exit_code = value.get("exit_code")
        if isinstance(exit_code, bool) or not isinstance(exit_code, int) or exit_code < 0:
            return "exit_code must be a non-negative integer"
        completed_at = value.get("completed_at")
        if not isinstance(completed_at, str) or not completed_at.strip():
            return "completed_at must be a non-empty string"
        if "error" in value:
            error = value["error"]
            if not isinstance(error, dict):
                return "error must be an object"
            if not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
                return "error.code and error.message must be strings"
        return None

    def _bridge_error_evidence(
        self,
        *,
        code: str,
        message: str,
        trial_id: str,
        task_id: str,
        attempt: int,
        assigned_run_id: str,
        observed_run_id: str | None,
        result_path: str,
        execution: ExecResult,
        result_read: ExecResult,
        result_diagnostic: str | None,
        last_event: dict[str, Any] | None,
        bundle_export: ExecResult,
        result_copy: ExecResult,
    ) -> dict[str, Any]:
        signal_value = getattr(execution, "signal", None)
        evidence: dict[str, Any] = {
            "schema_version": "1",
            "code": code,
            "message": self._bounded_tail(message, 2048),
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "eval_id": self.eval_id,
            "trial_id": trial_id,
            "task_id": task_id,
            "attempt": attempt,
            "assigned_run_id": assigned_run_id,
            "observed_run_id": observed_run_id,
            "result_path": result_path,
            "process": {
                "return_code": execution.return_code,
                "signal": signal_value if isinstance(signal_value, str) else None,
                "stdout_tail": self._bounded_tail(execution.stdout or ""),
                "stderr_tail": self._bounded_tail(execution.stderr or ""),
            },
            "result_read": {
                "return_code": result_read.return_code,
                "stdout_tail": self._bounded_tail(result_read.stdout or ""),
                "stderr_tail": self._bounded_tail(result_read.stderr or ""),
            },
            "last_event": self._bounded_event(last_event),
            "result_diagnostic": result_diagnostic,
        }
        if bundle_export.return_code != 0:
            evidence["bundle_export"] = {
                "return_code": bundle_export.return_code,
                "stdout_tail": self._bounded_tail(bundle_export.stdout or ""),
                "stderr_tail": self._bounded_tail(bundle_export.stderr or ""),
            }
        if result_copy.return_code != 0:
            evidence["result_copy"] = {
                "return_code": result_copy.return_code,
                "stdout_tail": self._bounded_tail(result_copy.stdout or ""),
                "stderr_tail": self._bounded_tail(result_copy.stderr or ""),
            }
        if len(json.dumps(evidence, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > HITCH_BRIDGE_ERROR_MAX_BYTES:
            evidence["message"] = self._bounded_tail(str(evidence["message"]), 1024)
            evidence["last_event"] = self._bounded_event_summary(last_event)
            for section_name in ["process", "result_read", "bundle_export", "result_copy"]:
                section = evidence.get(section_name)
                if not isinstance(section, dict):
                    continue
                for field in ["stdout_tail", "stderr_tail"]:
                    section[field] = self._bounded_tail(str(section.get(field, "")), 2048)
            evidence["diagnostics_truncated"] = True
        return evidence

    @staticmethod
    def _bounded_tail(value: str, max_bytes: int = HITCH_DIAGNOSTIC_MAX_BYTES) -> str:
        encoded = value.encode("utf-8", errors="replace")
        if len(encoded) <= max_bytes:
            return value
        marker = f"[truncated {len(encoded) - max_bytes} bytes]\n".encode("utf-8")
        available = max(0, max_bytes - len(marker))
        suffix = encoded[-available:] if available else b""
        suffix = suffix.decode("utf-8", errors="ignore").encode("utf-8")
        return (marker + suffix).decode("utf-8")

    @staticmethod
    def _bounded_event(event: dict[str, Any] | None) -> dict[str, Any] | None:
        if event is None:
            return None
        encoded = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) <= HITCH_DIAGNOSTIC_MAX_BYTES:
            return event
        return HitchHarborAgent._bounded_event_summary(event)

    @staticmethod
    def _bounded_event_summary(event: dict[str, Any] | None) -> dict[str, Any] | None:
        if event is None:
            return None
        return {
            "type": event.get("type"),
            "run_id": event.get("run_id"),
            "truncated": True,
        }

    @staticmethod
    async def _write_bridge_error(environment: BaseEnvironment, evidence: dict[str, Any]) -> None:
        payload = json.dumps(evidence, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        await environment.exec(
            f"umask 077; printf '%s\\n' {shlex.quote(payload)} > {HITCH_BRIDGE_ERROR_LOG}",
            cwd="/",
        )

    def _trial_identity(self) -> tuple[str, str, int]:
        """Read Harbor's stable trial/task identity from the persisted trial state."""
        trial_dir = self.logs_dir.parent if self.logs_dir.name == "agent" else self.logs_dir
        trial_id = trial_dir.name or "trial__1"
        task_id = self._locked_task_id(trial_dir)
        if self.logical_attempt is not None:
            fallback_task_id = trial_id.rsplit("__", 1)[0] if "__" in trial_id else trial_id
            return trial_id, task_id or fallback_task_id, self.logical_attempt
        match = re.fullmatch(r"(.+)__(\d+)", trial_id)
        if match:
            return trial_id, task_id or match.group(1), max(1, int(match.group(2)))
        # Harbor 0.21 uses a random seven-character suffix and truncates the
        # task portion of trial_name. It therefore cannot be used to recover
        # task identity; the trial lock above is authoritative. Keep the split
        # only as a compatibility fallback for older/fake Harbor runtimes.
        fallback_task_id = trial_id.rsplit("__", 1)[0] if "__" in trial_id else trial_id
        return trial_id, task_id or fallback_task_id, 1

    @staticmethod
    def _locked_task_id(trial_dir: Path) -> str | None:
        lock_path = trial_dir / "lock.json"
        if not lock_path.is_file():
            return None
        try:
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Harbor trial lock is unreadable: {lock_path}") from error
        task = lock.get("task") if isinstance(lock, dict) else None
        task_id = task.get("name") if isinstance(task, dict) else None
        if not isinstance(task_id, str) or not task_id.strip():
            raise RuntimeError(f"Harbor trial lock has no task.name: {lock_path}")
        return task_id.strip()

    def _temporary_json(self, prefix: str, value: dict[str, Any]) -> Path:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=prefix,
            suffix=".json",
            dir=self.logs_dir,
            delete=False,
        ) as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            return Path(handle.name)

    async def _workspace_digest(self, environment: BaseEnvironment) -> str:
        workdir = self._require_workdir()
        script = r"""
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = crypto.createHash('sha256');
function walk(root, relative = '') {
  const directory = path.join(root, relative);
  for (const name of fs.readdirSync(directory).sort()) {
    const child = relative ? path.join(relative, name) : name;
    const absolute = path.join(root, child);
    const info = fs.lstatSync(absolute);
    if (info.isDirectory()) { hash.update(`d\0${child}\0${info.mode & 0o7777}\0`); walk(root, child); }
    else if (info.isFile()) { hash.update(`f\0${child}\0${info.mode & 0o7777}\0${info.size}\0`); hash.update(fs.readFileSync(absolute)); hash.update('\0'); }
    else if (info.isSymbolicLink()) { hash.update(`l\0${child}\0${fs.readlinkSync(absolute)}\0`); }
  }
}
walk(process.argv[1]);
process.stdout.write('sha256:' + hash.digest('hex'));
""".strip()
        result = await environment.exec(
            " ".join([self._node_prefix(), "node", "-e", shlex.quote(script), shlex.quote(workdir)]),
            cwd=workdir,
        )
        digest = (result.stdout or "").strip()
        if result.return_code == 0 and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            return digest
        # Older/fake Harbor environments may not expose a readable workspace
        # during bridge tests. Keep a deterministic, visibly synthetic input.
        return "sha256:" + hashlib.sha256(b"workspace-unavailable").hexdigest()

    async def _ensure_node(self, environment: BaseEnvironment) -> None:
        """Select a compatible system Node or an authenticated offline runtime.

        No network, package manager, shell profile, or existing system binary
        is modified here. The archive travels inside the job-pinned artifact,
        including on remote workers and reruns.
        """
        platform = str((self._artifact_manifest or {}).get("platform", ""))
        self._node_bin_directory = None
        check = (
            f"process.exit(process.version === {json.dumps(self.required_node_version)} && "
            f"process.platform + '-' + process.arch === {json.dumps(platform)} ? 0 : 1)"
        )
        staging: str | None = None
        try:
            probe = await asyncio.wait_for(environment.exec(f"node -e {shlex.quote(check)}"), timeout=30)
            if probe.return_code == 0:
                self._node_bin_directory = None
                self._record_node_runtime({"source": "system", "node_version": self.required_node_version, "platform": platform})
                return
            archive, runtime = self._offline_node_runtime()
            native = await self._node_setup_exec(environment, """set -eu
test "$(uname -s)" = Linux
case "$(uname -m)" in
  x86_64|amd64) echo linux-x64 ;;
  aarch64|arm64) echo linux-arm64 ;;
  *) exit 1 ;;
esac""", "hitch_node_runtime_incompatible")
            if (native.stdout or "").strip() != runtime["platform"]:
                raise self._node_runtime_error("hitch_node_runtime_incompatible", "offline Node architecture does not match the task container")
            libc = await self._node_setup_exec(environment, "getconf GNU_LIBC_VERSION", "hitch_node_runtime_incompatible")
            if not re.fullmatch(r"glibc \d+\.\d+", (libc.stdout or "").strip()):
                raise self._node_runtime_error("hitch_node_runtime_incompatible", "offline Node requires a glibc task image; musl is not supported")
            await self._node_setup_exec(
                environment, "command -v sha256sum && command -v tar && command -v gzip", "hitch_node_runtime_prerequisite_missing",
            )
            # Unique per setup; never extract over a system Node or an old,
            # partially installed runtime. The ready directory appears only
            # after checksum, extraction and executable compatibility checks.
            target = f"/opt/hitch-node-runtime-{uuid.uuid4().hex}"
            await self._node_setup_exec(environment, f"mkdir -m 755 {target}", "hitch_node_runtime_install_failed")
            staging = target
            await asyncio.wait_for(environment.upload_file(archive, f"{staging}/node-runtime.tar.gz"), timeout=120)
            checksum = runtime["archive_sha256"].removeprefix("sha256:")
            await self._node_setup_exec(
                environment,
                f"cd {staging} && printf '%s\\n' '{checksum}  node-runtime.tar.gz' | sha256sum -c -",
                "hitch_node_runtime_integrity_mismatch",
            )
            await self._node_setup_exec(
                environment,
                f"umask 022; mkdir -m 755 {staging}/unpacked && tar --no-same-owner -xzf {staging}/node-runtime.tar.gz -C {staging}/unpacked",
                "hitch_node_runtime_install_failed",
            )
            await self._node_setup_exec(
                environment, f"{staging}/unpacked/bin/node -e {shlex.quote(check)}", "hitch_node_runtime_incompatible",
            )
            await self._node_setup_exec(
                environment, f"mv {staging}/unpacked {staging}/ready && rm {staging}/node-runtime.tar.gz", "hitch_node_runtime_install_failed",
            )
            self._node_bin_directory = f"{staging}/ready/bin"
            self._record_node_runtime({"source": "offline-artifact", **runtime, "bin_directory": self._node_bin_directory})
            staging = None
        except Exception as error:
            failure = error if isinstance(error, HitchBridgeError) else self._node_runtime_error(
                "hitch_node_runtime_setup_failed", f"{type(error).__name__}: {error}",
            )
            self._record_node_runtime({"source": "failed", **failure.evidence})
            try:
                await self._write_bridge_error(environment, failure.evidence)
            except Exception:
                pass  # Preserve the original Node failure even if log export fails.
            if failure is error:
                raise
            raise failure from error
        finally:
            if staging is not None:
                # Only the random directory created by this setup is removed.
                try:
                    await asyncio.wait_for(environment.exec(f"rm -rf -- {staging}", user=0), timeout=30)
                except Exception:
                    pass

    def _offline_node_runtime(self) -> tuple[Path, dict[str, Any]]:
        directory = self._artifact_host_directory
        if directory is None or not (directory / ".hitch-node-runtime").exists():
            raise self._node_runtime_error(
                "hitch_node_runtime_missing",
                "task has no matching Node and the pinned artifact has no offline runtime; prepare a new eval with the updated controller (no online fallback)",
            )
        try:
            # Authenticate the runtime metadata against the job's CONTENT pin,
            # not a self-reported checksum in a mutable sidecar. This is needed
            # before Node can run Hitch's normal in-container artifact check.
            captured = {".hitch-node-runtime/node-runtime.json": b""}
            if artifact_directory_integrity(directory, captured) != (self.harness_artifact or {}).get("artifact_integrity"):
                raise RuntimeError("job-pinned harness content digest mismatch before Node bootstrap")
            bundle = directory / ".hitch-node-runtime"
            if bundle.is_symlink() or not bundle.is_dir():
                raise RuntimeError("offline Node bundle must be a regular directory")
            manifest_path = bundle / "node-runtime.json"
            self._assert_regular_host_file(manifest_path, "offline Node manifest", 16_384)
            # Parse exactly the bytes hashed above, not a second sidecar read
            # which could race a cache mutation after content authentication.
            runtime = json.loads(captured[".hitch-node-runtime/node-runtime.json"].decode("utf-8"))
            fields = {"schema_version", "recipe_version", "runtime_id", "node_version", "platform", "libc", "builder_image_id", "archive_sha256", "archive_bytes"}
            if not isinstance(runtime, dict) or set(runtime) != fields:
                raise RuntimeError("offline Node manifest fields are invalid")
            payload = {key: value for key, value in runtime.items() if key != "runtime_id"}
            identity = "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            if runtime["schema_version"] != "1" or runtime["recipe_version"] != "1" or runtime["runtime_id"] != identity:
                raise RuntimeError("offline Node runtime identity is invalid")
            if runtime["node_version"] != self.required_node_version or runtime["platform"] != (self._artifact_manifest or {}).get("platform") or runtime["libc"] != "glibc":
                raise RuntimeError("offline Node manifest does not match the job runtime contract")
            for field in ("archive_sha256", "builder_image_id"):
                if not isinstance(runtime[field], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", runtime[field]):
                    raise RuntimeError(f"offline Node {field} is invalid")
            archive = bundle / "node-runtime.tar.gz"
            info = self._assert_regular_host_file(archive, "offline Node archive", 128 * 1024 * 1024)
            if type(runtime["archive_bytes"]) is not int or info.st_size != runtime["archive_bytes"] or info.st_size <= 0:
                raise RuntimeError("offline Node archive size mismatch")
            archive_digest = hashlib.sha256()
            with archive.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    archive_digest.update(chunk)
            if "sha256:" + archive_digest.hexdigest() != runtime["archive_sha256"]:
                raise RuntimeError("offline Node archive checksum mismatch")
            return archive, runtime
        except Exception as error:
            raise self._node_runtime_error("hitch_node_runtime_integrity_mismatch", str(error)) from error

    async def _node_setup_exec(self, environment: BaseEnvironment, command: str, code: str) -> ExecResult:
        result = await asyncio.wait_for(environment.exec(command, user=0), timeout=60)
        if result.return_code != 0:
            raise self._node_runtime_error(code, f"exit={result.return_code}: {self._exec_diagnostic(result)}")
        return result

    def _node_runtime_error(self, code: str, message: str) -> HitchBridgeError:
        return HitchBridgeError(code, self._bounded_tail(message, 2048), {
            "schema_version": "1", "code": code, "message": self._bounded_tail(message, 2048),
            "eval_id": self.eval_id, "node_version": self.required_node_version,
            "platform": (self._artifact_manifest or {}).get("platform"),
            "artifact_id": (self.harness_artifact or {}).get("artifact_id"),
        })

    def _record_node_runtime(self, evidence: dict[str, Any]) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "hitch-node-runtime.json").write_text(
            json.dumps({"schema_version": "1", **evidence}, indent=2, sort_keys=True) + "\n", encoding="utf-8",
        )

    def _node_prefix(self) -> str:
        return f"export PATH={shlex.quote(self._node_bin_directory)}:\"$PATH\";" if self._node_bin_directory else ""

    @staticmethod
    def _events(output: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for line in output.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    @staticmethod
    async def _exec(
        environment: BaseEnvironment,
        command: str,
        user: str | int | None = None,
    ) -> ExecResult:
        result = await environment.exec(command, user=user)
        if result.return_code != 0:
            diagnostic = (result.stderr or result.stdout or "no output").strip()
            raise RuntimeError(f"container setup command failed ({result.return_code}): {diagnostic}")
        return result

    @staticmethod
    def _exec_diagnostic(result: ExecResult) -> str:
        for value in (result.stderr, result.stdout):
            if value and value.strip():
                return value.strip()
        return "no diagnostic output"


def _validate_model_capture(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "mode", "required", "topology", "base_url_template", "health_url_template"
    }:
        raise ValueError("model_capture fields are invalid")
    if (
        value.get("schema_version") != "1"
        or value.get("mode") not in {"proxy", "hybrid"}
        or not isinstance(value.get("required"), bool)
        or value.get("topology") != "host-side"
    ):
        raise ValueError("model_capture identity is invalid")
    for field, provider_count in (("base_url_template", 1), ("health_url_template", 0)):
        template = value.get(field)
        if (
            not isinstance(template, str)
            or not template
            or len(template) > 2048
            or any(character in template for character in ("\x00", "\r", "\n"))
            or template.count("{run_id}") != 1
            or template.count("{provider}") != provider_count
        ):
            raise ValueError(f"model_capture {field} is invalid")
        parsed = urlparse(
            template.replace("{run_id}", "run_" + "a" * 32).replace("{provider}", "openai")
        )
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError(f"model_capture {field} URL is invalid")
    return dict(value)


def canonical_manifest_json(manifest: dict[str, Any]) -> str:
    """Canonically encode the runtime identity `{ schema_version, node_range,
    entrypoints, files }` with sorted object keys and no insignificant
    whitespace, mirroring the TypeScript `canonicalEncodeManifest` (spec §4.4.6).
    `created_at` is descriptive and excluded from the identity."""
    files = manifest.get("files")
    if not isinstance(files, list):
        raise RuntimeError("controller runtime manifest is missing files")
    sorted_files = sorted(
        files,
        key=lambda f: (f.get("path") if isinstance(f, dict) else "").encode("utf-8"),
    )
    payload = {
        "schema_version": manifest.get("schema_version"),
        "node_range": manifest.get("node_range"),
        "entrypoints": manifest.get("entrypoints"),
        "files": [
            {
                "path": f.get("path"),
                "size": f.get("size"),
                "executable": f.get("executable"),
                "sha256": f.get("sha256"),
            }
            for f in sorted_files
            if isinstance(f, dict)
        ],
    }
    return _canonical_stringify(payload)


def _canonical_stringify(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_canonical_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-8"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _canonical_stringify(value[key])
            for key in keys
        ) + "}"
    return json.dumps(value, ensure_ascii=False)
