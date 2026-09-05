"""Harbor hook client for the controller-only lifecycle socket."""
import argparse
import json
from pathlib import Path
import socket
import stat
import sys

from controller_server import strict_json


def hook(socket_path, request, timeout):
    file = Path(socket_path)
    info = file.lstat()
    if file.is_symlink() or not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o077 or file.parent.stat().st_mode & 0o077:
        raise ValueError('lifecycle socket must be private')
    payload = json.dumps(request, allow_nan=False).encode() + b'\n'
    if len(payload) > 65536 or type(timeout) not in [int, float] or not 0 < timeout <= 7200:
        raise ValueError('invalid lifecycle request or timeout')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(file)); connection.sendall(payload)
        with connection.makefile('rb') as stream:
            line = stream.readline(1024 * 1024 + 1)
    if len(line) > 1024 * 1024 or not line.endswith(b'\n'):
        raise ValueError('invalid lifecycle response')
    result = strict_json(line)
    if not isinstance(result, dict) or set(result) != {'schema_version', 'request_id', 'status', 'output'} or result['schema_version'] != '1' or result['request_id'] != request['request_id'] or result['status'] not in ['ok', 'error'] or not isinstance(result['output'], dict):
        raise ValueError('lifecycle response identity mismatch')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--timeout-sec', required=True, type=int)
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536: raise ValueError('lifecycle request too large')
    print(json.dumps(hook(args.socket, strict_json(raw), args.timeout_sec), ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    try: main()
    except Exception:
        sys.stderr.write('controller lifecycle RPC failed\n'); sys.exit(1)
