import importlib.util
import marshal
import os
from pathlib import Path
import py_compile
import sys
import sysconfig
import tempfile
import unittest
import zipfile
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "integrations/harbor/hitch_python_runtime.py"
spec = importlib.util.spec_from_file_location("runtime_inventory", MODULE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
sysconfig.get_config_vars()


class RuntimeInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.launcher = self.root / "harbor"
        self.launcher.write_text("#!/python\n# fixed launcher, fixed version\n")
        self.source = self.root / "dependency.py"
        self.source.write_text("VALUE = 1\n")
        self.original_path = sys.path
        sys.path = [str(self.root)]
        self.addCleanup(setattr, sys, "path", self.original_path)
        original_cache_prefix = sys.pycache_prefix
        sys.pycache_prefix = None
        self.addCleanup(setattr, sys, "pycache_prefix", original_cache_prefix)

    def observe(self):
        return runtime.inventory(self.launcher)

    def test_same_version_package_bytes_change_identity(self):
        first = self.observe()
        self.assertEqual(first, self.observe())
        self.source.write_text("VALUE = 2\n")
        self.assertNotEqual(first["integrity"], self.observe()["integrity"])
        self.assertEqual(first["python_version"], self.observe()["python_version"])

    def test_generated_caches_preserve_identity(self):
        first = self.observe()
        for optimize in (0, 1, 2):
            py_compile.compile(str(self.source), doraise=True, optimize=optimize)
            self.assertEqual(first, self.observe())

    def test_verified_content_skips_compilation_but_rechecks_all_bytes(self):
        cache = Path(py_compile.compile(str(self.source), doraise=True))
        first = runtime.inventory(self.launcher, receipt=True)
        with patch.object(runtime, "compiled_constants_equal", side_effect=AssertionError("compiled again")):
            second = runtime.inventory(self.launcher, [first["proof"]], receipt=True)
        self.assertEqual(first, second)
        previous = self.source.stat()
        self.source.write_text("VALUE = 2\n")
        os.utime(self.source, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        with self.assertRaisesRegex(ValueError, "disagrees"):
            runtime.inventory(self.launcher, [first["proof"]])
        self.source.write_text("VALUE = 1\n")
        data = cache.read_bytes()
        cache.write_bytes(data[:16] + marshal.dumps(compile("VALUE = 3\n", str(self.source), "exec")))
        with self.assertRaisesRegex(ValueError, "disagrees"):
            runtime.inventory(self.launcher, [first["proof"]])

    def test_memo_covers_interpreter_dependencies_and_cache_additions(self):
        py_compile.compile(str(self.source), doraise=True)
        first = runtime.inventory(self.launcher, receipt=True)
        original = runtime.compiled_constants_equal
        for change in (
            lambda: self.launcher.write_text("#!/python\n# another launcher\n"),
            lambda: (self.root / "new-dependency.py").write_text("VALUE = 1\n"),
            lambda: py_compile.compile(str(self.source), doraise=True, optimize=1),
        ):
            change()
            with patch.object(runtime, "compiled_constants_equal", wraps=original) as compare:
                second = runtime.inventory(self.launcher, [first["proof"]], receipt=True)
            self.assertTrue(compare.called)
            self.assertNotEqual(first["proof"], second["proof"])
            first = second

    def test_memo_hit_preserves_bounds_and_detects_mid_inventory_changes(self):
        py_compile.compile(str(self.source), doraise=True)
        first = runtime.inventory(self.launcher, receipt=True)
        with patch.dict(os.environ, {runtime.LIMIT_ENV_PREFIX + "MAX_BYTES": "1"}):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                runtime.inventory(self.launcher, [first["proof"]])
        original = runtime.json.dumps
        def mutate(*args, **kwargs):
            self.source.write_text("VALUE = 2\n")
            return original(*args, **kwargs)
        with patch.object(runtime.json, "dumps", mutate):
            with self.assertRaisesRegex(ValueError, "changed"):
                runtime.inventory(self.launcher, [first["proof"]])

    def test_cold_bytecode_verification_charges_rereads_to_the_byte_budget(self):
        py_compile.compile(str(self.source), doraise=True)
        total = 0
        original = Path.read_bytes
        def counted(file):
            nonlocal total
            data = original(file)
            total += len(data)
            return data
        with patch.object(Path, "read_bytes", counted):
            self.observe()
        with patch.dict(os.environ, {runtime.LIMIT_ENV_PREFIX + "MAX_BYTES": str(total - 1)}):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                self.observe()

    def test_bytecode_rereads_do_not_hide_permission_drift(self):
        py_compile.compile(str(self.source), doraise=True)
        original = runtime.json.dumps
        def mutate(*args, **kwargs):
            self.source.chmod(0o755)
            return original(*args, **kwargs)
        with patch.object(runtime.json, "dumps", mutate):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.observe()

    def test_nan_constants_in_valid_generated_caches_preserve_identity(self):
        self.source.write_text(
            "VALUE = 1e1000 - 1e1000\n"
            "NESTED = ((1e1000 - 1e1000,),)\n"
            "def nested():\n"
            "    return 1e1000j - 1e1000j\n"
            "def membership(value):\n"
            "    return value in {1e1000 - 1e1000, 1e1000 - 1e1000}\n"
        )
        first = self.observe()
        for optimize in (0, 1, 2):
            py_compile.compile(str(self.source), doraise=True, optimize=optimize)
            self.assertEqual(first, self.observe())

    def test_nan_frozenset_comparison_preserves_multiplicity(self):
        one = frozenset([float("nan")])
        two = frozenset([float("nan"), float("nan")])
        self.assertNotEqual(runtime.constant_key(one), runtime.constant_key(two))
        self.assertEqual(runtime.constant_key(two), runtime.constant_key(marshal.loads(marshal.dumps(two))))

    def test_changed_float_sign_in_bytecode_is_rejected(self):
        self.source.write_text("VALUE = 0.0\n")
        cache = Path(py_compile.compile(str(self.source), doraise=True))
        data = cache.read_bytes()
        code = marshal.loads(data[16:])
        changed = code.replace(co_consts=tuple(
            -0.0 if isinstance(value, float) else value for value in code.co_consts
        ))
        cache.write_bytes(data[:16] + marshal.dumps(changed))
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.observe()

    def test_nan_alias_tampering_changes_membership_and_is_rejected(self):
        self.source.write_text("RESULT = (1e1000 - 1e1000) in {1e1000 - 1e1000}\n")
        cache = Path(py_compile.compile(str(self.source), doraise=True))
        data = cache.read_bytes()
        code = marshal.loads(data[16:])
        scalar = next(value for value in code.co_consts if isinstance(value, float) and value != value)
        changed = code.replace(co_consts=tuple(
            frozenset([scalar]) if isinstance(value, frozenset) else value
            for value in code.co_consts
        ))
        encoded = marshal.dumps(changed)
        changed = marshal.loads(encoded)
        before, after = {}, {}
        exec(code, before)
        exec(changed, after)
        self.assertIs(before["RESULT"], False)
        self.assertIs(after["RESULT"], True)
        self.assertEqual(runtime.constant_key(code), runtime.constant_key(changed))
        cache.write_bytes(data[:16] + encoded)
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.observe()

    def test_nan_alias_graph_is_unordered_but_preserves_cross_container_references(self):
        for factory in (lambda: float("nan"), lambda: complex(float("nan"), 1)):
            a, b, c, d = (factory() for _ in range(4))
            left = (frozenset([(a,), (b,)]), (a, b, a))
            right = (frozenset([(c,), (d,)]), (d, c, d))
            self.assertTrue(runtime.compiled_constants_equal(left, right))
            if isinstance(a, float):
                self.assertTrue(runtime.compiled_constants_equal(left, marshal.loads(marshal.dumps(left))))
            # Same NaN bits and occurrence counts, different ordered aliases.
            changed = (right[0], (d, c, c))
            self.assertFalse(runtime.compiled_constants_equal(left, changed))
            self.assertFalse(runtime.compiled_constants_equal(changed, left))

    def test_wide_constants_do_not_need_recursive_or_permutation_enumeration(self):
        values = tuple(float("nan") for _ in range(2000))
        wide = (frozenset(values),)
        self.assertTrue(runtime.compiled_constants_equal(wide, marshal.loads(marshal.dumps(wide))))
        repeated = (values[0],) * 2000
        self.assertTrue(runtime.compiled_constants_equal(repeated, marshal.loads(marshal.dumps(repeated))))
        anchored = (frozenset(values), values)
        self.assertTrue(runtime.compiled_constants_equal(anchored, marshal.loads(marshal.dumps(anchored))))

    def test_bytecode_which_disagrees_with_source_is_rejected(self):
        cache = Path(py_compile.compile(str(self.source), doraise=True))
        header = cache.read_bytes()[:16]
        cache.write_bytes(header + marshal.dumps(compile("VALUE = 99\n", str(self.source), "exec")))
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.observe()

    def test_added_and_removed_files_change_identity(self):
        first = self.observe()
        added = self.root / "new_module.py"
        added.write_text("VALUE = 1\n")
        self.assertNotEqual(first["integrity"], self.observe()["integrity"])
        added.unlink()
        self.assertEqual(first, self.observe())

    def test_symlink_dependency_content_changes_identity(self):
        with tempfile.TemporaryDirectory() as outside:
            file = Path(outside) / "module.py"
            file.write_text("VALUE = 1\n")
            (self.root / "linked.py").symlink_to(file)
            first = self.observe()
            file.write_text("VALUE = 2\n")
            self.assertNotEqual(first["integrity"], self.observe()["integrity"])

    def test_relative_module_paths_are_rejected(self):
        sys.path.append("relative")
        with self.assertRaisesRegex(ValueError, "relative"):
            self.observe()

    def test_zip_subdirectory_contents_change_identity(self):
        with tempfile.TemporaryDirectory() as outside:
            archive = Path(outside) / "dependencies.zip"
            for value in (1, 2):
                with zipfile.ZipFile(archive, "w") as package:
                    package.writestr("vendor/example.py", f"VALUE = {value}\n")
                if value == 1:
                    sys.path.append(str(archive / "vendor"))
                    first = self.observe()
                else:
                    self.assertNotEqual(first["integrity"], self.observe()["integrity"])

    def test_external_cache_directory_is_rejected(self):
        sys.pycache_prefix = str(self.root / "outside-module-search-path")
        with self.assertRaisesRegex(ValueError, "external Python cache"):
            self.observe()

    def test_ignored_cache_entries_still_respect_inventory_limits(self):
        with patch.dict(os.environ, {"HITCH_HARBOR_PYTHON_RUNTIME_MAX_FILES": "1000"}):
            self.observe()
            caches = self.root / "__pycache__"
            caches.mkdir()
            for index in range(1001):
                (caches / f"orphan_{index}.{sys.implementation.cache_tag}.pyc").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "file limit"):
                self.observe()

    def test_inventory_limit_overrides_are_validated(self):
        for name in ("MAX_FILES", "MAX_BYTES"):
            for value in ("0", "-1", "1.5", "invalid", "9" * 30):
                with self.subTest(name=name, value=value):
                    with patch.dict(os.environ, {runtime.LIMIT_ENV_PREFIX + name: value}):
                        with self.assertRaisesRegex(ValueError, "invalid.*limit"):
                            self.observe()
        with patch.dict(os.environ, {runtime.LIMIT_ENV_PREFIX + "MAX_BYTES": "1"}):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                self.observe()

    def test_special_files_and_resource_limits_fail_closed(self):
        import os

        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.observe()
        fifo.unlink()
        original = runtime.MAX_FILES
        try:
            runtime.MAX_FILES = 1
            with self.assertRaisesRegex(ValueError, "limit"):
                self.observe()
        finally:
            runtime.MAX_FILES = original


if __name__ == "__main__":
    unittest.main()
