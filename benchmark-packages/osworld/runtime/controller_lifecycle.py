"""Harbor lifecycle owner for one SDK child process and one leased VM service.

This daemon is PID 1 in the private controller service. Candidate tools live in
the SDK child; lifecycle RPC is filesystem-local and never a candidate tool.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import signal
import socketserver
import subprocess
import sys
import threading
import time
import uuid

from controller_client import control
from controller_server import strict_json
from runtime_config import digest, inventory, load_config, read_json, write_json
from vm_owner import VMOwner
from vm_provider import ManagedVMProvider, create_private_session


class LifecycleFailure(RuntimeError):
    pass


class NativeLifecycle:
    def __init__(self, config, config_digest, config_path, *, worker_command=None, close_vm=None):
        self.config, self.config_digest = copy.deepcopy(config), config_digest
        self.private = Path(config['private_root'])
        self.private.mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.private.is_symlink() or self.private.stat().st_mode & 0o077 or any(self.private.iterdir()):
            raise ValueError('controller needs a fresh private runtime directory')
        self.evidence = Path(config['evidence_directory'])
        self.command = worker_command or [sys.executable, str(Path(__file__).with_name('native_worker.py')), '--config', str(config_path)]
        self.close_vm = close_vm or (lambda session: ManagedVMProvider(session, timeout=config['shutdown_timeout_sec']).request('close').get('closed') is True)
        self.lock, self.stop_lock = threading.RLock(), threading.Lock()
        self.cleanup_lock = threading.Lock()
        self.receipts, self.phases = {}, {}
        self.identity = self.session = self.worker = None
        self.closed = self.quiesced = False
        self.stop_event = threading.Event()
        self.journal = self.private / 'lifecycle.json'

    def _save(self):
        write_json(self.journal, {'protocol': 'osworld-lifecycle@1', 'config_digest': self.config_digest,
                   'identity': self.identity, 'closed': self.closed, 'quiesced': self.quiesced,
                   'phases': self.phases, 'receipts': self.receipts})

    def _validate(self, request):
        fields = {'schema_version', 'request_id', 'phase', 'task_id', 'logical_trial_id', 'execution_index', 'lease_id', 'epoch', 'profile_digest', 'input_refs'}
        if not isinstance(request, dict) or set(request) != fields or request['schema_version'] != '1':
            raise ValueError('invalid lifecycle envelope')
        if request['task_id'] != self.config['task_id'] or request['profile_digest'] != self.config['profile_digest'] or request['input_refs'] != []:
            raise ValueError('lifecycle differs from frozen task/profile')
        if type(request['epoch']) is not int or request['epoch'] < 1 or type(request['execution_index']) is not int or request['execution_index'] != 0:
            raise ValueError('invalid lifecycle epoch/execution')
        for field in ['request_id', 'logical_trial_id', 'lease_id']:
            if not isinstance(request[field], str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,256}', request[field]):
                raise ValueError('invalid lifecycle identity')
        if request['phase'] not in ['prepare', 'quiesce', 'snapshot', 'cleanup']:
            raise ValueError('unknown lifecycle phase')
        identity = {k: request[k] for k in ['task_id', 'logical_trial_id', 'lease_id', 'epoch', 'profile_digest']}
        if self.identity is not None and self.identity != identity:
            raise PermissionError('stale lifecycle lease')
        return identity

    def call(self, request):
        with self.lock:
            identity = self._validate(request)
            rid, phase = request['request_id'], request['phase']
            request_digest = digest(json.dumps(request, sort_keys=True).encode())
            if rid in self.receipts:
                old = self.receipts[rid]
                if old['request_digest'] != request_digest:
                    raise ValueError('lifecycle identity reused with a different request')
                if old['response'] is None:
                    raise LifecycleFailure('lifecycle_request_in_progress')
                return copy.deepcopy(old['response'])
            if phase in self.phases:
                raise LifecycleFailure('lifecycle_phase_already_requested')
            if self.identity is None:
                if phase not in ['prepare', 'cleanup']:
                    raise LifecycleFailure('lifecycle_not_prepared')
                self.identity = identity
            if self.closed and phase != 'cleanup':
                raise LifecycleFailure('controller_closed')
            self.phases[phase] = {'status': 'running', 'request_id': rid}
            self.receipts[rid] = {'request_digest': request_digest, 'response': None}
            self._save()
        try:
            output = getattr(self, '_' + phase)(request)
            response = {'schema_version': '1', 'request_id': rid, 'status': 'ok', 'output': output}
        except BaseException as error:
            code = str(error) if isinstance(error, LifecycleFailure) else type(error).__name__
            response = {'schema_version': '1', 'request_id': rid, 'status': 'error', 'output': {'error_code': code}}
            if phase == 'prepare':
                try: self._cleanup(request)
                except BaseException: pass
        with self.lock:
            self.phases[phase]['status'] = response['status']
            self.receipts[rid]['response'] = response
            self._save()
        return copy.deepcopy(response)

    def _state(self):
        return control(self.private / 'phase.sock', self.session, {'request_id': 'lifecycle_' + uuid.uuid4().hex, 'operation': 'state', 'parameters': {}})

    def _prepare(self, request):
        with self.lock:
            if self.closed:
                raise LifecycleFailure('controller_closed')
            self.session = create_private_session(self.config['session_directory'], request)
            self.evidence.mkdir(parents=True, mode=0o700, exist_ok=False)
            Path(self.config['cache_directory']).mkdir(parents=True, mode=0o700, exist_ok=False)
            with (self.private / 'worker.stdout.log').open('xb') as stdout, (self.private / 'worker.stderr.log').open('xb') as stderr:
                self.worker = subprocess.Popen(self.command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
            self._save()
        deadline = time.monotonic() + self.config['prepare_timeout_sec']
        while time.monotonic() < deadline and not self.stop_event.is_set():
            if self.worker.poll() is not None:
                raise LifecycleFailure('native_worker_exited_before_ready')
            try:
                state = self._state()
                if state['state'] in ['failed', 'cancelled', 'completed']:
                    raise LifecycleFailure('native_worker_did_not_produce_candidate_observation')
                if state['state'] == 'context_required' and state['generation'] == 1 and state['run_id'] is None and state['prediction'] is not None:
                    if read_json(self.private / 'worker-status.json').get('config_digest') != self.config_digest:
                        raise LifecycleFailure('native_worker_configuration_mismatch')
                    with self.lock:
                        if self.closed: raise LifecycleFailure('controller_closed')
                    return {'ready': True, 'native_phases_ready': True, 'native_deadline_ready': self.config['native_deadline']}
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            self.stop_event.wait(0.05)
        raise LifecycleFailure('native_prepare_timeout_or_cancelled')

    def _stop_worker(self):
        with self.stop_lock:
            process = self.worker
            if process is not None and process.poll() is None:
                try: os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError: pass
                try: process.wait(timeout=self.config['shutdown_timeout_sec'])
                except subprocess.TimeoutExpired:
                    try: os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    process.wait(timeout=self.config['shutdown_timeout_sec'])
            if os.getpid() == 1:
                # SDK helpers may daemonize. PID 1 in this dedicated service owns
                # adopted descendants as well as the original SDK process group.
                owner = VMOwner()
                owner.stop()
                if owner.children():
                    raise LifecycleFailure('native_helpers_still_running')
            return process.returncode if process is not None else None

    def _quiesce(self, _request):
        if self.phases.get('prepare', {}).get('status') != 'ok' or self.closed:
            raise LifecycleFailure('native_prepare_not_complete')
        deadline = time.monotonic() + self.config['shutdown_timeout_sec']
        while time.monotonic() < deadline:
            if self.closed: raise LifecycleFailure('controller_closed')
            try: status = read_json(self.private / 'worker-status.json')
            except FileNotFoundError: status = {'state': 'starting'}
            if status.get('state') == 'completed' and status.get('config_digest') == self.config_digest:
                if self._state()['state'] != 'completed':
                    raise LifecycleFailure('native_completion_mismatch')
                break
            if status.get('state') == 'failed' or self.worker.poll() is not None:
                raise LifecycleFailure('native_execution_failed')
            time.sleep(0.02)
        else: raise LifecycleFailure('native_completion_not_persisted')
        if self._stop_worker() != 0:
            raise LifecycleFailure('native_worker_quiesce_failed')
        with self.lock:
            if self.closed: raise LifecycleFailure('controller_closed')
            self.quiesced = True
        return {'quiesced': True}

    def _snapshot(self, _request):
        with self.lock:
            return self._freeze_evidence()

    def _freeze_evidence(self):
        if not self.quiesced or self.phases.get('quiesce', {}).get('status') != 'ok' or self.closed:
            raise LifecycleFailure('native_evidence_is_not_quiescent')
        files, size = inventory(self.evidence, self.config['max_artifact_bytes'])
        if not files or (self.evidence / 'snapshot.json').exists():
            raise LifecycleFailure('native_snapshot_missing_or_already_exists')
        write_json(self.evidence / 'snapshot.json', {'protocol': 'osworld-controller-snapshot@1', 'identity': self.identity,
                   'config_digest': self.config_digest, 'source_task_id': self.config['source_task_id'], 'task_sha256': self.config['task_sha256'], 'files': files})
        size += (self.evidence / 'snapshot.json').stat().st_size
        if size > self.config['max_artifact_bytes']:
            raise LifecycleFailure('native_snapshot_exceeds_package_limit')
        return {'artifacts': [{'path': self.config['evidence_directory'], 'bytes': size}]}

    def _cleanup(self, _request):
        with self.cleanup_lock:
            return self._close_resources()

    def _close_resources(self):
        with self.lock:
            self.closed = True; self.stop_event.set()
            prior = self.phases.get('resource_cleanup', {})
            if prior.get('sdk_stopped') is True and prior.get('vm_closed') is True:
                return {'cleaned': True}
        stopped, vm_closed, errors = False, False, []
        try:
            if self.session and self.worker and self.worker.poll() is None:
                try: control(self.private / 'phase.sock', self.session, {'request_id': 'cancel_' + uuid.uuid4().hex, 'operation': 'cancel', 'parameters': {}})
                except Exception: pass
            self._stop_worker(); stopped = True
        except BaseException as error:
            errors.append(type(error).__name__)
        try:
            vm_closed = self.close_vm(self.session) if self.session else True
        except BaseException as error:
            errors.append(type(error).__name__)
        with self.lock:
            self.phases['resource_cleanup'] = {'sdk_stopped': stopped, 'vm_closed': vm_closed is True, 'error_types': errors}
            self._save()
        if not stopped or vm_closed is not True:
            raise LifecycleFailure('controller_cleanup_incomplete')
        return {'cleaned': True}


class LifecycleServer:
    def __init__(self, runtime):
        self.runtime = runtime
        self.path = runtime.private / 'lifecycle.sock'
        if self.path.exists() or self.path.is_symlink():
            raise ValueError('cannot adopt a lifecycle socket')
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(10)
                rid = None
                try:
                    line = self.rfile.readline(65537)
                    if len(line) > 65536 or not line.endswith(b'\n'): raise ValueError()
                    request = strict_json(line); rid = request.get('request_id') if isinstance(request, dict) else None
                    response = runtime.call(request)
                except Exception as error:
                    response = {'schema_version': '1', 'request_id': rid, 'status': 'error', 'output': {'error_code': type(error).__name__}}
                try: self.wfile.write(json.dumps(response, allow_nan=False).encode() + b'\n')
                except (BrokenPipeError, ConnectionError): pass
        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = True
            def handle_error(self, *_): pass
        self.server = Server(str(self.path), Handler)
        os.chmod(self.path, 0o600)
        self.inode = self.path.stat().st_ino

    def close(self):
        self.server.shutdown(); self.server.server_close()
        if self.path.exists() and self.path.stat().st_ino == self.inode:
            self.path.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if os.getpid() != 1:
        raise RuntimeError('controller lifecycle must be PID 1 in its dedicated service')
    config, config_digest = load_config(args.config)
    runtime = NativeLifecycle(config, config_digest, args.config)
    server = LifecycleServer(runtime)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    thread = threading.Thread(target=server.server.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
    thread.start()
    try: stopped.wait()
    finally:
        try: runtime._cleanup(None)
        finally: server.close(); thread.join(2)


if __name__ == '__main__':
    try: main()
    except Exception:
        sys.stderr.write('controller lifecycle failed\n'); sys.exit(1)
