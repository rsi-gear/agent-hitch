"""Run the official verifier unchanged and redact independent judge credentials."""
import argparse
from contextlib import redirect_stderr, redirect_stdout
import json
import os
from pathlib import Path
import sys
import tempfile


def publish_logs(logs, destination, secrets):
    # Upstream diagnostics stay private until exact-value redaction is complete.
    # A killed verifier cannot expose a partially written raw provider exception.
    for file in logs.rglob("*"):
        if file.is_file() and not file.is_symlink():
            data = file.read_bytes()
            for value in sorted(set(secrets), key=len, reverse=True):
                if value: data = data.replace(value.encode(), b"[REDACTED]")
            target = destination / file.relative_to(logs)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)


def run(tests, output, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for stale in ["reward.json", "judge-provenance.json"]: (destination / stale).unlink(missing_ok=True)
    secrets = [v for k, v in os.environ.items() if v and any(s in k.upper() for s in ("API_KEY", "TOKEN", "SECRET", "PASSWORD"))]
    with tempfile.TemporaryDirectory(prefix="jobbench-private-diagnostics-") as private_logs:
        logs = Path(private_logs)
        status = 1
        try:
            sys.path.insert(0, str(tests))
            import verify
            judge_path = tests / "judge.py"
            if (tests / "judge.json").exists():
                config = json.loads((tests / "judge.json").read_text())
                if config.get("profile") != "cliproxy-codex": raise ValueError("unsupported JobBench judge profile")
                from hitch_cliproxy import ResponsesClient
                client = ResponsesClient(config["base_url"], os.environ.get("JUDGE_API_KEY"), config["model"], config.get("allow_http", False))
                transport = {**client.provenance, "official_requested_controls": {"temperature": 0.0, "max_completion_tokens": 200000}}
                (logs / "judge-provenance.json").write_text(json.dumps({**config, "transport": transport}, indent=2) + "\n")
                judge_path = tests / "hitch_judge.py"
            with (logs / "verifier-output.log").open("w", encoding="utf-8") as stream, redirect_stdout(stream), redirect_stderr(stream):
                reward = verify.verify(output_dir=output, rubrics_file=tests / "RUBRICS.json", judge_path=judge_path, logs_dir=logs)
            (logs / "verification.json").write_text(json.dumps({"status": "ok", **reward}) + "\n")
            status = 0
        except Exception as error:
            for name in ("reward.json", ".judge-reward.json"): (logs / name).unlink(missing_ok=True)
            (logs / "verification.json").write_text(json.dumps({"status": "error", "type": type(error).__name__, "message": str(error)}) + "\n")
        finally:
            publish_logs(logs, destination, secrets)

    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tests", type=Path, default=Path("/tests")); parser.add_argument("--output", type=Path, default=Path("/workspace/output"))
    parser.add_argument("--logs", type=Path, default=Path("/logs/verifier"))
    args = parser.parse_args(); sys.exit(run(args.tests, args.output, args.logs))
