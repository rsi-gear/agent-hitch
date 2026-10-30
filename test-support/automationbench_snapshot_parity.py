"""Opt-in offline parity check for a recorded AutomationBench snapshot.

Uses only an existing verifier image, with network disabled and the snapshot
mounted read-only. No agent or simulator is started and the source is untouched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import uuid


def sha256(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trial", type=Path, required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    source = args.trial.resolve()
    config = json.loads((source / "config.json").read_text())
    task = Path(config["task"]["path"])
    expected = json.loads((source / "verifier/reward.json").read_text())
    snapshot = source / "artifacts/evidence/snapshot.json"
    before = sha256(snapshot)
    image = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", args.image], text=True).strip()
    output = Path(tempfile.mkdtemp(prefix="hitch-automationbench-snapshot-parity-")).resolve()
    logs = output / "verifier"
    logs.mkdir()
    name = "hitch-snapshot-parity-" + uuid.uuid4().hex[:16]
    command = ["docker", "run", "--rm", "--pull=never", "--network=none", "--cpus=1", "--memory=2g",
        "--name", name, "--label", "io.hitch.test-purpose=fixed-snapshot-parity",
        "--mount", f"type=bind,source={snapshot},target=/evidence/snapshot.json,readonly",
        "--mount", f"type=bind,source={logs},target=/logs/verifier",
        image, "bash", "-c", "sha256sum /tests/test.sh /data/task.json /runtime/official.py; bash /tests/test.sh"]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=120)
        (output / "stdout.log").write_text(result.stdout)
        (output / "stderr.log").write_text(result.stderr)
        assert result.returncode == 0, f"verifier failed; inspect {output}"
    finally:
        subprocess.run(["docker", "container", "rm", "--force", name], capture_output=True)
    hashes = dict(line.split("  ", 1)[::-1] for line in result.stdout.splitlines() if "  /" in line)
    for source_path, image_path in [(task / "tests/test.sh", "/tests/test.sh"),
        (task / "tests/runtime/task.json", "/data/task.json"),
        (task / "tests/runtime/official.py", "/runtime/official.py")]:
        assert sha256(source_path) == "sha256:" + hashes[image_path], f"cached image differs from original task: {image_path}"
    observed = json.loads((logs / "reward.json").read_text())
    assert observed == expected, {"expected": expected, "observed": observed}
    assert sha256(snapshot) == before, "source snapshot changed"
    report = {"status": "passed", "source_trial": str(source), "task": str(task), "image_id": image,
        "snapshot_digest": before, "expected_reward": expected, "observed_reward": observed,
        "network": "none", "agent_started": False, "simulator_started": False,
        "verifier_matches_recorded_task": True, "source_snapshot_unchanged": True}
    (output / "parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"evidence": str(output), **report}, indent=2))


if __name__ == "__main__":
    main()
