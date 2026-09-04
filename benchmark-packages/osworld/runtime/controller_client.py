"""Private controller RPC over a filesystem-local Unix socket.

Run inside the controller service. Request JSON comes from stdin; the private
credential is read from a file, never from argv or a candidate environment.
Bind responses include a candidate phase token and must not enter evidence logs.
"""
import argparse
import json
from pathlib import Path
import socket
import sys


def control(socket_path, session, request):
    if set(request) != {'request_id', 'operation', 'parameters'}:
        raise ValueError('invalid management client request')
    payload = {**request, 'schema_version': '1', **{k: session[k] for k in ['token', 'lease_id', 'epoch']}}
    encoded = json.dumps(payload, allow_nan=False).encode() + b'\n'
    if len(encoded) > 65536:
        raise ValueError('management request too large')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(15)
        connection.connect(str(socket_path))
        connection.sendall(encoded)
        with connection.makefile('rb') as stream:
            line = stream.readline(2 * 1024 * 1024 + 1)
    if not line.endswith(b'\n') or len(line) > 2 * 1024 * 1024:
        raise RuntimeError('invalid management response')
    result = json.loads(line)
    if result.get('status') != 'ok' or result.get('schema_version') != '1' or result.get('request_id') != request['request_id']:
        raise RuntimeError('controller rejected management request: ' + str(result.get('error', 'invalid_response')))
    return result['output']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--session', required=True)
    args = parser.parse_args()
    session_file = Path(args.session)
    if session_file.is_symlink() or session_file.stat().st_mode & 0o077:
        raise ValueError('controller session file must be private')
    request = sys.stdin.buffer.read(65537)
    if len(request) > 65536:
        raise ValueError('management request too large')
    output = control(args.socket, json.loads(session_file.read_text()), json.loads(request))
    print(json.dumps(output, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('controller RPC failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
