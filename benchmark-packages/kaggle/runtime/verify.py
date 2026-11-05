"""Fixed, CSV-only scorer. Candidate code and models are never imported."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
SHA = re.compile(r"^sha256:[a-f0-9]{64}$")


class InvalidPrediction(ValueError):
    pass


def bounded(file, *, candidate=False):
    error = InvalidPrediction if candidate else ValueError
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_BYTES:
        raise error(f"missing, unsafe, or oversized file: {file.name}")
    return file.read_bytes()


def rows(data, columns, *, candidate=False):
    error = InvalidPrediction if candidate else ValueError
    try:
        reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""))
        if reader.fieldnames != columns:
            raise error("unexpected prediction columns")
        result = {}
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise error("malformed CSV row")
            identifier = row["PassengerId"]
            if not identifier or identifier in result:
                raise error("empty or duplicate PassengerId")
            if "Survived" in columns and row["Survived"] not in {"0", "1"}:
                raise error("Survived must be 0 or 1")
            result[identifier] = row
        if not result:
            raise error("empty CSV")
        return result
    except (UnicodeError, csv.Error) as exc:
        raise error("invalid CSV encoding or syntax") from exc


def score(private, output):
    # Invalid verifier inputs are infrastructure errors. Never turn them into a task zero.
    plan = json.loads(bounded(private / "task.json"))
    expected_digest = "sha256:" + hashlib.sha256(json.dumps({k: v for k, v in plan.items() if k != "task_digest"}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if plan.get("protocol") != "kaggle-task@1" or plan.get("task_digest") != expected_digest or plan.get("mode") not in {"validation", "finalization"}:
        raise ValueError("corrupt verifier task plan")
    labeled = plan["mode"] == "validation"
    expected = rows(bounded(private / "expected.csv"), ["PassengerId", "Survived"] if labeled else ["PassengerId"])
    try:
        receipt_file = output / "receipt.json"
        # No tool call can legitimately leave no receipt. Once present, however,
        # the root-owned receipt is execution infrastructure, not candidate data.
        if not receipt_file.exists() and not receipt_file.is_symlink():
            if (output / "predictions.csv").exists() or (output / "predictions.csv").is_symlink():
                raise ValueError("sealed predictions have lost their execution receipt")
            raise InvalidPrediction("pipeline was not executed: no execution receipt")
        receipt = json.loads(bounded(receipt_file))
        if not isinstance(receipt, dict) or receipt.get("protocol") != "kaggle-pipeline-receipt@1":
            raise ValueError("invalid trusted execution receipt protocol")
        if receipt.get("status") == "infrastructure_error":
            # Setup can fail before task or harness identity is readable. The
            # protected status is sufficient to prohibit a fabricated task zero.
            raise RuntimeError("trusted pipeline supervisor reported infrastructure_error")
        if receipt.get("task_digest") != plan["task_digest"] or receipt.get("seed") != plan["seed"] or receipt.get("input_digests") != plan["input_digests"]:
            raise ValueError("trusted execution receipt does not match task")
        if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", str(receipt.get("candidate_commit", ""))) or not SHA.fullmatch(str(receipt.get("pipeline_digest", ""))):
            raise ValueError("trusted execution receipt lacks source identity")
        if receipt.get("status") not in {"candidate_failed", "completed"} or type(receipt.get("exit_code")) is not int:
            raise ValueError("invalid trusted execution status")
        if receipt["status"] == "candidate_failed":
            raise InvalidPrediction("candidate execution did not complete")
        if receipt["exit_code"] != 0:
            raise ValueError("completed receipt has a nonzero exit status")
        # A completed receipt certifies that the supervisor sealed this file.
        # Its loss or replacement is an infrastructure error, not bad modeling.
        raw = bounded(output / "predictions.csv")
        if receipt.get("predictions_sha256") != "sha256:" + hashlib.sha256(raw).hexdigest():
            raise ValueError("prediction digest differs from trusted execution receipt")
        predicted = rows(raw, ["PassengerId", "Survived"], candidate=True)
        if predicted.keys() != expected.keys():
            raise InvalidPrediction("prediction IDs differ from task")
        accuracy = sum(predicted[key]["Survived"] == expected[key]["Survived"] for key in expected) / len(expected) if labeled else None
        value = accuracy if labeled else 1
        rewards = {"reward": value, "total_score": value, "valid_output": 1, "completed": 1}
        if labeled:
            rewards["accuracy"] = accuracy
        return rewards, {"status": "completed", "rows": len(predicted), "mode": plan["mode"]}
    except InvalidPrediction as exc:
        return {"reward": 0, "total_score": 0, "valid_output": 0, "completed": 0}, {"status": "invalid_prediction", "message": str(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private", type=Path, default=Path("/tests/private"))
    parser.add_argument("--predictions", type=Path, default=Path("/output"))
    parser.add_argument("--result", type=Path, default=Path("/logs/verifier"))
    args = parser.parse_args()
    args.result.mkdir(parents=True, exist_ok=True)
    # A failed verifier retry must not leave a previous successful reward behind.
    for name in ("reward.json", "feedback.json"):
        (args.result / name).unlink(missing_ok=True)
    rewards, detail = score(args.private, args.predictions)
    (args.result / "reward.json").write_text(json.dumps(rewards) + "\n")
    # This diagnostic contains no passenger labels or row-level outcomes.
    feedback = {"schema_version": "1", "items": []}
    if detail["status"] != "completed":
        feedback["items"].append({"code": "invalid_prediction", "severity": "error", "message": detail["message"]})
    (args.result / "feedback.json").write_text(json.dumps(feedback) + "\n")
    print(json.dumps(detail))


if __name__ == "__main__":
    main()
