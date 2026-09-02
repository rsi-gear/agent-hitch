#!/usr/bin/env python3
"""Export a pinned public SDK and runtime into a fresh controller build context.

No gated tasks/assets, local untracked files, credentials or Git configuration
are copied. The guest server submodule belongs to the separately pinned VM.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

SDK_COMMIT = 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154'
SDK_TREE = '2c8d3b74876f44a050c94103a10e54ca68c1ef22'
GITLINKS = {'desktop_env/server': 'a3cc3f0c64e463f020d1a44780307e9b46cbcab1'}
SDK_METADATA = {'pyproject.toml': '8f1afe53add75e0534f25f6e68ecb000a1378d3d1099854bb240c51d7d318567',
                'uv.lock': 'd32c9fbb9fed4824f89cf2c1b8c7a8a2efb72f8d36f32d5d0b7f6e3465146443'}


def git(repository, *args):
    return subprocess.check_output(['git', '-C', str(repository), *args], stderr=subprocess.PIPE, timeout=60)


def record(name, data, mode):
    return {'path': name, 'bytes': len(data), 'mode': mode, 'sha256': 'sha256:' + hashlib.sha256(data).hexdigest()}


def export_sdk(repository, destination):
    tree = git(repository, 'rev-parse', SDK_COMMIT + '^{tree}').decode().strip()
    if tree != SDK_TREE:
        raise ValueError('SDK tree differs from the pinned public release')
    entries, omitted = {}, {}
    for row in git(repository, 'ls-tree', '-rz', SDK_COMMIT).split(b'\0'):
        if not row: continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split(); name = name.decode()
        if kind == 'commit': omitted[name] = oid
        elif kind == 'blob' and mode in ['100644', '100755']: entries[name] = (int(mode[-3:], 8), oid)
        else: raise ValueError('unsupported linked SDK entry')
    if omitted != GITLINKS or not 1 <= len(entries) <= 2000:
        raise ValueError('SDK source membership differs from the release')
    raw = git(repository, 'archive', '--format=tar', SDK_COMMIT)
    if len(raw) > 128 * 1024 * 1024:
        raise ValueError('SDK archive exceeds its build-context bound')
    files, seen = [], set()
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('invalid SDK archive path')
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True); continue
            if not member.isfile() or member.name in seen or member.name not in entries:
                raise ValueError('invalid SDK archive member')
            mode, oid = entries[member.name]
            data = archive.extractfile(member).read()
            if hashlib.sha1(('blob ' + str(len(data)) + '\0').encode() + data).hexdigest() != oid:
                raise ValueError('SDK archive differs from its pinned Git blob')
            if member.name in SDK_METADATA and hashlib.sha256(data).hexdigest() != SDK_METADATA[member.name]:
                raise ValueError('SDK dependency metadata changed')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data); target.chmod(mode)
            files.append(record(member.name, data, mode)); seen.add(member.name)
    if seen != set(entries):
        raise ValueError('SDK archive omitted tracked source files')
    return {'protocol': 'osworld-controller-source@1', 'sdk_commit': SDK_COMMIT, 'git_tree': tree,
            'git_archive_sha256': 'sha256:' + hashlib.sha256(raw).hexdigest(), 'files': sorted(files, key=lambda f: f['path']),
            'excluded_guest_submodules': omitted, 'runtime_files': []}


def prepare(repository, output):
    repository, output = Path(repository).resolve(), Path(output).absolute()
    runtime = Path(__file__).resolve().parent / 'runtime'
    if output.exists() or output.is_symlink():
        raise ValueError('build context already exists; use a fresh destination')
    output = output.resolve()
    for source in [repository, runtime]:
        if output == source or source in output.parents or output in source.parents:
            raise ValueError('build destination must be disjoint from source')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.controller-build-', dir=output.parent))
    try:
        manifest = export_sdk(repository, temporary / 'sdk')
        target = temporary / 'runtime'; target.mkdir()
        for file in sorted(runtime.iterdir()):
            if file.name == '__pycache__': continue
            if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
                raise ValueError('runtime build source must contain ordinary files only')
            data = file.read_bytes(); mode = file.stat().st_mode & 0o777
            (target / file.name).write_bytes(data); (target / file.name).chmod(mode)
            manifest['runtime_files'].append(record(file.name, data, mode))
        encoded = json.dumps(manifest, indent=2, sort_keys=True).encode() + b'\n'
        (temporary / 'source-manifest.json').write_bytes(encoded)
        # Destination is task-owned and fresh; never merge with an earlier build.
        if output.exists(): raise ValueError('build destination appeared during export')
        os.rename(temporary, output)
        return {'context': str(output), 'source_manifest_sha256': 'sha256:' + hashlib.sha256(encoded).hexdigest(),
                'sdk_commit': SDK_COMMIT, 'sdk_files': len(manifest['files']), 'runtime_files': len(manifest['runtime_files'])}
    finally:
        if temporary.exists(): shutil.rmtree(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-checkout', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.sdk_checkout, args.out), sort_keys=True))
