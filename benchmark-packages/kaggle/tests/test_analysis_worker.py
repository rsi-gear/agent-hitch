"""Exercise candidate-output classification without requiring Linux confinement."""
import csv
import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[3] / "integrations/sealed-python"
sys.path.insert(0, str(RUNTIME))
spec = importlib.util.spec_from_file_location("sealed_worker", RUNTIME / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.path.pop(0)


class AnalysisWorkerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.job = {
            "entrypoint": "solution.py", "trainingSeed": 42,
            "cpuSeconds": 60, "wallSeconds": 60,
            "outputDirectory": temporary.name,
        }
        self.train = b"id,target\n" + b"".join(
            f"{index},{index % 2}\n".encode() for index in range(10)
        )

    def evaluate(self, version, outputs=None):
        if version == 1:
            schema = {"kind": "binary-label", "idColumn": "id",
                      "targetColumn": "target", "allowedLabels": ["0", "1"]}
            plan = {"folds": [{
                "trainIds": [str(i) for i in range(10) if i // 2 != fold],
                "validationIds": [str(i) for i in range(10) if i // 2 == fold],
            } for fold in range(5)]}
        else:
            schema = {"kind": "tabular", "idColumn": "id", "targetColumns": ["target"],
                      "metric": "accuracy", "labels": ["0", "1"]}
            plan = {"trainDigest": "sha256:" + hashlib.sha256(self.train).hexdigest(),
                    "foldAssignments": [i // 2 for i in range(10)]}

        def candidate(_files, inputs, *_args):
            _, rows = worker.read_csv(inputs["predict.csv"])
            valid = b"id,target\n" + b"".join(
                f"{row['id']},{int(row['id']) % 2}\n".encode() for row in rows
            )
            return {"exitCode": 0, "limit": None, "cpuSeconds": 0.01, "logs": {},
                    "outputs": {"predictions.csv": valid} if outputs is None else outputs}

        with patch.object(worker, "run_python", side_effect=candidate):
            return worker.evaluate(self.job, {}, self.train, schema, plan)

    def test_valid_predictions_complete_every_fold(self):
        for version in (1, 2):
            with self.subTest(version=version):
                result = self.evaluate(version)
                self.assertEqual(result["status"], "completed")
                self.assertEqual(len(result["foldMetrics"]), 5)
                self.assertEqual(result["pooledAccuracy" if version == 1 else "pooledScore"], 1)

    def test_invalid_candidate_csv_is_a_recorded_failure(self):
        cases = [
            {},
            {"predictions.csv": b"\xff"},
            {"predictions.csv": b"id,target\n0,2\n1,1\n"},
            {"predictions.csv": b"id,target\n0," + b"0" * (csv.field_size_limit() + 1) + b"\n"},
        ]
        for version in (1, 2):
            for index, outputs in enumerate(cases):
                with self.subTest(version=version, case=index):
                    result = self.evaluate(version, outputs)
                    self.assertEqual(result["status"], "candidate_failed")
                    self.assertEqual(result["foldMetrics"], [])
                    self.assertIsNone(result["pooledAccuracy" if version == 1 else "pooledScore"])
                    self.assertIn("validationError", result["logs"][-1])
