"""Public transport boundaries: isolation, malformed mounts and legacy setup."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
import hitch_shared_runtime as shared


class SharedMountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "controller/payload").mkdir(parents=True)
        (self.root / "artifact").mkdir()
        self.raw = {"runtime_directory": str(self.root / "controller"), "artifact_directory": str(self.root / "artifact")}
        self.sources = shared.configure(self.raw, "arbitrary-task__env")
        self.inspected = {"privileged": False, "cap_add": None, "mounts": [
            {"Type": "bind", "Source": source, "Destination": target, "RW": False}
            for target, source in self.sources.items()
        ]}

    def test_candidate_only(self):
        self.assertIsNone(shared.configure(None, "anything"))
        for session in ["task__verifier__trial", "task__verifier__env", "truncated__verifier__01234567", "unknown"]:
            self.assertIsNone(shared.configure(self.raw, session))
        shared.validate_mounts(self.inspected, self.sources)
        for mount in shared.compose_mounts(self.sources):
            self.assertTrue(mount["read_only"])
            self.assertFalse(mount["bind"]["create_host_path"])

    def test_roles_are_bound_to_trial_identity(self):
        for trial in ("short", "task-" + "a" * 80, "task__verifier__name"):
            self.assertEqual(shared.configure(self.raw, trial + "__env", trial), self.sources)
            for session in (trial + "__verifier__env", trial[:53] + "__12345678", "other__env"):
                self.assertIsNone(shared.configure(self.raw, session, trial))

    def test_reject_rw_wrong_missing_and_nested_mounts(self):
        for mutation in [
            lambda x: x["mounts"][0].update(RW=True),
            lambda x: x["mounts"][0].update(Source="/other"),
            lambda x: x["mounts"].pop(),
            lambda x: x["mounts"].append({"Destination": "/opt/hitch-harness-artifact/entry.js"}),
            lambda x: x.update(privileged=True),
            lambda x: x.update(cap_add=["SYS_ADMIN"]),
            lambda x: x.update(cap_add=["CAP_SYS_ADMIN"]),
        ]:
            broken = copy.deepcopy(self.inspected); mutation(broken)
            with self.assertRaises(RuntimeError):
                shared.validate_mounts(broken, self.sources)

    def test_conflicting_compose_mounts_and_privilege(self):
        for config in [
            {"volumes": ["/host:/opt/hitch:rw"]},
            {"volumes": [{"source": "x", "target": "/opt/hitch-harness-artifact/node_modules"}]},
            {"privileged": True}, {"cap_add": ["SYS_ADMIN"]}, {"cap_add": ["CAP_SYS_ADMIN"]},
        ]:
            with self.assertRaises(ValueError):
                shared.reject_conflicts(config)
        shared.reject_conflicts({"volumes": ["/host:/workspace:rw"], "cap_add": ["NET_ADMIN"]})

    def test_missing_and_symlink_sources_do_not_become_empty_mounts(self):
        broken = {**self.raw, "artifact_directory": str(self.root / "missing")}
        with self.assertRaises(ValueError):shared.configure(broken, "task__env")
        (self.root / "link").symlink_to(self.root / "artifact")
        with self.assertRaises(ValueError):shared.configure({**self.raw, "artifact_directory": str(self.root / "link")}, "task__env")
        with self.assertRaises(ValueError):shared.configure({**self.raw, "extra": "unexpected"}, "task__env")


if __name__ == "__main__":
    unittest.main()
