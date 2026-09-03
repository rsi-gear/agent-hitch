#!/usr/bin/env python3
"""Rebase visible state asset URLs onto a pinned, trial-local mirror.

Consumes authorized acquisition receipts and local bytes. No network requests,
task modification, gold exposure, or implicit 'main' resolution at runtime.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from urllib.parse import urlsplit

REVISION = 'acad110ef3136405f95434b54862bf9066176c2a'
PREFIX = 'https://huggingface.co/datasets/xlangai/osworld_v2_assets/resolve/main/'
URL = re.compile(re.escape(PREFIX) + r'[A-Za-z0-9_./-]+')


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def asset_path(root, relative):
    parts = PurePosixPath(relative)
    if parts.is_absolute() or '..' in parts.parts or '\\' in relative or not relative:
        raise ValueError('unsafe asset path')
    current = root
    for part in parts.parts:
        current = current / part
        if current.is_symlink(): raise ValueError('linked asset is not allowed')
    if not current.is_file(): raise ValueError('missing pinned asset')
    return current


def prepare(state, state_sha256, assets, acquisition, origin, output):
    state, assets, acquisition, output = Path(state), Path(assets).resolve(), Path(acquisition), Path(output).absolute()
    parsed = urlsplit(origin)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or not parsed.hostname.endswith('.hitch.test')
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/') or parsed.port):
        raise ValueError('mirror must be a trial-local hitch.test origin without credentials or path')
    if state.is_symlink() or acquisition.is_symlink() or output.exists() or output.is_symlink():
        raise ValueError('ordinary inputs and fresh output are required')
    original = state.read_bytes()
    if sha(original) != state_sha256: raise ValueError('authorized state identity mismatch')
    receipt_bytes = acquisition.read_bytes()
    files = json.loads(receipt_bytes)['files']
    records = {}
    for entry in files:
        if (entry['repository'] != 'xlangai/osworld_v2_assets_gated' or entry['revision'] != REVISION
                or entry.get('upstream_blob_verified') is not True or entry['file'] in records):
            raise ValueError('asset receipt is not the pinned verified release')
        records[entry['file']] = entry
    used = set()
    def rewrite(value):
        if isinstance(value, dict): return {key: rewrite(item) for key, item in value.items()}
        if isinstance(value, list): return [rewrite(item) for item in value]
        if not isinstance(value, str): return value
        def replace(match):
            relative = match.group()[len(PREFIX):]
            if relative not in records: raise ValueError('state references an unverified asset')
            used.add(relative)
            return origin.rstrip('/') + '/' + relative
        updated = URL.sub(replace, value)
        if PREFIX in updated: raise ValueError('unsupported embedded asset URL')
        return updated
    transformed = rewrite(json.loads(original))
    if not used: raise ValueError('state contains no supported asset references')
    encoded = (json.dumps(transformed, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.state-assets-', dir=output.parent))
    try:
        manifest = {'protocol': 'osworld-state-asset-rebase@1', 'asset_revision': REVISION,
            'source_state_sha256': sha(original), 'transformed_state_sha256': sha(encoded),
            'acquisition_sha256': sha(receipt_bytes), 'source_prefix': PREFIX, 'mirror_origin': origin.rstrip('/'),
            'transformation': 'replace verified asset URL origins in string values; preserve all other state values', 'files': []}
        for relative in sorted(used):
            data = asset_path(assets, relative).read_bytes(); entry = records[relative]
            if sha(data) != 'sha256:' + entry['sha256'] or len(data) != entry['size']:
                raise ValueError('local asset differs from its verified receipt')
            target = temporary / 'public' / relative
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            manifest['files'].append({'path': relative, 'bytes': len(data), 'sha256': sha(data)})
        private = temporary / 'private'; private.mkdir()
        (private / 'state.json').write_bytes(encoded)
        (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        temporary.rename(output)
        return manifest
    finally:
        if temporary.exists(): shutil.rmtree(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True)
    parser.add_argument('--state-sha256', required=True)
    parser.add_argument('--assets-root', required=True)
    parser.add_argument('--acquisition', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    manifest = prepare(args.state, args.state_sha256, args.assets_root, args.acquisition, args.origin, args.out)
    print(json.dumps({'output': args.out, 'visible_files': len(manifest['files']),
                      'source_state_sha256': manifest['source_state_sha256'], 'transformed_state_sha256': manifest['transformed_state_sha256']}))
