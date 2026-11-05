import csv
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load("kaggle_prepare", ROOT / "prepare.py")
verifier = load("kaggle_verify", ROOT / "runtime/verify.py")


def synthetic(directory):
    directory.mkdir()
    train = []
    for number in range(1, 81):
        train.append(dict(zip(prepare.TRAIN_COLUMNS, [str(number), str(number % 2), str(number % 3 + 1), f"Passenger, {number}", "female" if number % 2 else "male", "" if number % 7 == 0 else str(18 + number % 40), "0", "0", f"T{number}", "8.5", "", "S"])))
    test = [{**row, "PassengerId": str(index + 100)} for index, row in enumerate(train[:12])]
    for name, rows, columns in [("train.csv", train, prepare.TRAIN_COLUMNS), ("test.csv", test, prepare.FEATURES), ("gender_submission.csv", test, ["PassengerId", "Survived"])]:
        (directory / name).write_bytes(prepare.csv_bytes(rows, columns))


class KaggleContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        synthetic(self.source)
        self.result = prepare.prepare(self.source, self.root / "prepared", synthetic=True)

    def task_paths(self, partition="seed", identifier="titanic-dev-fold-0"):
        base = self.root / "prepared" / partition / identifier
        return base / "candidate", base / "verifier"

    def predict(self, private, output, *, flip=False, reverse=False):
        output.mkdir(exist_ok=True)
        plan = json.loads((private / "task.json").read_text())
        with (private / "expected.csv").open() as handle:
            expected = list(csv.DictReader(handle))
        predicted = [{"PassengerId": row["PassengerId"], "Survived": str(1 - int(row.get("Survived", "0"))) if flip else row.get("Survived", "0")} for row in expected]
        if reverse:
            predicted.reverse()
        raw = prepare.csv_bytes(predicted, ["PassengerId", "Survived"])
        (output / "predictions.csv").write_bytes(raw)
        receipt = {"protocol": "kaggle-pipeline-receipt@1", "status": "completed", "candidate_commit": "a" * 40,
                   "pipeline_digest": "sha256:" + "b" * 64, "task_digest": plan["task_digest"], "seed": plan["seed"],
                   "input_digests": plan["input_digests"], "exit_code": 0, "predictions_sha256": prepare.digest(raw)}
        (output / "receipt.json").write_text(json.dumps(receipt))
        return receipt

    def rehash_prediction(self, output):
        file = output / "receipt.json"
        receipt = json.loads(file.read_text())
        receipt["predictions_sha256"] = prepare.digest((output / "predictions.csv").read_bytes())
        file.write_text(json.dumps(receipt))

    def test_split_is_deterministic_and_every_role_gets_only_its_data(self):
        repeated = prepare.prepare(self.source, self.root / "repeat", synthetic=True)
        self.assertEqual(self.result, repeated)
        holdout = set(self.result["split"]["holdout_ids"])
        seen = set()
        for task in self.result["tasks"]:
            if task["partition"] != "seed":
                continue
            train_ids, predict_ids = set(task["train_ids"]), set(task["predict_ids"])
            self.assertFalse(train_ids & predict_ids)
            self.assertFalse(holdout & (train_ids | predict_ids))
            self.assertFalse(seen & predict_ids)
            seen.update(predict_ids)
            candidate, private = self.task_paths(identifier=task["task_id"])
            self.assertEqual(set(file.name for file in candidate.iterdir()), {"train.csv", "predict.csv", "task.json"})
            self.assertNotIn("Survived", (candidate / "predict.csv").read_text().splitlines()[0])
            self.assertTrue((private / "expected.csv").is_file())
        self.assertEqual(seen, set(self.result["split"]["development_ids"]))
        changed = prepare.prepare(self.source, self.root / "seed2", synthetic=True, seed=43)
        self.assertNotEqual(self.result["split"], changed["split"])

    def test_source_identity_changes_and_production_rejects_fixture(self):
        file = self.source / "train.csv"
        file.write_text(file.read_text().replace("Passenger, 1", "Changed, 1"))
        changed = prepare.prepare(self.source, self.root / "changed", synthetic=True)
        self.assertNotEqual(self.result["inputs"], changed["inputs"])
        with self.assertRaisesRegex(ValueError, "891"):
            prepare.prepare(self.source, self.root / "production")

    def test_valid_zero_and_id_alignment(self):
        _, private = self.task_paths()
        output = self.root / "output"
        self.predict(private, output, reverse=True)
        rewards, detail = verifier.score(private, output)
        self.assertEqual(rewards["accuracy"], 1)
        self.assertEqual(rewards["completed"], 1)
        self.predict(private, output, flip=True)
        rewards, detail = verifier.score(private, output)
        self.assertEqual(rewards["accuracy"], 0)
        self.assertEqual(rewards["valid_output"], 1)
        self.assertEqual(detail["status"], "completed")

    def test_prediction_failures_are_valid_task_zeros_not_fabricated_accuracy(self):
        _, private = self.task_paths()
        output = self.root / "output"
        self.predict(private, output)
        original = (output / "predictions.csv").read_text()
        lines = original.splitlines()
        cases = ["PassengerId,Survived,index\n1,0,0\n", "\n".join(lines[:-1]) + "\n",
                 "\n".join(lines + [lines[1]]) + "\n", original.replace(lines[1], "999999,0"),
                 original.replace(lines[1], lines[1].split(",")[0] + ",2")]
        for text in cases:
            with self.subTest(text=text[:50]):
                (output / "predictions.csv").write_text(text)
                self.rehash_prediction(output)
                rewards, detail = verifier.score(private, output)
                self.assertEqual(rewards, {"reward": 0, "total_score": 0, "valid_output": 0, "completed": 0})
                self.assertEqual(detail["status"], "invalid_prediction")

    def test_receipt_corruption_and_sealed_output_loss_are_infrastructure_errors(self):
        _, private = self.task_paths()
        output = self.root / "output"
        for change in [{"task_digest": "sha256:" + "f" * 64}, {"seed": 9}, {"input_digests": {}}, {"protocol": "forged"}, {"exit_code": 1}, {"predictions_sha256": "sha256:" + "c" * 64}]:
            receipt = self.predict(private, output)
            receipt.update(change)
            (output / "receipt.json").write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):
                verifier.score(private, output)
        self.predict(private, output)
        (output / "predictions.csv").unlink()
        with self.assertRaises(ValueError):
            verifier.score(private, output)
        (output / "predictions.csv").symlink_to(private / "expected.csv")
        with self.assertRaises(ValueError):
            verifier.score(private, output)
        (output / "receipt.json").unlink()
        with self.assertRaises(ValueError):
            verifier.score(private, output)

    def test_candidate_failure_and_no_call_remain_task_zeros(self):
        _, private = self.task_paths()
        output = self.root / "output"
        for code in (0, 1, 124, -9):
            receipt = self.predict(private, output)
            receipt.update({"status": "candidate_failed", "exit_code": code})
            (output / "receipt.json").write_text(json.dumps(receipt))
            rewards, _ = verifier.score(private, output)
            self.assertEqual(rewards["total_score"], 0)
            self.assertEqual(rewards["valid_output"], 0)
            self.assertNotIn("accuracy", rewards)
        (output / "receipt.json").unlink()
        (output / "predictions.csv").unlink()
        self.assertEqual(verifier.score(private, output)[0]["total_score"], 0)

    def test_supervisor_setup_failure_is_not_zero_and_clears_stale_rewards(self):
        _, private = self.task_paths()
        output = self.root / "output"
        self.predict(private, output)
        (output / "receipt.json").write_text(json.dumps({"protocol": "kaggle-pipeline-receipt@1", "status": "infrastructure_error", "error_code": "isolation_unavailable"}))
        with self.assertRaisesRegex(RuntimeError, "infrastructure_error"):
            verifier.score(private, output)
        result_dir = self.root / "result"
        result_dir.mkdir()
        (result_dir / "reward.json").write_text('{"total_score": 1}')
        process = subprocess.run([sys.executable, str(ROOT / "runtime/verify.py"), "--private", str(private), "--predictions", str(output), "--result", str(result_dir)], capture_output=True, text=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((result_dir / "reward.json").exists())
        (output / "receipt.json").write_text('{"protocol":')
        with self.assertRaises(ValueError):
            verifier.score(private, output)

    def test_corrupt_verifier_data_raises_infrastructure_error(self):
        _, private = self.task_paths()
        output = self.root / "output"
        self.predict(private, output)
        (private / "expected.csv").write_text("PassengerId,Survived\n1,2\n")
        with self.assertRaises(ValueError):
            verifier.score(private, output)

    def test_finalization_has_no_accuracy_and_cli_exits_zero_on_task_failure(self):
        _, private = self.task_paths("finalization", "titanic-finalize")
        self.assertEqual((private / "expected.csv").read_text().splitlines()[0], "PassengerId")
        output = self.root / "output"
        self.predict(private, output)
        self.assertEqual(verifier.score(private, output)[0], {"reward": 1, "total_score": 1, "valid_output": 1, "completed": 1})
        (output / "receipt.json").unlink()
        (output / "predictions.csv").unlink()
        result = subprocess.run([sys.executable, str(ROOT / "runtime/verify.py"), "--private", str(private), "--predictions", str(output), "--result", str(self.root / "result")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("accuracy", json.loads((self.root / "result/reward.json").read_text()))


if __name__ == "__main__":
    unittest.main()
