"""Mirror only verified visible assets, preserving all non-URL task state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('state_assets', Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld/prepare-state-assets.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class MirrorTests(unittest.TestCase):
    def test_rebase_preserves_values_and_excludes_unreferenced_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); assets = root / 'assets'; assets.mkdir()
            (assets / 'visible.pdf').write_bytes(b'synthetic visible document')
            (assets / 'private.txt').write_bytes(b'PRIVATE_SENTINEL')
            original = {'nested': [{'text': 'Read ' + module.PREFIX + 'visible.pdf', 'count': 3, 'enabled': True}], 'note': 'unchanged'}
            state = root / 'state.json'; state.write_text(json.dumps(original))
            data = (assets / 'visible.pdf').read_bytes()
            acquisition = root / 'receipt.json'; acquisition.write_text(json.dumps({'files': [{'repository': 'xlangai/osworld_v2_assets_gated', 'revision': module.REVISION, 'file': 'visible.pdf', 'upstream_blob_verified': True, 'sha256': module.sha(data)[7:], 'size': len(data)}]}))
            def run(name):
                return module.prepare(state, module.sha(state.read_bytes()), assets, acquisition, 'http://assets.trial.hitch.test', root / name)
            result = run('output')
            self.assertEqual(len(result['files']), 1)
            self.assertEqual((root / 'output/public/visible.pdf').read_bytes(), data)
            self.assertFalse((root / 'output/public/private.txt').exists())
            self.assertFalse((root / 'output/public/state.json').exists())
            restored = (root / 'output/private/state.json').read_text().replace('http://assets.trial.hitch.test/', module.PREFIX)
            self.assertEqual(json.loads(restored), original)
            (assets / 'visible.pdf').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'differs'): run('bad')
            self.assertFalse((root / 'bad').exists())
            (assets / 'visible.pdf').unlink(); (assets / 'visible.pdf').symlink_to('private.txt')
            with self.assertRaisesRegex(ValueError, 'linked'): run('linked')
            state.write_text(json.dumps({'text': module.PREFIX + 'unknown.pdf'}))
            with self.assertRaisesRegex(ValueError, 'unverified'): run('missing')


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(MirrorTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    print('OSWorld pinned visible asset mirror contract passed')
