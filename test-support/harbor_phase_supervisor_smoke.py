"""Real native function/RPC + Hitch CLI; synthetic harness and host I/O.

The environment adapter substitutes local directories for candidate containers.
This is orchestration evidence, not an OSWorld task, VM or real model score.
"""
import asyncio
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import sys
import tempfile
import threading
import types
import zlib

from bridge_smoke import AgentContext, ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / "integrations/harbor"))
bridge = load_bridge(str(repo / "integrations/harbor/hitch_harbor_agent.py"))
from hitch_phase_supervisor import NativePhaseSupervisor, PhaseSupervisionError


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


runtime = repo / "benchmark-packages/osworld/runtime"
channel_module = module("channel", runtime / "agent_channel.py")
server_module = module("server", runtime / "controller_server.py")
policy_module = module("policy", runtime / "action_policy.py")
actions = module("actions", repo / "test-support/fixtures/osworld/native_actions.py")
policy = policy_module.GraphicalActionPolicy(actions.ACTION_SPACE)
fixture = repo / "test-support/fixtures/osworld/native_phases.py"
provenance = json.loads(fixture.with_name("provenance.json").read_text())
assert hashlib.sha256(fixture.read_bytes()).hexdigest() == provenance["fixture_sha256"]
native = module("native", fixture)
native.logger = logging.getLogger("native-supervisor-test")
native.datetime, native.json, native.os = __import__("datetime"), json, os
native.DEFAULT_USER_RESPONSE = "synthetic user response"
native.log_task_completion = lambda *_a: None
native.GuestMemoryTracer = lambda *_a: types.SimpleNamespace(capture=lambda *_a, **_k: None)
native.time = types.SimpleNamespace(sleep=lambda _: None, perf_counter=lambda: 0)
native.setup_logger = lambda *_a: None
deadline_module = module("deadline_runner", runtime / "deadline_runner.py")
deadline_run, _ = deadline_module.compile_deadline_runner(fixture.with_name("native_runner_source.py").read_bytes(), native, channel_module.CandidateBudgetExpired)


def chunk(kind, data):
    return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", 1920, 1080, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\x00" + b"\x11\x22\x33" * 1920) * 1080)) + chunk(b"IEND", b"")
digest = "sha256:" + "a" * 64


async def command(*argv, input=None, env=None, timeout=20):
    process = await asyncio.create_subprocess_exec(*map(str, argv), stdin=asyncio.subprocess.PIPE,
                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(input), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    return ExecResult(stdout=stdout.decode(), stderr=stderr.decode(), return_code=process.returncode)


class Guest:
    def __init__(self):
        self.resets, self.actions, self.setups, self.recordings = 0, [], [], []
        self.enable_proxy, self.user_simulator = False, None
        self.action_history, self._step_no, self._traj_no = [], 0, 0
        self.setup_controller = object()
        self.controller = types.SimpleNamespace(start_recording=lambda: self.recordings.append("start"), end_recording=lambda _: self.recordings.append("end"))
    def reset(self, task_config):
        self.resets += 1
    def _get_obs(self):
        return {"screenshot": png, "accessibility_tree": None, "terminal": None}
    def step(self, action, pause):
        self._step_no += 1
        self.action_history.append(action); self.actions.append(action)
        return self._get_obs(), 0, action == "DONE", {}


class Task(dict):
    proxy = False
    task_current_date = "2026-08-08"
    def __init__(self, guest, gated):
        self.guest, self.gated = guest, gated
    def get_phases(self):
        return [dict(name="one", instruction="", evaluate=lambda _: 0.25, gate_min_score=0.3 if self.gated else None),
                dict(name="two", instruction="native second phase", setup=lambda *_a, **_k: self.guest.setups.append("two"), evaluate=lambda _: 0.5)]


class LocalEnvironment:
    def __init__(self, root, server, case):
        self.root, self.server, self.case = root, server, case
        self.trial_paths = types.SimpleNamespace(trial_dir=root)
        self._hitch_ownership_labels = {"io.hitch.lease-id": "synthetic-lease", "io.hitch.lease-epoch": "1"}
        self.events, self.tokens, self.binds = [], [], []
        self.number = 0
        self.fresh()
    def fresh(self):
        self.candidate = self.root / f"candidate-{self.number}"
        self.candidate.mkdir()
        (self.candidate / "workspace").mkdir()
        (self.root / "agent").mkdir(exist_ok=True)
    def mapped(self, target):
        return self.candidate / target.lstrip("/")
    async def upload_file(self, source, target):
        value = Path(source).read_bytes()
        if target == "/tmp/hitch-tool-binding.json":
            binding = json.loads(value)
            self.tokens.append(binding["token"])
            # A fake Compose DNS alias for this localhost-only socket test.
            binding["endpoint"] = f"http://127.0.0.1:{self.server.public.server_address[1]}/"
            value = json.dumps(binding).encode()
        file = self.mapped(target); file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(value); file.chmod(0o600)
        if target.endswith(".request.json") and self.case == "cancel-upload-failed":
            raise RuntimeError("synthetic delivery failure after bytes reached candidate")
    async def exec(self, command, **_kwargs):
        args = shlex.split(command)
        assert args[:2] == ["chmod", "600"]
        self.mapped(args[2]).chmod(0o600)
        return ExecResult()
    async def service_exec(self, text, **kwargs):
        assert kwargs["service"] == "controller"
        request = json.loads(shlex.split(text)[2])
        if request["operation"] == "bind":
            assert self.events[-1] == "setup", self.events
            self.events.append("bind"); self.binds.append(request["parameters"])
        result = await command("/bin/sh", "-c", text, timeout=kwargs["timeout_sec"] + 1)
        if self.case == "finalize-budget" and request["operation"] == "expire_budget":
            # The channel is already fenced. Delay the management reply so the
            # CLI's own timeout wins over the supervisor cancellation request.
            await asyncio.sleep(0.3)
        if self.case == "bad-binding" and request["operation"] == "bind":
            output = json.loads(result.stdout); output["binding"]["tools"] = []
            result.stdout = json.dumps(output)
        if self.case == "bad-state" and request["operation"] == "state":
            result.stdout = '{"state":"leak-' + "f" * 64 + '","state":"bad"}'
        return result
    async def recycle_candidate_phase(self, index):
        assert self.events[-1] == "export"
        self.events.append("retire")
        if self.case == "recycle-failed":
            raise RuntimeError("synthetic recycle error")
        assert self.mapped("/tmp/hitch-tool-binding.json").is_file()
        archive = self.root / f"hitch-candidate-phases/phase-{index:04d}"
        archive.mkdir(parents=True)
        shutil.move(self.root / "agent", archive / "agent")
        receipt = {"status": "completed", "phase_index": index}
        (archive / "receipt.json").write_text(json.dumps(receipt))
        self.number += 1
        self.fresh()
        return receipt
    async def stop_service(self, service):
        assert service == "main" and (self.events[-1] == "export" or self.case == "finalize-between" and self.events[-1] == "setup")
        self.events.append("stop-main")
    async def stop(self, delete):
        assert delete is True
        self.events.append("cleanup")


class SyntheticAgent(bridge.HitchHarborAgent):
    async def setup(self, env):
        assert not (env.candidate / "workspace/candidate-memory.txt").exists()
        env.events.append("setup")
        self._setup_complete = self._phase_export_available = True
        self._phase_supervision_available = True
        if env.case == "finalize-between" and env.number == 1:
            await asyncio.sleep(1.1)
    async def _run(self, instruction, env, context, *, prepared_phase):
        prepared = prepared_phase
        assert env.events[-1] == "bind"
        env.events.append("run")
        parsed_prompt = json.loads(instruction.split("\n", 1)[1])
        expected_guidance = "outer task prompt\nPreserve this protocol guidance in every phase." if env.case in ["complete", "gated", "finalize-budget", "finalize-between"] else ""
        assert parsed_prompt["task_instructions"] == expected_guidance
        assert parsed_prompt["task_current_date"] == "2026-08-08"
        assert parsed_prompt["instruction"] == ("" if env.number == 0 else "native second phase")
        run_context = json.loads(prepared.context_json)
        control_path = self._phase_control_path(prepared)
        await self._upload_phase_json(env, control_path, {"schema_version": "hitch-phase-control@1", "run_id": prepared.run_id,
                                                       "token": self._phase_control_tokens[prepared.run_id]})
        root = env.candidate / "state"
        for name, text in [("context", prepared.context_json), ("parent", prepared.parent_json)]:
            (env.candidate / (name + ".json")).write_text(text)
        variables = {**os.environ, "HITCH_CODEX_PATH": str(self.executable), "HITCH_HARBOR_INTERNAL": "1",
                     "SYNTHETIC_BINDING": str(env.mapped("/tmp/hitch-tool-binding.json")), "SYNTHETIC_MODE": env.case}
        result = await command("node", repo / "dist/bin/hitch.js", "--root", root, "run", "--agent", "codex", "--model", "synthetic-model",
                               "--cwd", env.candidate / "workspace", "--workspace-mode", "shared", "--prompt", instruction,
                               "--context-file", env.candidate / "context.json", "--parent-file", env.candidate / "parent.json",
                               "--internal-run-id", prepared.run_id, "--internal-phase-control", env.mapped(control_path),
                               "--timeout", str(max(1, (prepared.deadline_ns - __import__('time').monotonic_ns()) // 1000000)), env=variables, timeout=30)
        assert self._phase_control_tokens[prepared.run_id] not in result.stdout + result.stderr
        source = root / "runs" / prepared.run_id
        evidence = json.loads((source / "result.json").read_text())
        payload = {"sourceDirectory": str(source), "destinationDirectory": str(self.logs_dir / "hitch-run-bundle"),
                   "expected": {"run_id": prepared.run_id, "context": run_context, "parent": json.loads(prepared.parent_json), "revision_identity": self.revision_identity}}
        script = "import {copySealedPhaseRunBundle} from './dist/src/runs/phase-bundle.js';let text='';for await(const part of process.stdin)text+=part;await copySealedPhaseRunBundle(JSON.parse(text));"
        exported = await command("node", "--input-type=module", "-e", script, input=json.dumps(payload).encode())
        assert exported.return_code == 0, exported.stderr
        env.events.append("export")
        context.metadata = {"hitch_run_id": prepared.run_id, "hitch_phase_bundle_exported": True, "hitch_status": evidence["status"]}
        if result.return_code:
            context.metadata["hitch_bridge_error_code"] = "hitch_process_failed"
            raise bridge.HitchBridgeError("hitch_process_failed", "synthetic cancelled CLI", {})


async def run_case(root, case, executable, revision, controller_runtime):
    finalizing = case.startswith("finalize")
    root.mkdir()
    (root / "lock.json").write_text(json.dumps({"schema_version": 2, "task": {"name": "synthetic-native-phases"}}))
    private = root / "private"; private.mkdir(mode=0o700)
    session = {"token": "0123456789abcdef" * 4, "lease_id": "synthetic-lease", "epoch": 1}
    session_file = private / "session.json"; session_file.write_text(json.dumps(session)); session_file.chmod(0o600)
    channel = channel_module.AgentChannel(root / "channel", (1920, 1080), policy, max_actions_per_turn=1, max_text_bytes=16384)
    channel.task_current_date = "2026-08-08"
    server = server_module.ControllerServer(channel, session, policy, private / "control.sock", public_address=("127.0.0.1", 0), public_endpoint="http://127.0.0.1:0/", native_deadline=finalizing)
    server.endpoint = f"http://controller:{server.public.server_port}/"
    server.start()
    env = LocalEnvironment(root, server, case)
    agent = SyntheticAgent(logs_dir=root / "agent", harness_ref="codex", revision_identity=revision,
                           hitch_runtime_dir=controller_runtime["directory"], controller_runtime_id=controller_runtime["runtime_id"],
                           workdir="/workspace", eval_id="eval_" + "1" * 32, benchmark_id="synthetic-phases", benchmark_revision=digest, verifier_identity=digest)
    agent.executable = executable
    await agent.setup(env)
    supervisor = NativePhaseSupervisor(agent, env, controller={"service": "controller", "argv": [sys.executable, str(runtime / "controller_client.py"), "--socket", str(server.private_socket), "--session", str(session_file)]},
                    binding={"endpoint": server.endpoint, "tools": server.tools}, task_digest=digest, timeout_ms=100 if case == "budget" else 1000 if finalizing else 20000, shutdown_timeout_ms=5000, poll_interval_ms=20, finalization_timeout_ms=5000 if finalizing else None)
    guest, scores, errors = Guest(), [], []
    results = root / "native-results"; results.mkdir()
    def sdk():
        try:
            if finalizing:
                task = Task(guest, False)
                if case == "finalize-failed":
                    phases = task.get_phases()
                    def fail(_): raise RuntimeError("synthetic evaluator failure")
                    phases[0]["evaluate"] = fail
                    task.get_phases = lambda: phases
                deadline_run(channel, guest, task, 1, "", types.SimpleNamespace(sleep_after_execution=0), str(results), scores)
            else:
                native._run_multi_phase_task_example(channel, guest, Task(guest, case == "gated"), 1,
                           types.SimpleNamespace(sleep_after_execution=0), str(results), scores, None)
            channel.finish("completed")
        except BaseException as error:
            errors.append(error); channel.finish("failed")
    thread = threading.Thread(target=sdk)
    if case != "budget":
        thread.start()
    try:
        if case in ["complete", "gated", "finalize-budget", "finalize-between"]:
            env._hitch_benchmark = types.SimpleNamespace(config={
                "task": {"driver": {"kind": "tool-server", "config": {"service": "controller", "endpoint": server.endpoint,
                    "native_phases": {"protocol": "hitch-native-phase-control@2" if finalizing else "hitch-native-phase-control@1", "argv": supervisor.controller["argv"], "audit_path": "/evidence/channel.jsonl", "shutdown_timeout_ms": 5000,
                                      **({"finalization_timeout_ms": 5000} if finalizing else {})}}}},
                "tools": server.tools, "task_digest": digest, "agent_timeout_sec": 1 if finalizing else 20})
            context = AgentContext()
            await agent.run("outer task prompt\nPreserve this protocol guidance in every phase.", env, context)
            result = json.loads((root / "hitch-native-phases/supervision.json").read_text())
            assert context.metadata["hitch_context_kind"] == "benchmark_phase_group"
            assert context.metadata["hitch_run_group_id"] == result["run_group_id"] and "hitch_run_id" not in context.metadata
            count = 1 if case in ["gated", "finalize-budget", "finalize-between"] else 2
            assert result["status"] == "completed" and len(result["phases"]) == count
            assert result["scope"] == "candidate-evidence-only" and "reward" not in result
            assert len({p["evidence"]["provider_session_id"] for p in result["phases"]}) == count
            assert all(p["evidence"]["process_status"] in (["cancelled", "timed_out"] if finalizing else ["cancelled"]) and p["status"] == "sealed" for p in result["phases"])
            assert guest.resets == 1 and guest.actions == ([] if case == "finalize-budget" else ["DONE"] * count)
            assert scores == ([0.25] if case in ["gated", "finalize-budget"] else [0.75])
            assert guest.setups == ([] if case in ["gated", "finalize-budget"] else ["two"])
            if finalizing:
                assert result["budget_finalization"]["status"] == "completed"
                assert result["budget_finalization"]["elapsed_ms"] >= 1000
                assert result["budget_finalization"]["receipt"]["run_id"] == (None if case == "finalize-between" else result["phases"][0]["run_id"])
                if case == "finalize-budget": assert result["phases"][0]["evidence"]["process_status"] == "timed_out"
            assert env.events == ["setup", "bind", "run", "export"] + (["retire", "setup", "bind", "run", "export"] if count == 2 else ["retire", "setup"] if case == "finalize-between" else []) + ["stop-main"]
            for binding in env.tokens:
                try: channel.observe(binding); raise AssertionError("retired binding accepted")
                except PermissionError: pass
        else:
            try: await supervisor.run(); raise AssertionError("expected supervision failure")
            except PhaseSupervisionError:
                result = json.loads((root / "hitch-native-phases/supervision.json").read_text())
                expected = {"early-exit": "native_candidate_exited_before_boundary", "bad-binding": "native_binding_differs_from_locked_definition",
                            "bad-state": "native_controller_rpc_failed", "budget": "native_task_budget_expired",
                            "finalize-failed": "native_controller_failed",
                            "recycle-failed": "RuntimeError", "reused-session": "native_phase_candidate_or_conversation_changed",
                            "cancel-upload-failed": "native_candidate_cancellation_delivery_failed"}
                assert result["failure_code"] == expected[case], result
                assert result["status"] == "failed" and result["cleanup_required"] is False and env.events[-1] == "cleanup"
                assert len(env.binds) <= (2 if case == "reused-session" else 1)
        if case not in ["complete", "gated", "finalize-budget", "finalize-between"]:
            try: await supervisor.run(); raise AssertionError("reused supervisor")
            except PhaseSupervisionError as error: assert "single_use" in str(error)
        persisted = (root / "hitch-native-phases/supervision.json").read_text()
        for secret in [session["token"], "f" * 64, *env.tokens, *agent._phase_control_tokens.values()]:
            assert secret not in persisted
    finally:
        server.close()
        if case != "budget":
            thread.join(5); assert not thread.is_alive()
    print("native supervisor case passed:", case)


async def main():
    with tempfile.TemporaryDirectory(prefix="hps-", dir="/tmp") as temporary:
        root = Path(temporary).resolve()
        executable = root / "synthetic-codex"
        executable.write_text('''#!/usr/bin/env node
const fs = require('node:fs');
if(process.argv.includes('--version')) { console.log('codex-cli 9.9.9'); process.exit(0); }
process.stdin.resume();
const mode = process.env.SYNTHETIC_MODE;
console.log(JSON.stringify({type:'thread.started',thread_id:mode === 'reused-session' ? 'reused' : require('node:crypto').randomUUID()}));
fs.writeFileSync('candidate-memory.txt', 'only this conversation');
if(mode === 'early-exit') { console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})); process.exit(0); }
const binding = JSON.parse(fs.readFileSync(process.env.SYNTHETIC_BINDING, 'utf8'));
async function tool(name, args) {
  const r = await fetch(binding.endpoint + 'call', {method:'POST',headers:{authorization:'Bearer '+binding.token,'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});
  if(!r.ok) throw Error('synthetic tool failure'); return r.json();
}
(async()=>{
  if(mode === 'finalize-budget' || mode === 'finalize-failed') { setInterval(()=>{},1000); return; }
  const observation=await tool('desktop.observe', {}), data=JSON.parse(observation.content[0].text);
  await tool('desktop.submit', {sequence:data.sequence,request_id:'synthetic_submit',response:'done',actions:['DONE']});
  console.log(JSON.stringify({type:'item.completed',item:{id:'submitted',type:'agent_message',text:'submitted action'}}));
  setInterval(()=>{},1000);
})().catch(()=>process.exit(3));
''')
        executable.chmod(0o755)
        script = "import {resolveHarness,parseHarnessReference} from './dist/src/revisions/index.js';console.log((await resolveHarness(parseHarnessReference('codex'),{root:process.argv[1]})).identity)"
        resolved = await command("node", "--input-type=module", "-e", script, root / "resolution", env={**os.environ, "HITCH_CODEX_PATH": str(executable)})
        assert resolved.return_code == 0, resolved.stderr
        # Exercise the same manifest + payload/ layout that a real Harbor job
        # passes to the bridge, rather than the source checkout's dist/ tree.
        runtime_script = "import {ensureControllerRuntime} from './dist/src/controller-runtime/index.js';const r=await ensureControllerRuntime({root:process.argv[1]});console.log(JSON.stringify({directory:r.directory,runtime_id:r.runtime_id}));"
        frozen = await command("node", "--input-type=module", "-e", runtime_script, root / "runtime-state")
        assert frozen.return_code == 0, frozen.stderr
        controller_runtime = json.loads(frozen.stdout)
        for case in ["complete", "gated", "finalize-budget", "finalize-between", "finalize-failed", "early-exit", "bad-binding", "bad-state", "budget", "recycle-failed", "reused-session", "cancel-upload-failed"]:
            await run_case(root / case, case, executable, resolved.stdout.strip(), controller_runtime)
    print("native phase orchestration passed; synthetic host environments only")


if __name__ == "__main__":
    asyncio.run(main())
