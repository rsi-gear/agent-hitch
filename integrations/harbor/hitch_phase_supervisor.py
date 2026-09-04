"""Trusted native-phase orchestration; no SDK imports or benchmark scoring.

The private controller implements state/bind/cancel. Its native SDK owns task
progress and grading. This worker owns candidate run identities and container
replacement, and records candidate evidence only. Call after initial agent setup
and controller prepare. A failure requires whole-trial cleanup, never a retry of
the same conversation. Public package/assessment integration is a separate layer.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import time
from urllib.parse import urlparse
import uuid

from harbor.models.agent.context import AgentContext


class PhaseSupervisionError(RuntimeError):
    pass


def _json(text):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("duplicate JSON field")
            value[key] = item
        return value
    def constant(_):
        raise ValueError("non-finite JSON number")
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def _positive(value, maximum):
    return type(value) is int and 1 <= value <= maximum


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value)


def _write(path, value):
    temporary = path.with_suffix(".pending")
    with temporary.open("x", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class NativePhaseSupervisor:
    def __init__(self, agent, environment, *, controller, binding, task_digest,
                 timeout_ms, shutdown_timeout_ms=30_000, poll_interval_ms=250,
                 run_group_id=None, finalization_timeout_ms=None, task_instruction=""):
        """controller={service, argv}; binding={endpoint, tools}, both locked.

        timeout_ms is the remaining *whole task* allowance, not a phase budget.
        Shutdown/collection has a distinct allowance and cannot start a model.
        Management credentials stay inside the controller's private session file.
        """
        self.agent, self.env = agent, environment
        if not agent._setup_complete or not agent._phase_supervision_available:
            raise ValueError("native phase supervision requires setup with a compatible frozen runtime")
        if (not isinstance(controller, dict) or set(controller) != {"service", "argv"}
                or not isinstance(controller["service"], str) or controller["service"] == "main"
                or not re.fullmatch(r"[a-z][a-z0-9_-]*", controller["service"])
                or not isinstance(controller["argv"], list) or not 1 <= len(controller["argv"]) <= 32
                or any(not isinstance(v, str) or not v or "\0" in v or len(v) > 8192 for v in controller["argv"])):
            raise ValueError("invalid locked native controller command")
        if not isinstance(binding, dict) or set(binding) != {"endpoint", "tools"}:
            raise ValueError("invalid locked native tool definition")
        endpoint = urlparse(binding["endpoint"])
        if (endpoint.scheme != "http" or endpoint.hostname != controller["service"] or endpoint.path != "/"
                or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
                or not isinstance(binding["tools"], list) or not binding["tools"]):
            raise ValueError("native tools must belong to the locked private controller service")
        if (not _digest(task_digest) or not _positive(timeout_ms, 9007199254740991)
                or not _positive(shutdown_timeout_ms, 600_000) or not _positive(poll_interval_ms, 5000)):
            raise ValueError("invalid native task identity or budget")
        self.group = run_group_id or "run_group_" + uuid.uuid4().hex
        if not isinstance(self.group, str) or not re.fullmatch(r"run_group_[a-f0-9]{32}", self.group):
            raise ValueError("invalid native run group identity")
        if not environment._hitch_ownership_labels or not _digest(agent.revision_identity):
            raise ValueError("native phase supervision requires a leased environment and immutable harness")
        self.controller, self.binding = _json(json.dumps(controller)), _json(json.dumps(binding))
        self.task_digest, self.timeout_ms = task_digest, timeout_ms
        if not isinstance(task_instruction, str):
            raise ValueError("invalid locked task instruction")
        self.task_instruction = task_instruction
        self.shutdown_timeout_ms, self.poll_interval_ms = shutdown_timeout_ms, poll_interval_ms
        if finalization_timeout_ms is not None and not _positive(finalization_timeout_ms, 9007199254740991):
            raise ValueError("invalid native finalization allowance")
        self.finalization_timeout_ms = finalization_timeout_ms
        self.root = Path(environment.trial_paths.trial_dir)
        if self.root.is_symlink() or not self.root.is_dir():
            raise ValueError("native phase evidence requires a real trial directory")
        self.root = self.root.resolve(strict=True)
        self.directory = self.root / "hitch-native-phases"
        self.prepared = self.running = self.context = None
        self.phase_index, self.sequence, self.generation = 0, 0, 0
        self.deadline_ns = 0
        self.used = False
        self.record = None
        self.native_state = None
        self.cancel_reason = None

    def _remaining_ms(self):
        return (self.deadline_ns - time.monotonic_ns()) // 1_000_000

    def _save(self):
        _write(self.directory / "supervision.json", self.record)

    async def _rpc(self, operation, parameters=None, *, cleanup=False):
        remaining = self.shutdown_timeout_ms if cleanup else self._remaining_ms()
        if remaining <= 0:
            raise PhaseSupervisionError("native_task_budget_expired")
        request = {"request_id": "phase_rpc_" + uuid.uuid4().hex, "operation": operation, "parameters": parameters or {}}
        command = "printf %s " + shlex.quote(json.dumps(request)) + " | " + shlex.join(self.controller["argv"])
        try:
            result = await self.env.service_exec(command, service=self.controller["service"], timeout_sec=max(1, math.ceil(min(15000, remaining) / 1000)))
            if result.return_code or not isinstance(result.stdout, str) or len(result.stdout.encode()) > 2 * 1024 * 1024:
                raise ValueError("invalid management result")
            output = _json(result.stdout)
            if not isinstance(output, dict):
                raise ValueError("invalid management output")
            return output
        except asyncio.CancelledError:
            raise
        except Exception:
            # Bind output may contain a token. Never echo stdout/stderr or parse
            # errors, including errors from a service_exec implementation.
            raise PhaseSupervisionError("native_controller_rpc_failed") from None

    async def _state(self, *, finalizing=False):
        state = await self._rpc("state", cleanup=finalizing)
        try:
            if set(state) != {"state", "generation", "sequence", "run_id", "prediction", "task_current_date"}:
                raise ValueError()
            generation, sequence = state["generation"], state["sequence"]
            if (type(generation) is not int or not self.generation <= generation <= self.phase_index + 1
                    or type(sequence) is not int or sequence < self.sequence or generation < 0):
                raise ValueError()
            name, run_id, prediction = state["state"], state["run_id"], state["prediction"]
            if name not in {"created", "context_required", "awaiting_actions", "sdk_executing", "completed", "failed", "cancelled", "finalizing"}:
                raise ValueError()
            if state["task_current_date"] is not None and (not isinstance(state["task_current_date"], str) or len(state["task_current_date"]) > 1024):
                raise ValueError()
            if prediction is not None:
                if (not isinstance(prediction, dict) or set(prediction) != {"sequence", "generation", "instruction", "screenshot_file", "screenshot_sha256", "user_response"}
                        or type(prediction["generation"]) is not int or prediction["generation"] != generation
                        or type(prediction["sequence"]) is not int or prediction["sequence"] != sequence or sequence < 1
                        or not isinstance(prediction["instruction"], str)
                        or prediction["user_response"] is not None and not isinstance(prediction["user_response"], str)
                        or not isinstance(prediction["screenshot_file"], str) or not re.fullmatch(r"observation-[0-9]{6,}\.png", prediction["screenshot_file"])
                        or not isinstance(prediction["screenshot_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", prediction["screenshot_sha256"])):
                    raise ValueError()
            if name == "created" and (generation != 0 or sequence != 0 or prediction is not None):
                raise ValueError()
            if name in {"awaiting_actions", "sdk_executing"}:
                if self.prepared is None or generation != self.phase_index or run_id != self.prepared.run_id:
                    raise ValueError()
                if name == "awaiting_actions" and prediction is None:
                    raise ValueError()
            elif run_id is not None:
                raise ValueError()
            if name == "context_required" and (generation < 1 or generation != self.phase_index + 1):
                raise ValueError()
            if name == "finalizing" and (not finalizing or prediction is not None or not self.record.get("budget_finalization")):
                raise ValueError()
            if name == "completed" and (prediction is not None or not finalizing and (self.prepared is None or generation != self.phase_index)):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise PhaseSupervisionError("native_controller_state_invalid") from None
        self.generation, self.sequence = generation, sequence
        self.native_state = state
        if name in {"failed", "cancelled"}:
            raise PhaseSupervisionError("native_controller_" + name)
        return state

    async def _start(self, state):
        prediction = state["prediction"]
        # Keep the locked task guidance on every fresh candidate, alongside the
        # current native instruction/date. Never carry a prior phase's prompt.
        instruction = ("Complete this native task using the locked tool bridge. "
                       "Run `node /tmp/hitch-tools.mjs list` for schemas and invoke "
                       "`node /tmp/hitch-tools.mjs TOOL_NAME 'JSON_ARGUMENTS'`. "
                       "Open returned image paths with your native image viewing tool.\n"
                       + json.dumps({"task_instructions": self.task_instruction,
                                     "instruction": prediction["instruction"],
                                     "task_current_date": state["task_current_date"]}, ensure_ascii=False))
        self.phase_index += 1
        self.prepared = self.agent.prepare_phase(instruction=instruction, run_group_id=self.group, phase_index=self.phase_index,
                                                  task_digest=self.task_digest, remaining_timeout_ms=self._remaining_ms())
        entry = {"phase_index": self.phase_index, "generation": state["generation"], "run_id": self.prepared.run_id,
                 "status": "prepared", "first_prediction_sequence": prediction["sequence"],
                 "first_screenshot_sha256": prediction["screenshot_sha256"]}
        self.record["phases"].append(entry)
        self._save()
        response = await self._rpc("bind", {"generation": state["generation"], "run_id": self.prepared.run_id})
        binding = response.get("binding")
        if (set(response) != {"binding"} or not isinstance(binding, dict) or set(binding) != {"endpoint", "tools", "token"}
                or binding["endpoint"] != self.binding["endpoint"] or binding["tools"] != self.binding["tools"]
                or not isinstance(binding["token"], str) or not re.fullmatch(r"[a-f0-9]{64}", binding["token"])):
            raise PhaseSupervisionError("native_binding_differs_from_locked_definition")
        with tempfile.TemporaryDirectory(prefix="hitch-phase-binding-") as temporary:
            file = Path(temporary) / "binding.json"
            file.write_text(json.dumps(binding), encoding="utf-8"); file.chmod(0o600)
            await self.env.upload_file(file, "/tmp/hitch-tool-binding.json")
        protected = await self.env.exec("chmod 600 /tmp/hitch-tool-binding.json")
        if protected.return_code:
            raise PhaseSupervisionError("native_binding_protection_failed")
        await self.env.upload_file(Path(__file__).with_name("hitch_tool_client.mjs"), "/tmp/hitch-tools.mjs")
        self.context = AgentContext()
        self.cancel_reason = None
        self.running = asyncio.create_task(self.agent.run_phase(self.prepared, self.env, self.context))
        entry["status"] = "candidate_running"
        self._save()
        # Give run_phase ownership before any cancellation can be requested.
        await asyncio.sleep(0)

    async def _settle(self, reason):
        deadline = time.monotonic_ns() + self.shutdown_timeout_ms * 1_000_000
        if reason == "task_budget_expired" and self.record.get("budget_finalization", {}).get("receipt"):
            self.cancel_reason = reason
        if not self.running.done():
            self.cancel_reason = reason
            try:
                # An uncertain upload must settle as failure and whole-trial
                # cleanup. Never retry or replace a container on that path.
                await asyncio.wait_for(self.agent.request_phase_cancellation(self.prepared, self.env, reason=reason), self.shutdown_timeout_ms / 1000)
            except asyncio.TimeoutError:
                raise PhaseSupervisionError("native_candidate_shutdown_incomplete") from None
            except asyncio.CancelledError:
                raise
            except Exception:
                raise PhaseSupervisionError("native_candidate_cancellation_delivery_failed") from None
        try:
            await asyncio.wait_for(asyncio.shield(self.running), max(0, (deadline - time.monotonic_ns()) / 1_000_000_000))
        except asyncio.TimeoutError:
            raise PhaseSupervisionError("native_candidate_shutdown_incomplete") from None
        except Exception as error:
            # The bridge reports a nonzero executor exit for cancellation; only
            # this specific case can continue to independent bundle inspection.
            metadata = self.context.metadata or {}
            allowed = {"cancelled", "timed_out"} if self.cancel_reason == "task_budget_expired" and self.record.get("budget_finalization", {}).get("receipt") else {"cancelled"}
            if not (self.cancel_reason and getattr(error, "code", None) == "hitch_process_failed" and metadata.get("hitch_status") in allowed
                    and metadata.get("hitch_bridge_error_code") == "hitch_process_failed"):
                raise PhaseSupervisionError("native_candidate_failed") from None
        metadata = self.context.metadata or {}
        if metadata.get("hitch_run_id") != self.prepared.run_id or metadata.get("hitch_phase_bundle_exported") is not True:
            raise PhaseSupervisionError("native_candidate_export_incomplete")

    async def _inspect(self, source):
        module = (self.agent.hitch_runtime_dir / "payload/dist/src/runs/phase-bundle.js").resolve(strict=True)
        node = shutil.which("node")
        if not node:
            raise PhaseSupervisionError("native_phase_inspection_node_missing")
        payload = {"sourceDirectory": str(source), "expected": {"run_id": self.prepared.run_id,
                   "context": _json(self.prepared.context_json), "parent": _json(self.prepared.parent_json),
                   "revision_identity": self.agent.revision_identity}}
        script = ("import {inspectSealedPhaseRunBundle} from " + json.dumps(module.as_uri()) + ";"
                  "let data='';for await(const c of process.stdin)data+=c;"
                  "try{process.stdout.write(JSON.stringify(await inspectSealedPhaseRunBundle(JSON.parse(data))))}"
                  "catch{process.stderr.write('phase evidence invalid');process.exitCode=1}")
        process = await asyncio.create_subprocess_exec(node, "--input-type=module", "-e", script,
                     stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), self.shutdown_timeout_ms / 1000)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode or len(stdout) > 65536:
            raise PhaseSupervisionError("native_phase_evidence_invalid")
        proof = _json(stdout)
        allowed = {"succeeded", "cancelled", "timed_out"} if self.record.get("budget_finalization", {}).get("receipt") else {"succeeded", "cancelled"}
        if proof["process_status"] not in allowed or proof["process_status"] != self.context.metadata.get("hitch_status"):
            raise PhaseSupervisionError("native_phase_process_status_mismatch")
        prior = self.record["phases"][:-1]
        for phase in prior:
            previous = phase["evidence"]
            if (previous["provider_session_id"] == proof["provider_session_id"]
                    or previous["harness"] != proof["harness"] or previous["model"] != proof["model"]
                    or datetime.fromisoformat(previous["completed_at"].replace("Z", "+00:00")) > datetime.fromisoformat(proof["started_at"].replace("Z", "+00:00"))):
                raise PhaseSupervisionError("native_phase_candidate_or_conversation_changed")
        return proof

    async def _retire(self, state):
        finished = state["state"] == "completed"
        await self._settle("task_budget_expired" if self.record.get("budget_finalization", {}).get("receipt") else "native_task_finished" if finished else "native_phase_reset")
        entry = self.record["phases"][-1]
        entry.update(status="candidate_exported", boundary={"state": state["state"], "generation": state["generation"], "sequence": state["sequence"]})
        self._save()
        if finished:
            # At task end this also invokes the normal benchmark snapshot hook.
            await self.env.stop_service("main")
            source = self.root / "agent/hitch-run-bundle"
        else:
            receipt = await self.env.recycle_candidate_phase(self.phase_index)
            if receipt.get("status") != "completed" or receipt.get("phase_index") != self.phase_index:
                raise PhaseSupervisionError("native_candidate_replacement_incomplete")
            source = self.root / f"hitch-candidate-phases/phase-{self.phase_index:04d}/agent/hitch-run-bundle"
            entry["replacement_receipt_ref"] = f"hitch-candidate-phases/phase-{self.phase_index:04d}/receipt.json"
        # No candidate from the retired container can mutate the source now.
        entry.update(status="sealed", bundle_ref=source.relative_to(self.root).as_posix(), evidence=await self._inspect(source))
        self._save()
        self.prepared = self.running = self.context = None
        if not finished:
            await self.agent.setup(self.env)
        return finished

    async def _finalize_budget(self):
        if self._remaining_ms() > 0 or not self.record["phases"]:
            raise PhaseSupervisionError("native_task_budget_expired")
        self.record["budget_finalization"] = {"status": "requested", "timeout_ms": self.finalization_timeout_ms,
                                               "elapsed_ms": self.timeout_ms - self._remaining_ms(),
                                               "requested_at": datetime.now(timezone.utc).isoformat()}
        self._save()
        state = await self._state(finalizing=True)
        if state["state"] != "completed":
            receipt = await self._rpc("expire_budget", cleanup=True)
            expected_run = self.prepared.run_id if self.prepared else None
            if (set(receipt) != {"budget_exhausted", "generation", "sequence", "run_id", "pending_prediction", "action_submitted"}
                    or receipt["budget_exhausted"] is not True
                    or receipt["run_id"] != expected_run and not (receipt["run_id"] is None and receipt["generation"] == self.phase_index + 1)
                    or type(receipt["generation"]) is not int or not self.phase_index <= receipt["generation"] <= self.phase_index + 1
                    or type(receipt["sequence"]) is not int or receipt["sequence"] < self.sequence
                    or type(receipt["pending_prediction"]) is not bool or type(receipt["action_submitted"]) is not bool):
                raise PhaseSupervisionError("native_budget_receipt_invalid")
            self.record["budget_finalization"]["receipt"] = receipt
            self._save()
            if self.prepared:
                await self._settle("task_budget_expired")
            while True:
                state = await self._state(finalizing=True)
                if state["state"] == "completed":
                    break
                if state["state"] != "finalizing":
                    raise PhaseSupervisionError("native_budget_did_not_revoke_candidate")
                await asyncio.sleep(self.poll_interval_ms / 1000)
        else:
            # The SDK completed just before the watchdog was observed. Do not
            # invent a deadline event or replace that native completion reason.
            del self.record["budget_finalization"]
        if self.prepared:
            await self._retire(state)
        else:
            # A reset already retired the previous candidate. Stop the fresh,
            # unused replacement; its archived bundle/receipt remains evidence.
            await self.env.stop_service("main")
        if self.record.get("budget_finalization"):
            self.record["budget_finalization"]["status"] = "completed"
        self.record.update(status="completed", completed_at=datetime.now(timezone.utc).isoformat(),
                           final_native_state={k: state[k] for k in ["state", "generation", "sequence"]})
        self._save()
        return _json(json.dumps(self.record))

    async def _cleanup(self):
        cleanup = {"controller_cancelled": False, "environment_stopped": False, "candidate_settled": self.running is None}
        try:
            cleanup["controller_cancelled"] = await self._rpc("cancel", cleanup=True) == {"cancelled": True}
        except BaseException:
            pass
        if self.running is not None and not self.running.done() and not self.cancel_reason:
            try:
                self.cancel_reason = "task_budget_expired" if self._remaining_ms() <= 0 else "cancelled"
                await asyncio.wait_for(self.agent.request_phase_cancellation(self.prepared, self.env, reason=self.cancel_reason), self.shutdown_timeout_ms / 1000)
            except BaseException:
                pass
        if self.running is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self.running), self.shutdown_timeout_ms / 1000)
            except BaseException:
                pass
        try:
            await self.env.stop(delete=True)
            cleanup["environment_stopped"] = True
        except BaseException:
            pass
        if self.running is not None:
            # Only cancel the host awaiter after whole-environment teardown;
            # cancelling docker-exec alone is not proof the model stopped.
            if not self.running.done() and cleanup["environment_stopped"]:
                self.running.cancel()
                try:
                    await self.running
                except BaseException:
                    pass
            cleanup["candidate_settled"] = self.running.done()
            if self.running.done() and not self.running.cancelled():
                self.running.exception()  # Consume the already recorded failure.
        self.record["cleanup"] = cleanup
        self.record["cleanup_required"] = not all(cleanup.values())
        self._save()

    async def run(self):
        if self.used:
            raise PhaseSupervisionError("native_phase_supervisor_is_single_use")
        self.used = True
        self.directory.mkdir(mode=0o700, exist_ok=False)
        self.deadline_ns = time.monotonic_ns() + self.timeout_ms * 1_000_000
        self.record = {"schema_version": "hitch-native-phase-supervision@1", "scope": "candidate-evidence-only",
                       "run_group_id": self.group, "task_digest": self.task_digest, "status": "running", "phases": [],
                       "started_at": datetime.now(timezone.utc).isoformat(), "timeout_ms": self.timeout_ms}
        self._save()
        try:
            while True:
                try:
                    state = await self._state()
                except PhaseSupervisionError as error:
                    if str(error) == "native_task_budget_expired" and self.finalization_timeout_ms is not None:
                        return await asyncio.wait_for(self._finalize_budget(), self.finalization_timeout_ms / 1000)
                    raise
                if self._remaining_ms() <= 0 and self.finalization_timeout_ms is not None:
                    return await asyncio.wait_for(self._finalize_budget(), self.finalization_timeout_ms / 1000)
                if self.prepared is not None and (state["state"] == "completed" or state["generation"] == self.phase_index + 1):
                    if await self._retire(state):
                        self.record.update(status="completed", completed_at=datetime.now(timezone.utc).isoformat())
                        self._save()
                        return _json(json.dumps(self.record))
                    continue
                if self.prepared is None and state["state"] == "context_required" and state["prediction"] is not None:
                    await self._start(state)
                elif self.running is not None and self.running.done() and state["state"] == "awaiting_actions":
                    # submit atomically switches to sdk_executing. If another
                    # prediction awaits an exited model, no native boundary was
                    # reached; never create a replacement conversation here.
                    raise PhaseSupervisionError("native_candidate_exited_before_boundary")
                elif self.running is not None and self.running.done() and (self.running.cancelled() or self.running.exception() is not None):
                    raise PhaseSupervisionError("native_candidate_failed")
                await asyncio.sleep(min(self.poll_interval_ms, max(0, self._remaining_ms())) / 1000)
        except BaseException as error:
            self.record.update(status="failed", failure_code=str(error) if isinstance(error, PhaseSupervisionError) else type(error).__name__)
            self._save()
            await self._cleanup()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise PhaseSupervisionError(self.record["failure_code"]) from None
