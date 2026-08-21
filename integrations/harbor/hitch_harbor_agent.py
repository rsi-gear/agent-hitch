"""Harbor custom agent that runs an immutable harness through Hitch in a trial container."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import stat as stat_module
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

CONTROLLER_RUNTIME_MANIFEST_VERSION = "2"
LOCAL_GIT_TRANSPORT_MANIFEST_VERSION = "1"
LOCAL_GIT_TRANSPORT_MAX_BYTES = 512 * 1024 * 1024
LOCAL_GIT_REMOTE_ROOT = "/opt/hitch-local-source"


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
        local_source_transport: dict[str, Any] | None = None,
        hitch_timeout_ms: int = 900_000,
        agent_args: list[str] | None = None,
        workdir: str = "/app",
        eval_id: str | None = None,
        benchmark_id: str | None = None,
        benchmark_revision: str | None = None,
        verifier_identity: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.harness_ref = harness_ref
        self.revision_identity = revision_identity
        self.hitch_runtime_dir = Path(hitch_runtime_dir)
        self.controller_runtime_id = controller_runtime_id
        self.local_source_transport = dict(local_source_transport) if local_source_transport else None
        self.candidate_id = candidate_id
        self.hitch_timeout_ms = int(hitch_timeout_ms)
        self.agent_args = list(agent_args or [])
        self.workdir = workdir
        self.eval_id = eval_id
        self.benchmark_id = benchmark_id
        self.benchmark_revision = benchmark_revision
        self.verifier_identity = verifier_identity
        self._hitch_version: str | None = None
        self._entrypoint: str | None = None
        self._local_manifest: dict[str, Any] | None = None

    @staticmethod
    def name() -> str:
        return "hitch"

    def version(self) -> str | None:
        return self._hitch_version

    async def setup(self, environment: BaseEnvironment) -> None:
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
        if self.local_source_transport is not None:
            try:
                self._local_manifest = self._verify_local_source_host()
            except Exception as error:
                raise RuntimeError(f"hitch-local-source-materialize: {error}") from error
        payload_dir = self.hitch_runtime_dir / "payload"
        if not payload_dir.is_dir():
            raise RuntimeError(f"Hitch runtime bundle has no payload directory: {self.hitch_runtime_dir}")
        # Upload the cached bundle's payload (package.json + dist/) as the
        # package root under /opt/hitch; the local cache path is host-side
        # bookkeeping and is not identity (spec §4.2).
        await environment.upload_dir(payload_dir, "/opt/hitch")
        await self._ensure_node(environment)
        if self._local_manifest is not None:
            try:
                await self._upload_and_materialize_local_source(environment, self._local_manifest)
            except Exception as error:
                raise RuntimeError(f"hitch-local-source-materialize: {error}") from error
        entry = self._remote_entry(entrypoint)
        version = await self._exec(environment, f"{self._node_prefix()} node {entry} --version")
        self._hitch_version = (version.stdout or "").strip() or None
        prepare = " ".join(
            [
                self._node_prefix(),
                "HITCH_ROOT=/tmp/hitch-state",
                *(["HITCH_HARBOR_INTERNAL=1"] if self._local_manifest is not None else []),
                f"node {entry} prepare",
                shlex.quote(self.harness_ref),
                *self._local_source_cli_args(),
                "--json",
            ]
        )
        await self._exec(environment, prepare)

    def _verify_local_source_host(self) -> dict[str, Any]:
        """Validate the independent local-source handoff immediately before upload."""
        transport = self.local_source_transport or {}
        required = {
            "kind", "manifest_path", "payload_path", "locked_resolution_path", "harness_id",
            "resolution_identity", "commit", "tree", "payload_sha256", "payload_bytes",
            "object_count", "file_count",
        }
        if set(transport) != required:
            raise RuntimeError("local source transport metadata fields are invalid")
        manifest_path = Path(str(transport["manifest_path"]))
        payload_path = Path(str(transport["payload_path"]))
        resolution_path = Path(str(transport["locked_resolution_path"]))
        if not all(candidate.is_absolute() for candidate in (manifest_path, payload_path, resolution_path)):
            raise RuntimeError("local source transport host paths must be absolute")
        self._assert_regular_host_file(manifest_path, "local source manifest", 64 * 1024)
        payload_stat = self._assert_regular_host_file(payload_path, "local source payload", LOCAL_GIT_TRANSPORT_MAX_BYTES)
        self._assert_regular_host_file(resolution_path, "local source locked resolution", 1024 * 1024)
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            resolution = json.loads(resolution_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"local source metadata is unreadable: {error}") from error
        self._validate_local_manifest(manifest)
        pinned = {
            "kind": manifest["kind"],
            "harness_id": manifest["harness_id"],
            "resolution_identity": manifest["resolution_identity"],
            "commit": manifest["commit"],
            "tree": manifest["tree"],
            "payload_sha256": manifest["payload_sha256"],
            "payload_bytes": manifest["payload_bytes"],
            "object_count": manifest["object_count"],
            "file_count": manifest["file_count"],
        }
        if any(transport.get(key) != value for key, value in pinned.items()):
            raise RuntimeError("local source transport metadata does not match its manifest")
        if manifest["resolution_identity"] != self.revision_identity:
            raise RuntimeError("local source resolution identity does not match the job-pinned identity")
        if self.harness_ref != f'{manifest["harness_id"]}@commit:{manifest["commit"]}':
            raise RuntimeError("local source commit does not match the job-pinned harness ref")
        if payload_stat.st_size != manifest["payload_bytes"]:
            raise RuntimeError("local source payload size does not match its manifest")
        actual_digest = self._sha256_file(payload_path)
        if actual_digest != manifest["payload_sha256"]:
            raise RuntimeError("local source payload digest does not match its manifest")
        if not isinstance(resolution, dict) or (
            resolution.get("harness_id") != manifest["harness_id"]
            or resolution.get("identity") != manifest["resolution_identity"]
            or resolution.get("revision", {}).get("commit") != manifest["commit"]
            or resolution.get("source", {}).get("type") != "git"
            or resolution.get("source", {}).get("registered") is not False
        ):
            raise RuntimeError("local source locked resolution does not match its manifest")
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

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return "sha256:" + digest.hexdigest()

    @staticmethod
    def _validate_local_manifest(manifest: Any) -> None:
        allowed = {
            "schema_version", "kind", "harness_id", "resolution_identity", "commit", "tree",
            "payload_sha256", "payload_bytes", "object_count", "file_count", "created_at",
        }
        if not isinstance(manifest, dict) or set(manifest) != allowed:
            raise RuntimeError("local source manifest fields are invalid")
        if manifest.get("schema_version") != LOCAL_GIT_TRANSPORT_MANIFEST_VERSION:
            raise RuntimeError("unsupported local source transport manifest schema")
        if manifest.get("kind") != "local-git-commit":
            raise RuntimeError("unsupported local source transport kind")
        if not isinstance(manifest.get("harness_id"), str) or not re.fullmatch(r"[a-z][a-z0-9-]*", manifest["harness_id"]):
            raise RuntimeError("local source manifest harness id is invalid")
        if not isinstance(manifest.get("resolution_identity"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["resolution_identity"]):
            raise RuntimeError("local source manifest resolution identity is invalid")
        commit = manifest.get("commit")
        if not isinstance(commit, str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", commit):
            raise RuntimeError("local source manifest commit is not a full lowercase OID")
        tree = manifest.get("tree")
        if not isinstance(tree, str) or not re.fullmatch(rf"[0-9a-f]{{{len(commit)}}}", tree):
            raise RuntimeError("local source manifest tree is invalid")
        if not isinstance(manifest.get("payload_sha256"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["payload_sha256"]):
            raise RuntimeError("local source manifest payload digest is invalid")
        for key, maximum in (
            ("payload_bytes", LOCAL_GIT_TRANSPORT_MAX_BYTES),
            ("object_count", 100_000),
            ("file_count", 50_000),
        ):
            value = manifest.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > maximum:
                raise RuntimeError(f"local source manifest {key} is invalid")
        if not isinstance(manifest.get("created_at"), str) or not manifest["created_at"]:
            raise RuntimeError("local source manifest created_at is invalid")
        try:
            datetime.fromisoformat(manifest["created_at"].replace("Z", "+00:00"))
        except ValueError as error:
            raise RuntimeError("local source manifest created_at is invalid") from error

    async def _upload_and_materialize_local_source(
        self,
        environment: BaseEnvironment,
        manifest: dict[str, Any],
    ) -> None:
        transport = self.local_source_transport or {}
        await self._exec(environment, f"mkdir -p {LOCAL_GIT_REMOTE_ROOT} && chmod 700 {LOCAL_GIT_REMOTE_ROOT}")
        await environment.upload_file(Path(str(transport["manifest_path"])), f"{LOCAL_GIT_REMOTE_ROOT}/manifest.json")
        await environment.upload_file(Path(str(transport["payload_path"])), f"{LOCAL_GIT_REMOTE_ROOT}/payload.pack")
        await environment.upload_file(Path(str(transport["locked_resolution_path"])), f"{LOCAL_GIT_REMOTE_ROOT}/resolution.json")
        await self._exec(environment, f"chmod 600 {LOCAL_GIT_REMOTE_ROOT}/manifest.json {LOCAL_GIT_REMOTE_ROOT}/payload.pack {LOCAL_GIT_REMOTE_ROOT}/resolution.json")
        # Verify both the uploaded manifest fields and payload bytes inside the
        # trial before importing any Git object. All interpolated values passed
        # to the shell have already been restricted to digest/OID grammars.
        verifier = """
const fs = require('node:fs');
const crypto = require('node:crypto');
const expected = JSON.parse(process.argv[1]);
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error('manifest fields mismatch');
for (const key of Object.keys(expected)) if (manifest[key] !== expected[key]) throw new Error(`manifest mismatch: ${key}`);
if (fs.statSync(process.argv[3]).size !== expected.payload_bytes) throw new Error('payload size mismatch');
(async () => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(process.argv[3])) hash.update(chunk);
  const digest = 'sha256:' + hash.digest('hex');
  if (digest !== expected.payload_sha256) throw new Error('payload digest mismatch');
})().catch((error) => { console.error(error.message); process.exit(1); });
""".strip()
        expected = {
            "schema_version": manifest["schema_version"],
            "kind": manifest["kind"],
            "harness_id": manifest["harness_id"],
            "resolution_identity": manifest["resolution_identity"],
            "commit": manifest["commit"],
            "tree": manifest["tree"],
            "payload_sha256": manifest["payload_sha256"],
            "payload_bytes": manifest["payload_bytes"],
            "object_count": manifest["object_count"],
            "file_count": manifest["file_count"],
            "created_at": manifest["created_at"],
        }
        verify_command = " ".join([
            self._node_prefix(),
            "node", "-e", shlex.quote(verifier),
            shlex.quote(json.dumps(expected, separators=(",", ":"))),
            f"{LOCAL_GIT_REMOTE_ROOT}/manifest.json",
            f"{LOCAL_GIT_REMOTE_ROOT}/payload.pack",
        ])
        await self._exec(environment, verify_command)
        commit = manifest["commit"]
        tree = manifest["tree"]
        materialize = f"""
set -eu
git init --bare {LOCAL_GIT_REMOTE_ROOT}/repo.git >/dev/null
git -C {LOCAL_GIT_REMOTE_ROOT}/repo.git index-pack --stdin < {LOCAL_GIT_REMOTE_ROOT}/payload.pack >/dev/null
test "$(git -C {LOCAL_GIT_REMOTE_ROOT}/repo.git rev-parse {commit}^{{commit}})" = "{commit}"
test "$(git -C {LOCAL_GIT_REMOTE_ROOT}/repo.git rev-parse {commit}^{{tree}})" = "{tree}"
printf '%s\n' {commit} > {LOCAL_GIT_REMOTE_ROOT}/repo.git/shallow
git -C {LOCAL_GIT_REMOTE_ROOT}/repo.git update-ref refs/heads/hitch-local {commit}
"""
        await self._exec(environment, materialize)

    def _local_source_cli_args(self) -> list[str]:
        if self._local_manifest is None:
            return []
        return [
            "--internal-locked-resolution", f"{LOCAL_GIT_REMOTE_ROOT}/resolution.json",
            "--internal-local-git-manifest", f"{LOCAL_GIT_REMOTE_ROOT}/manifest.json",
            "--internal-local-git-source", f"{LOCAL_GIT_REMOTE_ROOT}/repo.git",
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
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        run_id = "run_" + uuid.uuid4().hex
        trial_id, task_id, attempt = self._trial_identity()
        context_payload: dict[str, Any] = {"kind": "ad_hoc"}
        parent_payload: dict[str, Any] | None = None
        if all((self.eval_id, self.benchmark_id, self.benchmark_revision, self.verifier_identity)):
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

        if self._entrypoint is None:
            raise RuntimeError("Hitch agent setup() must run before run() to resolve the runtime entrypoint")
        entry = self._remote_entry(self._entrypoint)
        arguments = [
            self._node_prefix(),
            "HITCH_ROOT=/tmp/hitch-state",
            *(["HITCH_HARBOR_INTERNAL=1"] if self._local_manifest is not None or parent_payload is not None else []),
            f"node {entry} run",
            "--harness",
            shlex.quote(self.harness_ref),
            *self._local_source_cli_args(),
            "--cwd",
            shlex.quote(self.workdir),
            "--workspace-mode",
            "shared",
            "--prompt-file",
            shlex.quote(remote_instruction),
            "--context-file",
            "/tmp/hitch-context.json",
            "--timeout",
            str(self.hitch_timeout_ms),
            "--output",
            "jsonl",
        ]
        if parent_payload is not None:
            arguments.extend([
                "--parent-file", "/tmp/hitch-parent.json",
                "--internal-run-id", run_id,
                "--internal-defer-benchmark-observation",
            ])
        if self.model_name:
            arguments.extend(["--model", shlex.quote(self.model_name)])
        for value in self.agent_args:
            arguments.extend(["--agent-arg", shlex.quote(value)])
        command = (
            "set -o pipefail; "
            + " ".join(arguments)
            + " 2> >(tee /logs/agent/hitch-stderr.log >&2)"
            + " | tee /logs/agent/hitch-events.jsonl"
        )
        execution = await environment.exec(command, cwd=self.workdir)
        events = self._events(execution.stdout or "")
        observed_run_id = next((event.get("run_id") for event in events if event.get("run_id")), None)
        if observed_run_id:
            run_id = str(observed_run_id)
        hitch_result = None
        if run_id:
            result_path = f"/tmp/hitch-state/runs/{run_id}/result.json"
            result = await environment.exec(
                f"cat {shlex.quote(result_path)} | tee /logs/agent/hitch-result.json"
            )
            if result.return_code == 0 and result.stdout:
                hitch_result = json.loads(result.stdout)
            export = await environment.exec(
                f"""
set -eu
source_dir={shlex.quote(f'/tmp/hitch-state/runs/{run_id}')}
target_dir=/logs/agent/hitch-run-bundle
rm -rf "$target_dir"
mkdir -p "$target_dir"
for name in request.json resolution.json manifest.json result.json events.jsonl stdout.log stderr.log trajectory.ref.json trajectory; do
  if [ -e "$source_dir/$name" ]; then cp -a "$source_dir/$name" "$target_dir/$name"; fi
done
""".strip()
            )
            if export.return_code != 0:
                raise RuntimeError("Hitch run bundle export failed before trial teardown")
        context.metadata = {
            "candidate_id": self.candidate_id,
            "harness_ref": self.harness_ref,
            "revision_identity": self.revision_identity,
            "controller_runtime_id": self.controller_runtime_id,
            "hitch_run_id": run_id,
            "hitch_run_bundle": "hitch-run-bundle",
            "eval_id": self.eval_id,
            "trial_id": trial_id,
            "task_id": task_id,
            "attempt": attempt,
            "hitch_status": hitch_result.get("status") if hitch_result else None,
            "hitch_artifact_id": hitch_result.get("artifact_id") if hitch_result else None,
        }
        if self._local_manifest is not None:
            context.metadata["local_source_transport"] = {
                "kind": self._local_manifest["kind"],
                "commit": self._local_manifest["commit"],
                "tree": self._local_manifest["tree"],
                "resolution_identity": self._local_manifest["resolution_identity"],
                "payload_sha256": self._local_manifest["payload_sha256"],
                "payload_bytes": self._local_manifest["payload_bytes"],
                "status": "verified",
            }
        if execution.return_code != 0:
            message = (execution.stderr or "").strip()
            if hitch_result and hitch_result.get("error", {}).get("message"):
                message = hitch_result["error"]["message"]
            raise RuntimeError(
                f"Hitch agent run failed with code {execution.return_code}: {message or 'no diagnostic output'}"
            )
        if hitch_result is None:
            raise RuntimeError("Hitch agent run completed without a persisted result")
        if hitch_result.get("revision_identity") != self.revision_identity:
            raise RuntimeError(
                "Hitch resolved a different harness revision inside the trial container: "
                f"expected {self.revision_identity}, got {hitch_result.get('revision_identity')}"
            )

    def _trial_identity(self) -> tuple[str, str, int]:
        """Derive Harbor's stable trial/task identity from the persisted log path."""
        candidate = self.logs_dir.parent.name if self.logs_dir.name == "agent" else self.logs_dir.name
        trial_id = candidate or "trial__1"
        match = re.fullmatch(r"(.+)__(\d+)", trial_id)
        if match:
            return trial_id, match.group(1), max(1, int(match.group(2)))
        return trial_id, trial_id, 1

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
            " ".join([self._node_prefix(), "node", "-e", shlex.quote(script), shlex.quote(self.workdir)]),
            cwd=self.workdir,
        )
        digest = (result.stdout or "").strip()
        if result.return_code == 0 and re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            return digest
        # Older/fake Harbor environments may not expose a readable workspace
        # during bridge tests. Keep a deterministic, visibly synthetic input.
        return "sha256:" + hashlib.sha256(b"workspace-unavailable").hexdigest()

    async def _ensure_node(self, environment: BaseEnvironment) -> None:
        probe = await environment.exec(
            "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'"
        )
        needs_git = "@commit:" in self.harness_ref
        git_probe = await environment.exec("command -v git >/dev/null 2>&1")
        if probe.return_code == 0 and (not needs_git or git_probe.return_code == 0):
            return
        prerequisites = """
set -eu
if command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then exit 0; fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates git
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ca-certificates git bash
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates git
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates git
else
  echo 'Hitch requires Node.js 22+ and could not install curl in this task image' >&2
  exit 1
fi
"""
        await self._exec(environment, prerequisites, user=0)
        if probe.return_code == 0:
            return
        install = """
set -eu
export NVM_DIR=/opt/hitch-node
mkdir -p "$NVM_DIR"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
"""
        await self._exec(environment, install, user=0)

    @staticmethod
    def _node_prefix() -> str:
        return "if [ -s /opt/hitch-node/nvm.sh ]; then export NVM_DIR=/opt/hitch-node; . /opt/hitch-node/nvm.sh; fi;"

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
