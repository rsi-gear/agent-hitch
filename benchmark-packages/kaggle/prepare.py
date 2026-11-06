"""Offline, deterministic Titanic data preparation. No ML dependencies required."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

FEATURES = ["PassengerId", "Pclass", "Name", "Sex", "Age", "SibSp", "Parch", "Ticket", "Fare", "Cabin", "Embarked"]
TRAIN_COLUMNS = ["PassengerId", "Survived", *FEATURES[1:]]
FILES = ["train.csv", "test.csv", "gender_submission.csv"]
MAX_FILE_BYTES = 16 * 1024 * 1024


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def read_csv(file, columns):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"expected bounded regular input file: {file.name}")
    data = file.read_bytes()
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""))
    if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)) or set(reader.fieldnames) != set(columns):
        raise ValueError(f"unexpected columns in {file.name}")
    rows = list(reader)
    if not rows or any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError(f"empty or malformed CSV: {file.name}")
    ids = [row["PassengerId"] for row in rows]
    if any(not identifier.isascii() or not identifier.isdecimal() or str(int(identifier)) != identifier or int(identifier) <= 0 for identifier in ids) or len(ids) != len(set(ids)):
        raise ValueError(f"invalid or duplicate PassengerId in {file.name}")
    if "Survived" in columns and any(row["Survived"] not in {"0", "1"} for row in rows):
        raise ValueError(f"non-binary Survived in {file.name}")
    return sorted(rows, key=lambda row: int(row["PassengerId"])), digest(data)


def csv_bytes(rows, columns):
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue().encode()


def partition(rows, seed, folds, fraction):
    if not 2 <= folds <= 10 or not 0 < fraction < 0.5:
        raise ValueError("folds must be 2..10 and holdout fraction must be between 0 and 0.5")
    development, holdout, buckets = [], [], [[] for _ in range(folds)]
    for label in ("0", "1"):
        group = [row for row in rows if row["Survived"] == label]
        order = lambda row: hashlib.sha256(f"{seed}:holdout:{row['PassengerId']}".encode()).digest()
        group.sort(key=order)
        n_holdout = max(1, int(len(group) * fraction + 0.5))
        if len(group) - n_holdout < folds:
            raise ValueError("each label needs enough examples for holdout and every fold")
        holdout.extend(group[:n_holdout])
        remaining = group[n_holdout:]
        development.extend(remaining)
        remaining.sort(key=lambda row: hashlib.sha256(f"{seed}:fold:{row['PassengerId']}".encode()).digest())
        for index, row in enumerate(remaining):
            buckets[index % folds].append(row)
    sort_rows = lambda values: sorted(values, key=lambda row: int(row["PassengerId"]))
    return sort_rows(development), sort_rows(holdout), [sort_rows(bucket) for bucket in buckets]


def prepare(source, output, *, seed=42, folds=5, fraction=0.2, timeout=300, synthetic=False):
    train, train_hash = read_csv(source / FILES[0], TRAIN_COLUMNS)
    test, test_hash = read_csv(source / FILES[1], FEATURES)
    sample, sample_hash = read_csv(source / FILES[2], ["PassengerId", "Survived"])
    if set(row["PassengerId"] for row in train) & set(row["PassengerId"] for row in test):
        raise ValueError("training and competition test IDs overlap")
    if [row["PassengerId"] for row in sample] != [row["PassengerId"] for row in test]:
        raise ValueError("sample submission IDs do not match test.csv")
    if not synthetic and (len(train) != 891 or len(test) != 418):
        raise ValueError("Titanic requires 891 train and 418 test rows; use --synthetic only for contract fixtures")
    if not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1 or not isinstance(timeout, int) or not 1 <= timeout <= 3600:
        raise ValueError("invalid seed or timeout")
    development, holdout, buckets = partition(train, seed, folds, fraction)
    output.mkdir()
    tasks = []

    def task(partition_name, identifier, training, prediction, mode):
        directory = output / partition_name / identifier
        data, private = directory / "candidate", directory / "verifier"
        data.mkdir(parents=True)
        private.mkdir()
        train_data, prediction_data = csv_bytes(training, TRAIN_COLUMNS), csv_bytes(prediction, FEATURES)
        plan = {"protocol": "kaggle-task@1", "task_id": identifier, "mode": mode,
                "seed": seed, "timeout_sec": timeout,
                "input_digests": {"train": digest(train_data), "predict": digest(prediction_data)}}
        plan["task_digest"] = digest(canonical(plan))
        (data / "train.csv").write_bytes(train_data)
        (data / "predict.csv").write_bytes(prediction_data)
        (data / "task.json").write_bytes(canonical(plan) + b"\n")
        (private / "task.json").write_bytes(canonical(plan) + b"\n")
        # Finalization references only IDs; sample predictions are never ground truth.
        expected_columns = ["PassengerId"] if mode == "finalization" else ["PassengerId", "Survived"]
        (private / "expected.csv").write_bytes(csv_bytes(prediction, expected_columns))
        tasks.append({"task_id": identifier, "partition": partition_name, "plan": plan,
                      "train_ids": [row["PassengerId"] for row in training],
                      "predict_ids": [row["PassengerId"] for row in prediction]})

    for index, validation in enumerate(buckets):
        excluded = {row["PassengerId"] for row in validation}
        task("seed", f"titanic-dev-fold-{index}", [row for row in development if row["PassengerId"] not in excluded], validation, "validation")
    task("held-out", "titanic-promotion-holdout", development, holdout, "validation")
    task("finalization", "titanic-finalize", train, test, "finalization")
    result = {"schema_version": "1", "protocol": "kaggle-competition@1",
              "competition": "titanic-synthetic" if synthetic else "titanic", "synthetic": synthetic,
              "id_column": "PassengerId", "target_column": "Survived", "prediction_type": "binary-label",
              "metric": "accuracy", "direction": "maximize", "allowed_labels": [0, 1],
              "inputs": {FILES[0]: train_hash, FILES[1]: test_hash, FILES[2]: sample_hash},
              "row_counts": {"train": len(train), "test": len(test)},
              "submission": {"id_column": "PassengerId", "target_column": "Survived", "allowed_labels": [0, 1],
                             "expected_ids": [row["PassengerId"] for row in test], "rows": len(test)},
              "split": {"seed": seed, "folds": folds, "holdout_fraction": fraction,
                        "development_ids": [row["PassengerId"] for row in development],
                        "holdout_ids": [row["PassengerId"] for row in holdout]},
              "tasks": tasks}
    (output / "prepared.json").write_bytes(canonical(result) + b"\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--holdout-fraction", type=float, default=0.2)
    parser.add_argument("--timeout-sec", type=int, default=300)
    parser.add_argument("--synthetic", action="store_true")
    args = parser.parse_args()
    prepared = prepare(args.source, args.out, seed=args.seed, folds=args.folds, fraction=args.holdout_fraction, timeout=args.timeout_sec, synthetic=args.synthetic)
    print(json.dumps({"prepared": str(args.out / "prepared.json"), "tasks": len(prepared["tasks"])}))
