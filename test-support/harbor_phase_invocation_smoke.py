"""Phase invocation contract checks with stub Harbor I/O; no model or VM."""
import asyncio
import json
import re
import sys
import tempfile
from pathlib import Path

from bridge_smoke import AgentContext, BaseEnvironment, ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
bridge = load_bridge(str(Path(__file__).resolve().parents[1] / "integrations/harbor/hitch_harbor_agent.py"))
digest = "sha256:" + "a" * 64
group = "run_group_" + "a" * 32


class Environment(BaseEnvironment):
    def __init__(self, case="valid"):
        super().__init__(digest)
        self.case = case
        self.run_id = None
        self.run_command = None
        self.phase_export = None
        self.context_payload = None

    async def upload_file(self, source, target):
        if target == "/tmp/hitch-context.json":
            self.context_payload = json.loads(Path(source).read_text())
        if self.case == "expired-upload":
            await asyncio.sleep(0.02)
        await super().upload_file(source, target)

    async def exec(self, command, **kwargs):
        if " run " in command and "hitch-events.jsonl" in command:
            self.run_command = command
            self.run_id = re.search(r"--internal-run-id (run_[a-f0-9]{32})", command).group(1)
            observed = "run_" + "b" * 32 if self.case == "wrong-run" else self.run_id
            return ExecResult(stdout=json.dumps({"type": "run.completed", "run_id": observed}), return_code=1 if self.case == "process-failed" else 0)
        if "cat --" in command and "/result.json" in command:
            result = self._valid_result(self.run_id)
            if self.case == "process-failed":
                result.update(status="failed", exit_code=1)
            return ExecResult(stdout=json.dumps(result))
        if "copySealedPhaseRunBundle" in command:
            self.phase_export = command
            return ExecResult(return_code=1 if self.case == "export-failed" else 0)
        return await super().exec(command, **kwargs)


async def rejects(call, message):
    try:
        await call
    except Exception as error:
        assert message in str(error), str(error)
        return
    raise AssertionError("phase invocation unexpectedly accepted")


def prepare(agent, **overrides):
    return agent.prepare_phase(**{"instruction": "native phase one", "run_group_id": group,
                                  "phase_index": 1, "task_digest": digest, "remaining_timeout_ms": 5000, **overrides})


async def main():
    with tempfile.TemporaryDirectory() as temporary:
        for case in ["valid", "wrong-run", "process-failed", "export-failed", "expired-upload", "identity-drift"]:
            logs = Path(temporary) / case / "trial" / "agent"
            logs.mkdir(parents=True)
            (logs.parent / "lock.json").write_text(json.dumps({"schema_version": 2, "task": {"name": "synthetic-phase-task"}}))
            agent = bridge.HitchHarborAgent(logs_dir=logs, harness_ref="codex@version:9.9.9", revision_identity=digest,
                                           hitch_runtime_dir=temporary, workdir="/workspace", eval_id="eval_" + "1" * 32,
                                           benchmark_id="synthetic", benchmark_revision=digest, verifier_identity=digest)
            # Setup capability is fixture input. This test covers the invocation
            # boundary, not runtime deployment or actual candidate execution.
            agent._setup_complete = agent._phase_export_available = True
            agent._entrypoint = "dist/bin/hitch.js"
            env = Environment(case)
            context = AgentContext()
            prepared = prepare(agent, remaining_timeout_ms=10 if case == "expired-upload" else 5000)
            assert env.run_command is None
            assert json.loads(prepared.context_json)["task_digest"] == digest
            await rejects(agent.run_phase(prepared._replace(instruction="forged"), env, context), "stale, foreign")
            if case == "identity-drift":
                agent.agent_args.append("changed")
                await rejects(agent.run_phase(prepared, env, context), "identity changed")
                assert env.run_command is None
                continue
            if case == "expired-upload":
                await rejects(agent.run_phase(prepared, env, context), "budget expired")
                assert env.run_command is None
                continue
            failures = {"wrong-run": "hitch_phase_run_identity_mismatch", "process-failed": "hitch_process_failed", "export-failed": "hitch_run_bundle_export_failed"}
            if case in failures:
                await rejects(agent.run_phase(prepared, env, context), failures[case])
            else:
                await agent.run_phase(prepared, env, context)
            assert "--internal-defer-benchmark-observation" not in env.run_command
            assert env.run_id == prepared.run_id
            assert env.context_payload["kind"] == "benchmark_phase"
            assert context.metadata["hitch_run_id"] == prepared.run_id
            assert context.metadata["hitch_phase_bundle_exported"] == (case != "export-failed")
            assert "hitch-phase.complete.json" in env.phase_export and "bundle.complete.json" not in env.phase_export
            await rejects(agent.run_phase(prepared, env, context), "already consumed")
            try:
                prepare(agent)
            except RuntimeError as error:
                assert "implicit retries" in str(error)
            else:
                raise AssertionError("duplicate phase silently replaced")
            if case == "valid":
                try:
                    prepare(agent, phase_index=2, task_digest="sha256:" + "c" * 64)
                except RuntimeError as error:
                    assert "retain its task" in str(error)
                else:
                    raise AssertionError("phase task digest changed")
                second = prepare(agent, instruction="native phase two", phase_index=2)
                assert second.run_id != prepared.run_id
                assert json.loads(second.context_json)["task_digest"] == digest
    print("phase invocation contract checks passed")


if __name__ == "__main__":
    asyncio.run(main())
