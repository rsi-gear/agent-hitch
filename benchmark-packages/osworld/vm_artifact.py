#!/usr/bin/env python3
"""Verify the release archive and extract its sole self-contained QCOW2 image.

Used inside the VM image build through a read-only BuildKit bind mount. The
large ZIP never becomes a layer in the resulting runtime image.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import zipfile

ARCHIVE_BYTES = 14189763267
ARCHIVE_SHA256 = 'eb737ae70b49849e24af407de6a518439a23de05a8497096a948334ce0a909aa'
MEMBER = 'osworld-v2-ubuntu-x86.qcow2'
IMAGE_BYTES = 27402633216
SOURCE_COMMIT = '8213366932c553e5fe758d0f2c8c8b81ffc3be8c'
SOURCE_URL = 'https://huggingface.co/datasets/xlangai/v2-image/resolve/' + SOURCE_COMMIT + '/osworld-v2-ubuntu-x86.qcow2.zip'
BLOCK = 4 * 1024 * 1024


def qcow_identity(header):
    if len(header) < 72 or header[:4] != b'QFI\xfb':
        raise ValueError('not a QCOW2 disk')
    version, backing_offset, backing_size, cluster_bits, virtual_size, encryption = struct.unpack('>IQIIQI', header[4:36])
    if version not in (2, 3) or backing_offset or backing_size or encryption or not 9 <= cluster_bits <= 21 or virtual_size < 1:
        raise ValueError('release disk must be an unencrypted self-contained QCOW2 image')
    if version == 3 and (len(header) < 104 or struct.unpack('>Q', header[72:80])[0] & 4):
        raise ValueError('external QCOW2 data files are unsupported')
    return {'format': 'qcow2', 'version': version, 'virtual_size_bytes': virtual_size,
            'cluster_bits': cluster_bits, 'external_backing_file': False}


def extract(archive_path, output_path, manifest_path, progress=None):
    archive_path, output_path, manifest_path = map(Path, (archive_path, output_path, manifest_path))
    if archive_path.is_symlink() or not archive_path.is_file() or archive_path.stat().st_size != ARCHIVE_BYTES:
        raise ValueError('archive size/path differs from the pinned release')
    if any(path.exists() or path.is_symlink() for path in (output_path, manifest_path)):
        raise ValueError('VM extraction requires fresh output paths')
    temporary = None
    published_image = published_manifest = False
    complete = False
    try:
        # Keep the same file descriptor for verification and ZIP parsing.
        with archive_path.open('rb') as source:
            archive_hash = hashlib.sha256()
            for chunk in iter(lambda: source.read(BLOCK), b''): archive_hash.update(chunk)
            if archive_hash.hexdigest() != ARCHIVE_SHA256:
                raise ValueError('archive digest differs from the pinned release')
            if progress:
                progress({'phase': 'archive_verified', 'archive_sha256': 'sha256:' + ARCHIVE_SHA256})
            source.seek(0)
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                if len(members) != 1 or members[0].filename != MEMBER:
                    raise ValueError('unexpected VM archive members')
                member = members[0]
                mode = member.external_attr >> 16
                if member.file_size != IMAGE_BYTES or member.flag_bits & 1 or member.compress_type != zipfile.ZIP_DEFLATED or mode & 0o170000 not in (0, 0o100000):
                    raise ValueError('invalid release VM archive member')
                fd, name = tempfile.mkstemp(prefix='.hitch-vm-', dir=output_path.parent)
                temporary = Path(name)
                image_hash, count, header = hashlib.sha256(), 0, b''
                with os.fdopen(fd, 'wb') as target, archive.open(member) as image:
                    for chunk in iter(lambda: image.read(BLOCK), b''):
                        if not count: header = chunk[:104]
                        count += len(chunk)
                        if count > IMAGE_BYTES: raise ValueError('expanded VM exceeds the release bound')
                        image_hash.update(chunk)
                        # Preserve zero extents without allocating redundant host space.
                        if chunk.count(0) == len(chunk): target.seek(len(chunk), os.SEEK_CUR)
                        else: target.write(chunk)
                    if count != IMAGE_BYTES: raise ValueError('truncated release VM')
                    identity = qcow_identity(header)
                    target.truncate(count); target.flush(); os.fsync(target.fileno())
                record = {'protocol': 'osworld-vm-artifact@1', 'source_commit': SOURCE_COMMIT, 'source_url': SOURCE_URL,
                          'archive_sha256': 'sha256:' + ARCHIVE_SHA256, 'archive_bytes': ARCHIVE_BYTES,
                          'archive_member': MEMBER, 'image_sha256': 'sha256:' + image_hash.hexdigest(),
                          'image_file_bytes': count, 'qcow2': identity, 'official_guest_boot_verified': False}
                temporary.chmod(0o444)
                os.link(temporary, output_path)  # Exclusive publication; never overwrite.
                published_image = True
                with manifest_path.open('x') as manifest:
                    published_manifest = True
                    json.dump(record, manifest, indent=2); manifest.write('\n')
                    manifest.flush(); os.fsync(manifest.fileno())
                complete = True
                return record
    finally:
        if not complete:
            if published_manifest: manifest_path.unlink(missing_ok=True)
            if published_image: output_path.unlink(missing_ok=True)
        if temporary: temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    def report(value): print(json.dumps(value, sort_keys=True), flush=True)
    report(extract(args.archive, args.output, args.manifest, progress=report))
