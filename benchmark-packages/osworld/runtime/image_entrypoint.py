"""Verify image-owned source bytes before entering the PID-1 lifecycle owner."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys

from runtime_config import SDK_COMMIT, digest, inventory, load_config, read_json


def verify_tree(root, expected):
    files, size = inventory(root, 128 * 1024 * 1024)
    canonical = [{k: item[k] for k in ['path', 'bytes', 'sha256']} for item in expected]
    if files != sorted(canonical, key=lambda item: item['path']):
        raise ValueError('image source files differ from the build manifest')
    for item in expected:
        if (root / item['path']).stat().st_mode & 0o777 != item['mode']:
            raise ValueError('image source mode differs from the build manifest')
    return {'files': len(files), 'bytes': size}


def verify_image(root=Path('/opt')):
    manifest_file = root / 'osworld-source-manifest.json'
    manifest = read_json(manifest_file)
    if manifest.get('protocol') != 'osworld-controller-source@1' or manifest.get('sdk_commit') != SDK_COMMIT:
        raise ValueError('image SDK identity differs from the pinned release')
    sdk = verify_tree(root / 'osworld-sdk', manifest['files'])
    runtime = verify_tree(root / 'osworld', manifest['runtime_files'])
    packages = json.loads((root / 'osworld-python-packages.json').read_text())
    def normalize(name): return re.sub(r'[-_.]+', '-', name).lower()
    expected = {normalize(p['name']): p['version'] for p in packages}
    actual = {normalize(p.metadata['Name']): p.version for p in importlib.metadata.distributions()}
    if len(expected) != len(packages) or expected != actual:
        raise ValueError('installed Python packages differ from the built image')
    return {'protocol': 'osworld-controller-image-check@1', 'sdk_commit': SDK_COMMIT,
            'source_manifest_sha256': digest(manifest_file.read_bytes()), 'sdk': sdk, 'runtime': runtime, 'python_packages': len(actual)}


def main():
    receipt = verify_image()
    if sys.argv[1:] == ['--verify-image']:
        print(json.dumps(receipt, sort_keys=True)); return
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config, _ = load_config(args.config)
    if config['sdk_root'] != '/opt/osworld-sdk':
        raise ValueError('controller must use its verified image-owned SDK')
    os.execv(sys.executable, [sys.executable, '/opt/osworld/controller_lifecycle.py', '--config', args.config])


if __name__ == '__main__':
    try: main()
    except Exception:
        sys.stderr.write('controller image verification failed\n'); sys.exit(1)
