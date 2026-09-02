"""Frozen per-task controller settings and bounded private-file operations."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from controller_server import strict_json

SDK_COMMIT = 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154'
SDK_FILES = {
    'lib_run_single.py': '41dae164d16e1ee5ddd788073548caabb1bdceb551195b9f566463c1c156b5e0',
    'task_loader.py': 'f4d72e2651eb22d2589078d2a43462fa54c36e7adf06b0ec0c7fee2ffe92bf81',
    'desktop_env/task_base.py': 'd6546df21431aa329df90f1d2a9411e2add095e2ec3f76409bfa996ef5ca5cbc',
    'desktop_env/desktop_env.py': 'e51faa67be1a15b3bd35e620e4be1e97053175f9d8c02bba892ad0f17491ace6',
}


def read_bytes(file, maximum=1024 * 1024):
    file = Path(file)
    info = file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_nlink != 1 or info.st_size > maximum:
        raise ValueError('invalid private runtime file')
    return file.read_bytes()


def read_json(file):
    value = strict_json(read_bytes(file))
    if not isinstance(value, dict):
        raise ValueError('runtime JSON must be an object')
    return value


def write_json(file, value):
    file = Path(file)
    fd, temporary = tempfile.mkstemp(prefix='.publishing-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, sort_keys=True)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        Path(temporary).unlink(missing_ok=True)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def load_config(file):
    raw = read_bytes(file)
    value = strict_json(raw)
    fields = {'protocol', 'task_id', 'source_task_id', 'profile_digest', 'sdk_root', 'sdk_commit', 'task_path', 'task_sha256',
              'private_root', 'session_directory', 'evidence_directory', 'cache_directory', 'max_steps', 'max_actions_per_turn',
              'max_text_bytes', 'max_artifact_bytes', 'prepare_timeout_sec', 'shutdown_timeout_sec', 'sleep_after_execution',
              'native_deadline', 'public_endpoint', 'website_host_suffix', 'client_password_file'}
    if not isinstance(value, dict) or set(value) != fields or value['protocol'] != 'osworld-controller@1' or value['sdk_commit'] != SDK_COMMIT:
        raise ValueError('invalid frozen controller configuration')
    for key in ['profile_digest', 'task_sha256']:
        if not isinstance(value[key], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value[key]):
            raise ValueError('invalid controller source identity')
    if not isinstance(value['task_id'], str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', value['task_id']):
        raise ValueError('invalid task identity')
    if not isinstance(value['source_task_id'], str) or not re.fullmatch(r'task_[0-9]{3}', value['source_task_id']):
        raise ValueError('invalid native source task')
    for key, maximum in [('max_steps', 100000), ('max_actions_per_turn', 256), ('max_text_bytes', 1048576),
                         ('max_artifact_bytes', 107374182400), ('prepare_timeout_sec', 3600), ('shutdown_timeout_sec', 600)]:
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise ValueError('invalid controller budget')
    if type(value['sleep_after_execution']) not in [int, float] or not 0 <= value['sleep_after_execution'] <= 60 or type(value['native_deadline']) is not bool:
        raise ValueError('invalid native execution profile')
    if not isinstance(value['website_host_suffix'], str) or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', value['website_host_suffix']):
        raise ValueError('an explicit private website namespace is required')
    from urllib.parse import urlparse
    url = urlparse(value['public_endpoint'])
    if url.scheme != 'http' or not re.fullmatch(r'[a-z][a-z0-9_-]*', url.hostname or '') or url.username or url.password or url.path != '/' or url.query or url.fragment or not url.port:
        raise ValueError('invalid private tool endpoint')
    path_keys = ['sdk_root', 'task_path', 'private_root', 'session_directory', 'evidence_directory', 'cache_directory']
    for key in path_keys + (['client_password_file'] if value['client_password_file'] is not None else []):
        if not isinstance(value[key], str) or not Path(value[key]).is_absolute() or '..' in Path(value[key]).parts or Path(value[key]).is_symlink():
            raise ValueError('controller paths must be absolute and unlinked')
        value[key] = str(Path(value[key]).resolve())
    writes = [Path(value[key]) for key in ['private_root', 'session_directory', 'evidence_directory', 'cache_directory']]
    reads = [Path(value['sdk_root']), Path(value['task_path']).parent, Path(file).resolve()]
    if value['client_password_file'] is not None:
        reads.append(Path(value['client_password_file']))
        read_bytes(value['client_password_file'], 4096)
    for index, item in enumerate(writes):
        for other in [*writes[index + 1:], *reads]:
            if item == other or item in other.parents or other in item.parents:
                raise ValueError('mutable controller paths must be disjoint from source and each other')
    if Path(value['task_path']).name != value['source_task_id'] + '.py' or digest(read_bytes(value['task_path'], 16 * 1024 * 1024)) != value['task_sha256']:
        raise ValueError('native task differs from its frozen package digest')
    for relative, expected in SDK_FILES.items():
        if hashlib.sha256(read_bytes(Path(value['sdk_root']) / relative, 16 * 1024 * 1024)).hexdigest() != expected:
            raise ValueError('native SDK core differs from the pinned release')
    return value, digest(raw)


def inventory(directory, maximum):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('invalid evidence directory')
    files, size = [], 0
    for file in sorted(root.rglob('*')):
        info = file.lstat()
        if file.is_symlink() or not (file.is_file() or file.is_dir()) or file.is_file() and info.st_nlink != 1:
            raise ValueError('linked or special native evidence is forbidden')
        if file.is_file():
            size += info.st_size
            if size > maximum or len(files) >= 100000:
                raise ValueError('native evidence exceeds the package limit')
            hasher = hashlib.sha256()
            with file.open('rb') as stream:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block: break
                    hasher.update(block)
            files.append({'path': file.relative_to(root).as_posix(), 'bytes': info.st_size, 'sha256': 'sha256:' + hasher.hexdigest()})
    return files, size
