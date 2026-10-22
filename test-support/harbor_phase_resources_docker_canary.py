"""Opt-in real Harbor 0.21.0 / Docker lifecycle canary; never pulls images.

Run with Harbor's Python and an existing bash-capable Linux image:
  python test-support/harbor_phase_resources_docker_canary.py --image IMAGE
Receipts/results remain in the printed temporary directory for inspection.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations" / "harbor"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from harbor.agents.nop import NopAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial
from hitch_harbor_environment import HitchHarborDockerEnvironment
from hitch_phase_resources import PhaseResourceError


class CanaryAgent(NopAgent):
    async def run(self, instruction, environment, context):
        # Keep both real trials running long enough to observe concurrency.
        result = await environment.exec("sleep 3")
        assert result.return_code == 0


class CanaryEnvironment(HitchHarborDockerEnvironment):
    def __init__(self, *args, canary_fail_main_stop=False, **kwargs):
        self.canary_fail_main_stop = canary_fail_main_stop
        super().__init__(*args, **kwargs)

    async def _run_docker_compose_command(self, command, *args, **kwargs):
        if self.canary_fail_main_stop and command[:2] == ["stop", "main"]:
            # Exercise Harbor's real exception-swallowing collect/cleanup path.
            # This does not stop Docker: a live main must not yield a snapshot.
            raise PhaseResourceError("canary injected main stop failure")
        if command and command[0] in ("stop", "down"):
            command = [command[0], "--timeout", "1", *command[1:]]
        return await super()._run_docker_compose_command(command, *args, **kwargs)


async def docker(*args):
    process = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
    if process.returncode:
        raise RuntimeError(f"Docker canary command failed: {args[0]}: {stderr.decode()[:1000]}")
    return stdout.decode()


def make_task(root, image):
    task = root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "instruction.md").write_text("Wait while the simulator prepares the fixed evidence.\n")
    (task / "task.toml").write_text(f'''schema_version = "1.4"
artifacts = [{{source = "/evidence/snapshot.json", service = "simulator"}}]
[environment]
docker_image = {json.dumps(image)}
cpus = 1
memory_mb = 256
network_mode = "public"
[agent]
timeout_sec = 30
[verifier]
environment_mode = "separate"
timeout_sec = 30
[verifier.environment]
docker_image = {json.dumps(image)}
workdir = "/tests"
cpus = 1
memory_mb = 256
network_mode = "public"
''')
    (task / "environment" / "docker-compose.yaml").write_text(json.dumps({"services": {
        "main": {"image": image, "pull_policy": "never", "command": ["bash", "-lc", "sleep infinity"]},
        "simulator": {"image": image, "pull_policy": "never", "mem_limit": "256m", "cpus": 1,
            "command": ["bash", "-lc", "mkdir -p /evidence; printf '{\"score\":1}\\n' > /evidence/snapshot.json; sleep infinity"]},
    }}))
    (task / "tests" / "test.sh").write_text('''#!/bin/bash
set -euo pipefail
test "$(cat /evidence/snapshot.json)" = '{"score":1}'
sleep 1
printf '1\n' > /logs/verifier/reward.txt
''')
    return task


def config(root, task, root_id, number, source=None, fail=False):
    ownership = {"io.hitch.root-id": root_id, "io.hitch.provider": "local-docker",
        "io.hitch.eval-id": "eval_" + uuid.uuid4().hex, "io.hitch.work-id": "work_" + uuid.uuid4().hex,
        "io.hitch.lease-id": "lease_" + uuid.uuid4().hex, "io.hitch.lease-epoch": "1",
        "io.hitch.task-id": "phase-canary"}
    contract = {"schema_version": "1", "capability": "phase-exclusive-teardown-v1",
        "plan_digest": "sha256:" + hashlib.sha256(b"phase-canary-v1").hexdigest(),
        "task_id": "phase-canary", "attempt": 1, "verifier_mode": "separate",
        "agent_services": [{"name": "main", "replicas": 1}, {"name": "simulator", "replicas": 1}],
        "verifier_services": [{"name": "main", "replicas": 1}],
        "artifacts": [{"service": "simulator", "path": "/evidence/snapshot.json"}]}
    kwargs = {"hitch_ownership_labels": ownership, "hitch_phase_resource_contract": contract,
        "hitch_service_resource_limits": {"simulator": {"cpu_millis": 1000, "memory_bytes": 256 * 1024 * 1024}},
        "canary_fail_main_stop": fail}
    values = {"task": {"path": str(task)}, "trial_name": f"phase-canary-{number}-{root_id[:8]}",
        "trials_dir": str(root / "trials"), "agent": {"import_path": "harbor_phase_resources_docker_canary:CanaryAgent"},
        "environment": {"import_path": "harbor_phase_resources_docker_canary:CanaryEnvironment", "delete": False,
                        "override_cpus": 1, "override_memory_mb": 256, "kwargs": kwargs}}
    if source:
        receipt = source / "hitch-phase-resources-agent.json"
        kwargs["hitch_phase_verifier_source"] = {"schema_version": "1", "source_directory": str(source),
            "receipt_digest": "sha256:" + hashlib.sha256(receipt.read_bytes()).hexdigest()}
        values["source_trial"] = {"action": "regrade", "type": "local", "path": str(source)}
    return TrialConfig.model_validate(values)


async def monitor(root_id, stop, samples):
    while not stop.is_set():
        rows = (await docker("container", "ls", "--filter", f"label=io.hitch.root-id={root_id}",
            "--format", '{{.Label "io.hitch.lease-id"}}|{{.Label "com.docker.compose.project"}}')).splitlines()
        phases = {}
        for row in rows:
            lease, project = row.split("|", 1)
            phases.setdefault(lease, set()).add("verifier" if "__verifier__" in project else "agent")
        assert all(len(value) == 1 for value in phases.values()), f"phase overlap: {phases}"
        samples.append({"containers": len(rows), "leases": len(phases)})
        await asyncio.sleep(.1)


async def run_trial(settings):
    trial = await Trial.create(settings)
    result = await trial.run()
    return trial, result


def check_success(trial, result):
    assert result.exception_info is None, result.exception_info
    assert result.verifier_result.rewards == {"reward": 1.0}, result.verifier_result
    receipt = json.loads((trial.paths.trial_dir / "hitch-phase-resources-verifier.json").read_text())
    assert receipt["failure"] is None, receipt
    assert any(e["event"] == "environment.started" for e in receipt["events"]), receipt


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    # Validate locally available image and bash without pulling anything.
    await docker("image", "inspect", "--format", "{{.Id}}", args.image)
    await docker("run", "--rm", "--pull=never", "--network=none", "--memory=64m", args.image, "bash", "-lc", "true")
    root = Path(tempfile.mkdtemp(prefix="hitch-phase-docker-canary-")).resolve()
    root_id = uuid.uuid4().hex[:24]
    print(f"canary evidence: {root}", flush=True)
    task = make_task(root, args.image)
    stop, samples = asyncio.Event(), []
    watching = asyncio.create_task(monitor(root_id, stop, samples))
    try:
        pairs = await asyncio.gather(*(run_trial(config(root, task, root_id, n)) for n in (1, 2)))
        for trial, result in pairs:
            check_success(trial, result)
        assert max(s["leases"] for s in samples) >= 2, "concurrent trials were not observed"
        assert max(s["containers"] for s in samples) <= 4, "phase envelope exceeded"
        # Harbor delete=False still runs `compose down` (it preserves images
        # and volumes, not containers). Require confirmed cleanup before regrade.
        completed_ids = (await docker("container", "ls", "--all", "--filter", f"label=io.hitch.root-id={root_id}", "--format", "{{.ID}}")).split()
        assert not completed_ids, "native down did not remove completed trial containers"
        trial, result = await run_trial(config(root, task, root_id, 3, source=pairs[0][0].paths.trial_dir))
        check_success(trial, result)
        bad, bad_result = await run_trial(config(root, task, root_id, 4, fail=True))
        proof = json.loads((bad.paths.trial_dir / "hitch-phase-resources-agent.json").read_text())
        assert proof["failure"], "stop failure was not sticky"
        verifier_proof = bad.paths.trial_dir / "hitch-phase-resources-verifier.json"
        if verifier_proof.exists():
            assert not any(e["event"] == "environment.started" for e in json.loads(verifier_proof.read_text())["events"])
        assert bad_result.verifier_result is None or not bad_result.verifier_result.rewards
        assert not (bad.paths.trial_dir / "artifacts/evidence/snapshot.json").exists(), "unsafe snapshot copied"
        report = {"status": "passed", "concurrent_trials": 2, "peak_containers": max(s["containers"] for s in samples),
            "samples": len(samples), "fixed_snapshot_regrade": True, "stop_failure_blocks_verifier": True}
        (root / "canary-report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report), flush=True)
    finally:
        stop.set()
        await watching
        # Scoped cleanup only: no other Docker objects are affected.
        identities = (await docker("container", "ls", "--all", "--filter", f"label=io.hitch.root-id={root_id}", "--format", "{{.ID}}" )).split()
        if identities:
            await docker("container", "rm", "--force", *identities)
        networks = (await docker("network", "ls", "--filter", f"label=io.hitch.root-id={root_id}", "--format", "{{.ID}}")).split()
        if networks:
            await docker("network", "rm", *networks)
        volumes = (await docker("volume", "ls", "--filter", f"label=io.hitch.root-id={root_id}", "--format", "{{.Name}}")).split()
        if volumes:
            await docker("volume", "rm", *volumes)


if __name__ == "__main__":
    asyncio.run(main())
