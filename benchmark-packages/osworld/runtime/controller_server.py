"""OSWorld channel transports: candidate HTTP tools, private Unix management.

The caller owns the pinned SDK thread, VM and fresh Hitch run supervisor. This
component neither starts model sessions nor marks a benchmark task successful.
"""
import copy
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socketserver
import threading
from urllib.parse import urlparse


def strict_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('duplicate JSON field')
            value[key] = item
        return value
    def invalid_constant(_value):
        raise ValueError('non-finite JSON number')
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid_constant)


class _PublicServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, *_args):
        # Transport errors must not print request headers/tokens or action text.
        pass


class ControllerServer:
    def __init__(self, channel, session, action_policy, private_socket, *, public_address, public_endpoint, native_deadline=False):
        if channel.validate_actions is not action_policy:
            raise ValueError('tool schemas must use the channel action policy')
        coordinates = action_policy.actions['MOVE_TO']['parameters']
        if channel.screen_size != tuple(coordinates[key]['range'][1] for key in ['x', 'y']):
            raise ValueError('screenshot dimensions differ from the native coordinate space')
        if not isinstance(session.get('token'), str) or not re.fullmatch(r'[a-f0-9]{64}', session['token']):
            raise ValueError('invalid private controller credential')
        if not isinstance(session.get('lease_id'), str) or not session['lease_id'] or type(session.get('epoch')) is not int or session['epoch'] < 1:
            raise ValueError('invalid controller lease')
        self.channel, self.session = channel, copy.deepcopy(session)
        self.native_deadline = native_deadline
        self.tools = action_policy.tool_definitions(max_actions_per_turn=channel.max_actions_per_turn, max_text_bytes=channel.max_text_bytes)
        self.private_socket = Path(private_socket)
        self.private_socket.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.private_socket.parent.is_symlink() or self.private_socket.parent.stat().st_mode & 0o077:
            raise ValueError('management socket requires a private controller directory')
        if self.private_socket.exists() or self.private_socket.is_symlink():
            raise ValueError('refusing to adopt an existing controller socket')
        parsed = urlparse(public_endpoint)
        if parsed.scheme != 'http' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != '/' or not re.fullmatch(r'[a-z][a-z0-9_-]*|127\.0\.0\.1', parsed.hostname or ''):
            raise ValueError('tool endpoint must be a private Compose service root')
        if parsed.hostname == '127.0.0.1' and public_address[0] != '127.0.0.1':
            raise ValueError('loopback endpoint requires a loopback listener')
        self.endpoint, self.closed, self.started = public_endpoint, False, False
        self.receipts, self.lock, self.threads = {}, threading.RLock(), []
        owner = self

        class Tools(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def log_message(self, *_args):
                pass

            def reply(self, status, value):
                encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(encoded)
                self.close_connection = True

            def do_GET(self):
                self.reply(404, {'error': 'unknown_route'})

            def do_POST(self):
                try:
                    if self.path != '/call':
                        return self.reply(404, {'error': 'unknown_route'})
                    headers = self.headers.get_all('Authorization', [])
                    if len(headers) != 1 or not re.fullmatch(r'Bearer [a-f0-9]{64}', headers[0]):
                        raise PermissionError()
                    token = headers[0][7:]
                    # Reject stale/absent bindings before reading a body. The
                    # actual observe/submit authorizes again under the lock.
                    with owner.channel.condition:
                        owner.channel._authorize(token)
                    lengths = self.headers.get_all('Content-Length', [])
                    if len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0]) or self.headers.get('Transfer-Encoding'):
                        raise ValueError()
                    length = int(lengths[0])
                    if not 0 < length <= owner.channel.max_text_bytes + 1024:
                        return self.reply(413, {'error': 'request_too_large'})
                    data = self.rfile.read(length)
                    if len(data) != length:
                        raise ValueError()
                    request = strict_json(data)
                    if not isinstance(request, dict) or set(request) != {'name', 'arguments'} or not isinstance(request['arguments'], dict):
                        raise ValueError()
                    args = request['arguments']
                    if request['name'] == 'desktop.observe' and not args:
                        result = owner.channel.observe(token)
                    elif request['name'] == 'desktop.submit' and set(args) == {'sequence', 'request_id', 'response', 'actions'}:
                        result = owner.channel.submit(token, **args)
                    else:
                        raise ValueError()
                    self.reply(200, result)
                except PermissionError:
                    self.reply(401, {'error': 'closed_or_stale_candidate'})
                except (ValueError, TypeError, RecursionError, OverflowError):
                    self.reply(400, {'error': 'invalid_tool_request'})
                except (TimeoutError, ConnectionError, BrokenPipeError):
                    self.close_connection = True
                except Exception:
                    try:
                        owner.channel.finish('failed')
                    finally:
                        self.reply(500, {'error': 'controller_failure'})

        class Management(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(10)
                try:
                    line = self.rfile.readline(65537)
                    if not line.endswith(b'\n') or len(line) > 65536:
                        raise ValueError()
                    result = owner.control(strict_json(line))
                except (ValueError, TypeError, RecursionError, OverflowError):
                    result = {'status': 'error', 'error': 'invalid_management_request'}
                except PermissionError:
                    result = {'status': 'error', 'error': 'unauthorized_or_stale_lease'}
                except (TimeoutError, ConnectionError):
                    return
                self.wfile.write(json.dumps(result, ensure_ascii=False, allow_nan=False).encode() + b'\n')

        class Private(socketserver.UnixStreamServer):
            def handle_error(self, *_args):
                pass

        self.public = _PublicServer(public_address, Tools)
        try:
            self.private = Private(str(self.private_socket), Management)
            os.chmod(self.private_socket, 0o600)
            self.socket_identity = self.private_socket.stat().st_ino
        except BaseException:
            self.public.server_close()
            raise
        if parsed.hostname == '127.0.0.1' and parsed.port == 0 and public_address[1] == 0:
            self.endpoint = f'http://127.0.0.1:{self.public.server_port}/'
        elif parsed.port != self.public.server_port:
            self.private.server_close(); self.public.server_close(); self.private_socket.unlink()
            raise ValueError('tool endpoint port differs from its listener')

    def control(self, request):
        with self.lock:
            if not isinstance(request, dict) or set(request) != {'schema_version', 'token', 'lease_id', 'epoch', 'request_id', 'operation', 'parameters'}:
                raise ValueError('invalid management envelope')
            if request['schema_version'] != '1' or type(request['epoch']) is not int or request['lease_id'] != self.session['lease_id'] or request['epoch'] != self.session['epoch'] or not isinstance(request['token'], str) or not hmac.compare_digest(request['token'], self.session['token']):
                raise PermissionError('unauthorized or stale lease')
            rid, params = request['request_id'], request['parameters']
            if not isinstance(rid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,128}', rid) or not isinstance(params, dict):
                raise ValueError('invalid management request')
            digest = hashlib.sha256(json.dumps({k: v for k, v in request.items() if k != 'token'}, sort_keys=True, allow_nan=False).encode()).hexdigest()
            if rid in self.receipts:
                saved_digest, result = self.receipts[rid]
                if saved_digest != digest:
                    raise ValueError('management request identity reused')
                return copy.deepcopy(result)
            if self.closed:
                raise ValueError('controller server closed')
            if request['operation'] == 'state' and not params:
                # This is a fresh read, not a mutation receipt. Retaining every
                # supervisor poll would grow memory for the full trial lifetime.
                return {'schema_version': '1', 'request_id': rid, 'status': 'ok', 'output': self.channel.management_state()}
            try:
                if request['operation'] == 'bind' and set(params) == {'generation', 'run_id'}:
                    token = self.channel.bind_context(**params)
                    output = {'binding': {'endpoint': self.endpoint, 'token': token, 'tools': self.tools}}
                elif request['operation'] == 'cancel' and not params:
                    self.channel.finish('cancelled')
                    output = {'cancelled': True}
                elif request['operation'] == 'expire_budget' and not params and self.native_deadline:
                    output = self.channel.expire_budget()
                else:
                    raise ValueError('unsupported management operation')
                result = {'schema_version': '1', 'request_id': rid, 'status': 'ok', 'output': output}
            except (ValueError, PermissionError):
                result = {'schema_version': '1', 'request_id': rid, 'status': 'error', 'error': 'invalid_management_operation'}
            except Exception:
                self.channel.finish('failed')
                result = {'schema_version': '1', 'request_id': rid, 'status': 'error', 'error': 'controller_failure'}
            # Private in-memory receipts may contain phase tokens. Never place
            # them in candidate logs, channel evidence or a result bundle.
            self.receipts[rid] = (digest, copy.deepcopy(result))
            return copy.deepcopy(result)

    def start(self):
        with self.lock:
            if self.closed or self.started:
                raise RuntimeError('controller server cannot be restarted')
            self.started = True
            for server in [self.public, self.private]:
                thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
                thread.start(); self.threads.append(thread)

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
        try:
            self.channel.finish('cancelled')
        finally:
            for server in [self.public, self.private]:
                if self.started:
                    server.shutdown()
                server.server_close()
            for thread in self.threads:
                thread.join(2)
            if self.private_socket.exists() and not self.private_socket.is_symlink() and self.private_socket.stat().st_ino == self.socket_identity:
                self.private_socket.unlink()
