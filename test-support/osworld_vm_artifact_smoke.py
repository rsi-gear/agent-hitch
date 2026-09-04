"""Archive identity and bounded QCOW2 extraction with small synthetic disks."""
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld'))
import vm_artifact


def image(backing=0, external_data=False):
    data = bytearray(b'QFI\xfb' + struct.pack('>IQIIQI', 3, backing, 0, 16, 53687091200, 0) + b'\0' * 68)
    if external_data: data[72:80] = struct.pack('>Q', 4)
    return bytes(data) + b'\0' * (8 * 1024 * 1024)


class VMArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hitch-vm-artifact-')
        self.root = Path(self.temporary.name)

    def tearDown(self): self.temporary.cleanup()

    def fixture(self, data=None, member=None, compression=zipfile.ZIP_DEFLATED):
        data = image() if data is None else data
        source = self.root / 'artifact.zip'
        with zipfile.ZipFile(source, 'w', compression=compression) as archive:
            archive.writestr(member or vm_artifact.MEMBER, data)
        return source, patch.multiple(vm_artifact, ARCHIVE_BYTES=source.stat().st_size,
                       ARCHIVE_SHA256=hashlib.sha256(source.read_bytes()).hexdigest(), IMAGE_BYTES=len(data))

    def test_verified_image_preserves_all_bytes_and_virtual_size(self):
        data = image(); source, constants = self.fixture(data)
        output, receipt = self.root / 'System.qcow2', self.root / 'manifest.json'
        with constants:
            record = vm_artifact.extract(source, output, receipt)
            self.assertEqual(output.read_bytes(), data)
            self.assertEqual(record['image_sha256'], 'sha256:' + hashlib.sha256(data).hexdigest())
            self.assertEqual(record['qcow2']['virtual_size_bytes'], 53687091200)
            self.assertFalse(record['official_guest_boot_verified'])
            self.assertEqual(output.stat().st_mode & 0o777, 0o444)
            with self.assertRaises(ValueError): vm_artifact.extract(source, output, receipt)
        self.assertFalse(list(self.root.glob('.hitch-vm-*')))

    def test_wrong_digest_fails_before_publication(self):
        source, constants = self.fixture()
        with constants, patch.object(vm_artifact, 'ARCHIVE_SHA256', '0' * 64), self.assertRaises(ValueError):
            vm_artifact.extract(source, self.root / 'out', self.root / 'manifest')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['artifact.zip'])

    def test_manifest_failure_rolls_back_owned_image(self):
        source, constants = self.fixture()
        with constants, self.assertRaises(OSError):
            vm_artifact.extract(source, self.root / 'out', self.root / 'missing/manifest')
        self.assertFalse((self.root / 'out').exists())
        self.assertFalse(list(self.root.glob('.hitch-vm-*')))

    def test_reject_wrong_member_stored_file_and_link(self):
        for member, compression in [('../outside', zipfile.ZIP_DEFLATED), (vm_artifact.MEMBER, zipfile.ZIP_STORED)]:
            with self.subTest(member=member, compression=compression):
                source, constants = self.fixture(member=member, compression=compression)
                with constants, self.assertRaises(ValueError): vm_artifact.extract(source, self.root / 'out', self.root / 'manifest')
                source.unlink()
        source, constants = self.fixture()
        linked = self.root / 'linked.zip'; linked.symlink_to(source)
        with constants, self.assertRaises(ValueError): vm_artifact.extract(linked, self.root / 'out', self.root / 'manifest')

    def test_reject_backing_or_external_data_and_remove_partial_output(self):
        for data in (image(backing=4096), image(external_data=True), b'not a qcow image'):
            source, constants = self.fixture(data)
            with constants, self.assertRaises(ValueError): vm_artifact.extract(source, self.root / 'out', self.root / 'manifest')
            self.assertFalse((self.root / 'out').exists())
            self.assertFalse((self.root / 'manifest').exists())
            self.assertFalse(list(self.root.glob('.hitch-vm-*')))
            source.unlink()


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(VMArtifactTests))
    if not result.wasSuccessful(): sys.exit(1)
    print('VM archive identity and bounded extraction gates passed (synthetic fixtures)')
