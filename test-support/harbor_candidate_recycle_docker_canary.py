"""Real Docker canary for main-only recycling; not benchmark acceptance."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Invoke with the pinned Harbor 0.21.0 Python interpreter.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))

from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from hitch_harbor_environment import HitchHarborDockerEnvironment
from hitch_candidate_recycle import CandidateRecycler


async def main():
    image = subprocess.run(["docker", "image", "inspect", "node:22.23.0-bookworm-slim", "--format", "{{.Id}}"], check=True, capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="hitch-recycle-docker-") as temporary:
        root = Path(temporary).resolve()
        environment = root / "environment"
        trial = root / "trial"
        environment.mkdir()
        paths = TrialPaths(trial)
        paths.mkdir()
        compose = {"services": {"desktop": {"image": image, "command": ["node", "-e", "setInterval(()=>{},1000000)"], "init": True}}}
        (environment / "docker-compose.yaml").write_text(json.dumps(compose))
        labels = {"io.hitch.root-id": "a" * 24, "io.hitch.provider": "local-docker",
                  "io.hitch.eval-id": "eval_" + "b" * 32, "io.hitch.work-id": "work_" + "c" * 32,
                  "io.hitch.lease-id": "lease_" + "d" * 32, "io.hitch.lease-epoch": "1", "io.hitch.task-id": "canary"}
        session = "hitch-recycle-" + os.urandom(6).hex()
        env = HitchHarborDockerEnvironment(
            environment_dir=environment, environment_name="recycle-canary", session_id=session,
            trial_paths=paths, task_env_config=EnvironmentConfig(docker_image=image, cpus=1, memory_mb=128),
            mounts=[{"type": "bind", "source": str(paths.agent_dir), "target": "/logs/agent"},
                    {"type": "bind", "source": str(paths.verifier_dir), "target": "/logs/verifier"},
                    {"type": "bind", "source": str(paths.artifacts_dir), "target": "/logs/artifacts"}],
            hitch_ownership_labels=labels,
            hitch_service_resource_limits={"desktop": {"cpu_millis": 100, "memory_bytes": 67108864}},
        )
        try:
            await env.start(False)
            inventory = await CandidateRecycler(env)._containers()
            old_main, desktop = inventory["main"]["id"], inventory["desktop"]["id"]
            (paths.agent_dir / "phase-secret.txt").write_text("old phase")
            child = await env.exec("touch /tmp/candidate-memory; nohup sh -c 'while true; do echo tick; sleep 0.1; done' >/logs/agent/background.log 2>&1 </dev/null &")
            assert child.return_code == 0
            # The live child writes across the retirement boundary unless its
            # container/process tree was really removed.
            await asyncio.sleep(0.3)
            first = await env.recycle_candidate_phase(1)
            after = await env._hitch_candidate_recycler._containers()
            assert first["old_container_id"] == old_main and first["new_container_id"] == after["main"]["id"]
            assert after["desktop"]["id"] == desktop
            assert subprocess.run(["docker", "inspect", old_main], capture_output=True).returncode != 0
            invisible = await env.exec("test ! -e /logs/agent/phase-secret.txt && test ! -e /tmp/candidate-memory")
            assert invisible.return_code == 0
            assert (trial / "hitch-candidate-phases/phase-0001/agent/phase-secret.txt").read_text() == "old phase"
            background = trial / "hitch-candidate-phases/phase-0001/agent/background.log"
            old_bytes = background.read_bytes()
            assert old_bytes
            await asyncio.sleep(0.3)
            assert background.read_bytes() == old_bytes
            second_old = after["main"]["id"]
            second = await env.recycle_candidate_phase(2)
            final = await env._hitch_candidate_recycler._containers()
            assert second["old_container_id"] == second_old and second["new_container_id"] == final["main"]["id"]
            assert final["desktop"]["id"] == desktop and len({old_main, second_old, final["main"]["id"]}) == 3
            report = {"schema_version": "hitch-candidate-recycle-canary@1", "phases": 2,
                      "old_containers_removed": True, "old_logs_invisible": True, "old_writable_layer_absent": True,
                      "background_writer_stopped": True, "sidecar_preserved": True,
                      "receipts": [first, second], "scope": "synthetic-environment-only"}
        finally:
            await env.stop(False)
        remaining = subprocess.run(["docker", "ps", "--all", "--quiet", "--filter", f"label=com.docker.compose.project={session}"], check=True, capture_output=True, text=True).stdout.strip()
        assert not remaining
        report["cleanup_remaining_containers"] = 0
        print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
