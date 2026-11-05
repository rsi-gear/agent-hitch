"""Emit synthetic scorer outputs for Hitch/Gear converter contract tests.

The values come from the real CSV verifier; no candidate/model execution is
implied. Every case retains the emitted reward.json and feedback.json.
"""
import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path

from test_kaggle import prepare, synthetic, ROOT


def emit(root):
    root.mkdir(parents=True, exist_ok=True)
    source = root / "source"
    synthetic(source)
    prepare.prepare(source, root / "prepared", synthetic=True)
    cases = []
    for name in ("half_correct", "valid_zero", "candidate_failed", "invalid_prediction", "finalization"):
        final = name == "finalization"
        private = root / "prepared" / ("finalization/titanic-finalize" if final else "seed/titanic-dev-fold-0") / "verifier"
        with (private / "expected.csv").open() as handle:
            expected = list(csv.DictReader(handle))
        predictions = []
        for index, row in enumerate(expected):
            value = int(row.get("Survived", "0"))
            if name == "valid_zero" or (name == "half_correct" and index % 2):
                value = 1 - value
            predictions.append({"PassengerId": row["PassengerId"], "Survived": str(value)})
        if name == "invalid_prediction":
            predictions.pop()
        output = root / name / "output"
        output.mkdir(parents=True)
        raw = prepare.csv_bytes(predictions, ["PassengerId", "Survived"])
        (output / "predictions.csv").write_bytes(raw)
        plan = json.loads((private / "task.json").read_text())
        receipt = {"protocol": "kaggle-pipeline-receipt@1", "status": "completed", "candidate_commit": "a" * 40,
                   "pipeline_digest": "sha256:" + "b" * 64, "task_digest": plan["task_digest"], "seed": plan["seed"],
                   "input_digests": plan["input_digests"], "exit_code": 0, "predictions_sha256": prepare.digest(raw)}
        if name == "candidate_failed":
            receipt.update({"status": "candidate_failed", "exit_code": 124})
            receipt.pop("predictions_sha256")
            (output / "predictions.csv").unlink()
        (output / "receipt.json").write_text(json.dumps(receipt))
        result_dir = root / name / "verifier"
        subprocess.run([sys.executable, str(ROOT / "runtime/verify.py"), "--private", str(private), "--predictions", str(output), "--result", str(result_dir)], check=True, capture_output=True)
        cases.append({"name": name, "trialDirectory": str(root / name), "rewards": json.loads((result_dir / "reward.json").read_text())})
    return {"schema_version": "1", "synthetic": True, "cases": cases}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    print(json.dumps(emit(parser.parse_args().out.resolve())))
