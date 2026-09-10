"""Actual Linux CPU process checks; worker executable is a sleep fixture.

No SSH, Harbor task, Docker socket, native generation, or GPU is exercised.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--hitch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="hitch-peer-process-check-"))
    fixture = root / "fixture-worker"
    fixture.write_text("#!/bin/sh\nexec sleep 120\n")
    fixture.chmod(0o700)
    config = {"ssh_host": "fixture", "ssh_config": "/unused/ssh-config", "runs_directory": str(root / "runs"),
              "node": str(fixture), "hitch": str(args.hitch), "python": "/unused/python",
              "docker": "/unused/docker", "remote_port": 32991}
    peer = [args.node, str(args.hitch / "dist/scripts/canary-worker-peer.js")]
    cases = []

    def request(op, ident, expected=0, cfg=None, **extra):
        value = {"operation": op, "id": ident, "config": cfg or config, **extra}
        result = subprocess.run(peer, input=json.dumps(value), text=True, capture_output=True, timeout=15)
        assert (result.returncode == 0) == (expected == 0), (op, result.stdout, result.stderr)
        return json.loads(result.stdout) if expected == 0 else result.stderr

    new_id = lambda: "hitch-canary-" + uuid.uuid4().hex
    early = new_id()
    assert request("stop", early)["neverStarted"]
    request("prepare", early, expected=1, registration={"fixture": True}, credential={"token": "fixture"})
    request("run", early, expected=1)
    assert not (root / "runs" / early / "process.json").exists()
    cases.append("stop-before-prepare-and-run-prevents-launch")
    drift = {**config, "remote_port": config["remote_port"] + 1}
    assert "owner changed" in request("stop", early, expected=1, cfg=drift)
    cases.append("owner-configuration-drift-rejected")

    active = new_id()
    credential = {"token": uuid.uuid4().hex}
    request("prepare", active, registration={"fixture": True}, credential=credential)
    private = root / "runs" / active / "private/credential.json"
    assert private.stat().st_mode & 0o777 == 0o600
    assert json.loads(private.read_text()) == credential
    log_path = args.output / "owned-process.log"
    with log_path.open("w") as log:
        child = subprocess.Popen(peer, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, text=True)
        try:
            child.stdin.write(json.dumps({"operation": "run", "id": active, "config": config}))
            child.stdin.close()
            process_file = root / "runs" / active / "process.json"
            deadline = time.monotonic() + 5
            while not process_file.exists() and time.monotonic() < deadline:
                assert child.poll() is None, "peer exited before recording its fixture worker"
                time.sleep(0.02)
            observed = json.loads(process_file.read_text())
            os.kill(observed["pid"], 0)
            assert "launch twice" in request("run", active, expected=1)
            assert json.loads(process_file.read_text()) == observed
            assert request("stop", active)["workerProcessTerminal"]
            child.wait(timeout=10)
            assert request("stop", active)["workerProcessTerminal"]
            assert "stop preceded run" in request("run", active, expected=1)
            assert json.loads(process_file.read_text()) == observed
            cases.extend(["one-process-per-canary", "owned-process-stop", "repeated-stop-preserves-identity", "late-start-rejected"])
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
    assert credential["token"] not in log_path.read_text()
    cases.append("credential-is-private-and-absent-from-process-output")

    changed = new_id()
    request("prepare", changed, registration={"fixture": True}, credential={"token": "fixture"})
    unrelated = subprocess.Popen(["sleep", "120"], start_new_session=True)
    try:
        process_file = root / "runs" / changed / "process.json"
        process_file.write_text(json.dumps({"pid": unrelated.pid, "start": "0",
                                           "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}))
        assert "identity changed" in request("stop", changed, expected=1)
        assert unrelated.poll() is None
        cases.append("mismatched-start-identity-does-not-signal-unrelated-process")
    finally:
        os.killpg(unrelated.pid, signal.SIGTERM)
        unrelated.wait(timeout=5)

    record = {"kind": "actual-linux-canary-peer-cpu-process-check", "passed": True, "validated": False,
              "cases": cases, "scope": __doc__.strip(), "root": str(root)}
    (args.output / "peer-process-check.json").write_text(json.dumps(record, indent=2))
    print(json.dumps(record), flush=True)


if __name__ == "__main__":
    main()
