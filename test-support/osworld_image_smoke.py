"""Source export and image integrity checks with a small synthetic Git tree."""
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'benchmark-packages/osworld/runtime'))
from image_entrypoint import verify_image
from runtime_config import SDK_COMMIT

spec = importlib.util.spec_from_file_location('prepare_controller', ROOT / 'benchmark-packages/osworld/prepare-controller.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='oswi-')
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self): self.temporary.cleanup()

    def test_export_uses_committed_blobs_and_never_copies_worktree_secrets(self):
        repo = self.root / 'sdk'; repo.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE).decode().strip()
        git('init')
        (repo / 'core.py').write_text('VALUE = 1\n')
        (repo / 'uv.lock').write_text('synthetic lock\n')
        git('add', 'core.py', 'uv.lock')
        git('-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'synthetic SDK source')
        commit, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
        (repo / 'core.py').write_text('uncommitted change\n')
        (repo / '.env').write_text('SECRET=never-export-this\n')
        patches = {'SDK_COMMIT': commit, 'SDK_TREE': tree, 'GITLINKS': {}, 'SDK_METADATA': {'uv.lock': hashlib.sha256(b'synthetic lock\n').hexdigest()}}
        with patch.multiple(builder, **patches):
            output = self.root / 'context'
            receipt = builder.prepare(repo, output)
            self.assertEqual(receipt['sdk_files'], 2)
            self.assertEqual((output / 'sdk/core.py').read_text(), 'VALUE = 1\n')
            self.assertFalse((output / 'sdk/.env').exists())
            self.assertFalse((output / 'sdk/.git').exists())
            manifest = json.loads((output / 'source-manifest.json').read_text())
            self.assertEqual(manifest['git_tree'], tree)
            self.assertTrue(any(f['path'] == 'image_entrypoint.py' for f in manifest['runtime_files']))
            with self.assertRaises(ValueError): builder.prepare(repo, output)
            with self.assertRaises(ValueError): builder.prepare(repo, repo / 'context')
            with patch.object(builder, 'SDK_TREE', '0' * 40):
                with self.assertRaises(ValueError): builder.prepare(repo, self.root / 'failed-context')
            self.assertFalse((self.root / 'failed-context').exists())
            self.assertFalse(list(self.root.glob('.controller-build-*')))

    def test_image_detects_changed_extra_linked_source_and_dependency_versions(self):
        root = self.root / 'image'; root.mkdir()
        manifest = {'protocol': 'osworld-controller-source@1', 'sdk_commit': SDK_COMMIT}
        for dirname, field in [('osworld-sdk', 'files'), ('osworld', 'runtime_files')]:
            target = root / dirname; target.mkdir()
            data = b'# synthetic source\n'; (target / 'core.py').write_bytes(data); (target / 'core.py').chmod(0o644)
            manifest[field] = [builder.record('core.py', data, 0o644)]
        (root / 'osworld-source-manifest.json').write_text(json.dumps(manifest))
        # Runner images may expose duplicate/system distributions. This fixture
        # models the isolated image environment instead of snapshotting the host.
        packages = [{'name': 'Example-Package', 'version': '1.2.3'}, {'name': 'other-dependency', 'version': '4.5.6'}]
        distributions = patch.object(importlib.metadata, 'distributions', return_value=[
            SimpleNamespace(metadata={'Name': 'example_package'}, version='1.2.3'),
            SimpleNamespace(metadata={'Name': 'other.dependency'}, version='4.5.6'),
        ])
        distributions.start(); self.addCleanup(distributions.stop)
        package_file = root / 'osworld-python-packages.json'; package_file.write_text(json.dumps(packages))
        receipt = verify_image(root)
        self.assertEqual(receipt['sdk']['files'], 1)
        source = root / 'osworld-sdk/core.py'
        source.write_text('changed\n')
        with self.assertRaises(ValueError): verify_image(root)
        source.write_bytes(b'# synthetic source\n')
        extra = source.with_name('extra.py'); extra.write_text('injected\n')
        with self.assertRaises(ValueError): verify_image(root)
        extra.unlink(); extra.symlink_to(source)
        with self.assertRaises(ValueError): verify_image(root)
        extra.unlink(); source.chmod(0o755)
        with self.assertRaises(ValueError): verify_image(root)
        source.chmod(0o644)
        package_file.write_text(json.dumps([*packages, {'name': 'unexpected-fixture-package', 'version': '0'}]))
        with self.assertRaises(ValueError): verify_image(root)
        package_file.write_text(json.dumps([*packages, {'name': 'example.package', 'version': '1.2.3'}]))
        with self.assertRaises(ValueError): verify_image(root)
        package_file.write_text(json.dumps([{**packages[0], 'version': '9.9.9'}, packages[1]]))
        with self.assertRaises(ValueError): verify_image(root)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(ImageTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    print('OSWorld committed-source export and image integrity gates passed (synthetic fixture)')
