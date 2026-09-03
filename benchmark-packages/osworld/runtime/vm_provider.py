"""OSWorld DesktopEnv provider for an already Harbor-owned VM service."""
import json
import ipaddress
import os
from pathlib import Path
import re
import secrets
import socket
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

_factory_lock = threading.Lock()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RuntimeError('VM control redirects are forbidden')


def create_private_session(directory, hook_request):
    """Publish an atomic, per-lease secret on a private controller/VM volume."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / 'session.json'
    identity = {k: hook_request[k] for k in ['lease_id', 'epoch', 'logical_trial_id']}
    if not identity['lease_id'] or type(identity['epoch']) is not int or identity['epoch'] < 1:
        raise ValueError('invalid VM lease identity')
    value = {**identity, 'token': secrets.token_hex(32)}
    fd, temporary = tempfile.mkstemp(prefix='.session-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush(); os.fsync(stream.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            if target.is_symlink():
                raise ValueError('private session must not be a symlink')
            value = json.loads(target.read_text())
            if any(value.get(k) != v for k, v in identity.items()):
                raise ValueError('control volume belongs to another trial or lease')
    finally:
        Path(temporary).unlink(missing_ok=True)
    return value


class ManagedVMProvider:
    def __init__(self, session, endpoint='http://vm:8770', guest_host='vm', timeout=330):
        parsed = urlparse(endpoint)
        if parsed.scheme != 'http' or not re.fullmatch(r'[a-z][a-z0-9_-]*', parsed.hostname or '') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ['', '/']:
            raise ValueError('VM endpoint must be a private Compose service')
        if not re.fullmatch(r'[a-z][a-z0-9_-]*', guest_host):
            raise ValueError('invalid private guest service')
        if not 1 <= timeout <= 1830:
            raise ValueError('invalid VM control timeout')
        self.session, self.endpoint, self.guest_host, self.timeout = session, endpoint.rstrip('/'), guest_host, timeout
        self.counter = 0

    def request(self, operation):
        self.counter += 1
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.session['lease_id']}:{self.session['epoch']}:{operation}:{self.counter}"))
        payload = {k: self.session[k] for k in ['lease_id', 'epoch']}
        payload.update(operation=operation, request_id=request_id)
        self.last_request = payload
        request = Request(self.endpoint + '/control', data=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.session['token']})
        # No implicit retry: a timed-out operation has an unknown outcome. A
        # caller must retain its receipt/identity before retrying the transport.
        try:
            with build_opener(NoRedirect).open(request, timeout=self.timeout) as response:
                data = response.read(8193)
                if len(data) > 8192:
                    raise RuntimeError('oversized VM control response')
                return json.loads(data)
        except HTTPError as error:
            raise RuntimeError(f'VM control {operation} returned HTTP {error.code}') from None

    def start_emulator(self, path_to_vm, headless, os_type='Ubuntu'):
        if path_to_vm != '/System.qcow2' or os_type != 'Ubuntu':
            raise ValueError('provider only supports the locked Ubuntu VM image')
        result = self.request('start')
        if result.get('ready') is not True:
            raise RuntimeError('VM owner did not confirm guest readiness')

    def get_ip_address(self, path_to_vm):
        # Chrome DevTools rejects a DNS name in the HTTP Host header. Resolve
        # the private Compose service for native SDK traffic; keep lifecycle
        # control addressed by the fenced service name. Re-resolve after reset.
        addresses = {item[4][0] for item in socket.getaddrinfo(
            self.guest_host, None, family=socket.AF_INET, type=socket.SOCK_STREAM)}
        if len(addresses) != 1:
            raise ValueError('VM service must resolve to one private IPv4 address')
        address = ipaddress.IPv4Address(addresses.pop())
        private_ranges = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        if not any(address in ipaddress.IPv4Network(network) for network in private_ranges):
            raise ValueError('VM service must resolve inside its private Compose network')
        return f'{address}:5000:9222:8006:8080'

    def revert_to_snapshot(self, path_to_vm, snapshot_name):
        result = self.request('reset')
        if result.get('ready') is not True:
            raise RuntimeError('VM owner did not confirm a fresh guest')
        return path_to_vm

    def stop_emulator(self, path_to_vm, *args, **kwargs):
        if self.request('close').get('closed') is not True:
            raise RuntimeError('VM owner did not confirm shutdown')

    def prepare_volume(self, path_to_vm, volume_size, os_type):
        if volume_size is not None:
            raise NotImplementedError('custom guest volume expansion is not implemented')

    def finalize_volume(self, *args, **kwargs):
        pass

    def save_state(self, *args, **kwargs):
        raise NotImplementedError('persisted VM checkpoint export is not implemented')


def create_desktop_env(session, *, screenshot_http_timeout_sec=10, **kwargs):
    """Use the pinned upstream constructor without copying its setup/eval logic.

    The factory substitution is restricted to construction in a dedicated
    single-trial controller process; the original factory is always restored.
    Explicit path_to_vm means DesktopEnv never calls a host VM manager.
    """
    import desktop_env.desktop_env as sdk
    from screenshot_transport import configure_screenshot_transport, validate_screenshot_timeout
    validate_screenshot_timeout(screenshot_http_timeout_sec)
    if any(k in kwargs for k in ['provider_name', 'path_to_vm', 'require_a11y_tree', 'require_terminal']):
        raise ValueError('caller cannot override the managed screenshot-only provider')
    provider = ManagedVMProvider(session)
    environment_class = sdk.DesktopEnv
    if screenshot_http_timeout_sec != 10:
        class ScreenshotTransportEnv(sdk.DesktopEnv):
            def _start_emulator(self):
                super()._start_emulator()
                # Upstream constructs a new PythonController on every reset.
                configure_screenshot_transport(self.controller, screenshot_http_timeout_sec)
        environment_class = ScreenshotTransportEnv
    with _factory_lock:
        original = sdk.create_vm_manager_and_provider
        def factory(provider_name, *_args, **_kwargs):
            if provider_name != 'docker':
                raise ValueError('unexpected upstream provider selection')
            return None, provider
        sdk.create_vm_manager_and_provider = factory
        try:
            return environment_class(provider_name='docker', path_to_vm='/System.qcow2',
                require_a11y_tree=False, require_terminal=False, **kwargs)
        finally:
            sdk.create_vm_manager_and_provider = original
