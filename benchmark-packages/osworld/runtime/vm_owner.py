"""Private control plane for one Harbor-owned OSWorld VM service.

The container, network and writable storage are owned by Harbor. This process
owns the emulator and its descendants; it never talks to the host Docker API.
The controller creates /control/session.json on a per-trial private volume.
"""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
from urllib.request import urlopen


class VMOwner:
    def __init__(self, session_path=Path('/control/session.json'), storage=Path('/storage'),
                 base=Path('/System.qcow2'), overlay=Path('/boot.qcow2'),
                 command=('/usr/bin/tini', '-s', '/run/entry.sh')):
        self.session_path, self.storage, self.base, self.overlay = session_path, storage, base, overlay
        self.command = list(command)
        self.session = None
        self.process = None
        self.closed = False
        self.generation = 0
        self.responses = {}
        self.lock = threading.Lock()

    def identity(self):
        if self.session_path.is_symlink():
            raise ValueError('private VM session must not be a symlink')
        value = json.loads(self.session_path.read_text())
        if not isinstance(value.get('token'), str) or len(value['token']) < 32 or not isinstance(value.get('lease_id'), str) or type(value.get('epoch')) is not int or value['epoch'] < 1:
            raise ValueError('invalid private VM session')
        if self.session is None:
            self.session = value
        elif value != self.session:
            raise ValueError('VM session identity changed')
        return self.session

    def preflight(self):
        if not self.base.is_file() or self.base.is_symlink():
            raise ValueError('immutable VM base file is missing')
        if os.environ.get('KVM', 'Y') != 'N' and not os.access('/dev/kvm', os.R_OK | os.W_OK):
            raise RuntimeError('requested KVM acceleration is unavailable')
        if self.storage.is_symlink() or self.overlay.is_symlink():
            raise ValueError('VM mutable paths must not be symlinks')
        self.storage.mkdir(parents=True, exist_ok=True)
        owner = self.storage / '.hitch-vm-owner.json'
        expected = {k: self.identity()[k] for k in ['lease_id', 'epoch']}
        if owner.exists():
            if json.loads(owner.read_text()) != expected:
                raise ValueError('VM storage belongs to another lease')
        else:
            if any(self.storage.iterdir()) or self.overlay.exists():
                raise ValueError('refusing to adopt existing VM state')
            owner.write_text(json.dumps(expected))

    def children(self):
        # PID 1 adopts daemonized helpers in the dedicated VM container. The
        # service has no unrelated child workloads. Outside PID 1, recurse only
        # through descendants of this process (used by process ownership tests).
        parents = {}
        for directory in Path('/proc').glob('[0-9]*'):
            try:
                parents[int(directory.name)] = int((directory / 'stat').read_text().rsplit(') ', 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                continue
        owned = {os.getpid()}
        while True:
            expanded = owned | {pid for pid, parent in parents.items() if parent in owned}
            if expanded == owned:
                return owned - {os.getpid()}
            owned = expanded

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=10)
        self.process = None
        # A VM entry script may daemonize helpers outside its process group.
        # They are still descendants of this dedicated PID-1 service.
        if os.getpid() == 1:
            for pid in self.children():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 3
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0 and time.monotonic() < deadline:
                        time.sleep(0.02)
                        continue
                    if pid == 0:
                        raise TimeoutError('VM helper shutdown was not confirmed')
                except ChildProcessError:
                    break

    def clear_mutable_state(self):
        self.preflight()
        self.overlay.unlink(missing_ok=True)
        for entry in self.storage.iterdir():
            if entry.name == '.hitch-vm-owner.json':
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()

    def start(self):
        if self.closed:
            raise RuntimeError('VM owner is closed')
        if self.process is not None:
            if self.process.poll() is None:
                return {'ready': True, 'generation': self.generation}
            raise RuntimeError('emulator exited; explicit reset required')
        self.preflight()
        timeout = int(os.environ.get('VM_BOOT_TIMEOUT_SEC', '300'))
        if not 1 <= timeout <= 1800:
            raise ValueError('invalid VM boot timeout')
        self.generation += 1
        # The upstream image otherwise opens an unauthenticated monitor on
        # loopback. Guest user-mode networking must not bypass the leased API.
        launch_environment = {**os.environ, 'MONITOR': 'none', 'SERIAL': 'stdio'}
        self.process = subprocess.Popen(self.command, start_new_session=True, env=launch_environment)
        if self.closed:
            self.stop()
            raise RuntimeError('VM owner closed during startup')
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                if self.closed:
                    raise RuntimeError('VM owner closed during startup')
                if self.process.poll() is not None:
                    raise RuntimeError('emulator exited before guest readiness')
                try:
                    with urlopen('http://127.0.0.1:5000/screenshot', timeout=2) as response:
                        # Check actual screenshot bytes, not merely HTTP 200.
                        if response.status == 200 and response.read(8) == b'\x89PNG\r\n\x1a\n':
                            return {'ready': True, 'generation': self.generation}
                except OSError:
                    pass
                time.sleep(0.5)
            raise TimeoutError('guest screenshot endpoint did not become ready')
        except BaseException:
            self.stop()
            raise

    def control(self, token, request):
        with self.lock:
            session = self.identity()
            if not hmac.compare_digest(token, session['token']) or request.get('lease_id') != session['lease_id'] or request.get('epoch') != session['epoch']:
                raise PermissionError('unauthorized or stale VM lease')
            rid = request.get('request_id')
            if not isinstance(rid, str) or not 1 <= len(rid) <= 128:
                raise ValueError('invalid request identity')
            encoded = json.dumps(request, sort_keys=True)
            if rid in self.responses:
                previous, response = self.responses[rid]
                if previous != encoded:
                    raise ValueError('request identity reused for different operation')
                if 'error' in response:
                    raise RuntimeError('previous VM operation failed: ' + response['error'])
                return response
            operation = request.get('operation')
            try:
                if operation == 'start':
                    result = self.start()
                elif operation == 'reset':
                    if self.closed:
                        raise RuntimeError('VM owner is closed')
                    self.stop(); self.clear_mutable_state(); result = self.start()
                elif operation == 'close':
                    self.closed = True; self.stop(); result = {'closed': True}
                else:
                    raise ValueError('unsupported VM operation')
            except Exception as error:
                # A lost HTTP response must not turn a retry of the same request
                # into another VM start/reset, including after a failed boot.
                self.responses[rid] = (encoded, {'error': type(error).__name__})
                raise
            self.responses[rid] = (encoded, result)
            return result


def serve():
    if os.getpid() != 1:
        raise RuntimeError('VM owner must be PID 1 in a dedicated Harbor service')
    owner = VMOwner()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'service_ready': True})

        def do_POST(self):
            if self.path != '/control':
                return self.reply(404, {'error': 'unknown route'})
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                return self.reply(413, {'error': 'request too large'})
            try:
                token = self.headers.get('Authorization', '').removeprefix('Bearer ')
                result = owner.control(token, json.loads(self.rfile.read(length)))
                self.reply(200, result)
            except PermissionError:
                self.reply(403, {'error': 'unauthorized or stale VM lease'})
            except Exception as error:
                # Do not echo private control credentials or task state.
                self.reply(500, {'error': type(error).__name__})

    def shutdown(*_):
        owner.closed = True
        owner.stop()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        ThreadingHTTPServer(('0.0.0.0', 8770), Handler).serve_forever()
    finally:
        owner.stop()


if __name__ == '__main__':
    serve()
