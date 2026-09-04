"""Ordinary task deadline/export regression; Harbor I/O and candidate are synthetic."""
import asyncio
import json
from pathlib import Path
import re
import sys
import tempfile
import types

from bridge_smoke import AgentContext, BaseEnvironment, ExecResult, install_harbor_stubs, load_bridge

install_harbor_stubs()
repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo / "integrations/harbor"))
bridge = load_bridge(str(repo / "integrations/harbor/hitch_harbor_agent.py"))
digest = "sha256:" + "a" * 64


class Environment(BaseEnvironment):
    def __init__(self, directory, case):
        super().__init__(digest)
        self.case, self.command, self.exported = case, None, False
        self.environment_dir = directory / "environment"
        self.environment_dir.mkdir()
        self.config = {"task": {"driver": {"kind": "terminal"}, "submission": {}},
                       "agent_timeout_sec": 0.02 if case == "expired" else 1,
                       "profile": {"budget": {"collection_timeout_ms": 30 if case == "collection-stuck" else 1000}}}
        (directory / ".hitch-benchmark.json").write_text(json.dumps(self.config))
        self._hitch_benchmark = types.SimpleNamespace(config=self.config)

    async def upload_file(self, source, target):
        await asyncio.sleep(0.04)
        await super().upload_file(source, target)

    async def exec(self, command, **kwargs):
        if " run " in command and "hitch-events.jsonl" in command:
            self.command = command
            self.run_id = re.search(r"--internal-run-id (run_[a-f0-9]{32})", command).group(1)
            return ExecResult(stdout=json.dumps({"type": "run.failed", "run_id": self.run_id}), return_code=8)
        if "cat --" in command and "/result.json" in command:
            if self.case == "collection-stuck":
                await asyncio.sleep(1)
            result = self._valid_result(self.run_id)
            result.update(status="timed_out", exit_code=8, error={"code": "timed_out", "message": "synthetic timeout"})
            return ExecResult(stdout=json.dumps(result))
        if "bundle.complete.json" in command:
            self.exported = True
        return await super().exec(command, **kwargs)


async def main():
    with tempfile.TemporaryDirectory() as temporary:
        for case, cap in [("task-default", 0), ("larger-cap", 2000), ("smaller-cap", 700), ("expired", 0), ("collection-stuck", 0)]:
            directory = Path(temporary) / case
            logs = directory / "agent"
            logs.mkdir(parents=True)
            (directory / "lock.json").write_text(json.dumps({"schema_version": 2, "task": {"name": "synthetic-timeout"}}))
            agent = bridge.HitchHarborAgent(logs_dir=logs, harness_ref="codex@version:9.9.9", revision_identity=digest,
                hitch_runtime_dir=temporary, workdir="/workspace", hitch_timeout_ms=cap, eval_id="eval_" + "1" * 32,
                benchmark_id="synthetic", benchmark_revision=digest, verifier_identity=digest)
            agent._entrypoint = "dist/bin/hitch.js"
            env, context = Environment(directory, case), AgentContext()
            try:
                await agent.run("synthetic", env, context)
            except RuntimeError as error:
                expected = "input preparation" if case == "expired" else "hitch_run_collection_timeout" if case == "collection-stuck" else "hitch_process_failed"
                assert expected in str(error), str(error)
            else:
                raise AssertionError("synthetic failure was silently accepted")
            budget = json.loads((logs / "hitch-agent-budget.json").read_text())
            assert budget["preparation_ms"] >= 120
            if case == "expired":
                assert env.command is None and budget["hitch_timeout_ms"] == 0
                continue
            allowance = 700 if case == "smaller-cap" else 1000
            assert budget["task_budget_ms"] == allowance
            assert 0 < budget["hitch_timeout_ms"] <= allowance - 120
            assert f'--timeout {budget["hitch_timeout_ms"]}' in env.command
            assert agent.hitch_timeout_ms == cap  # Do not mutate future invocation configuration.
            if case == "collection-stuck":
                assert not env.exported
                assert json.loads((logs / "hitch-collection-timeout.json").read_text())["process_return_code"] == 8
            else:
                assert env.exported and context.metadata["hitch_status"] == "timed_out"
                assert context.metadata["hitch_run_id"] == env.run_id
    print("ordinary budget and bounded timeout export checks passed")


if __name__ == "__main__":
    asyncio.run(main())
