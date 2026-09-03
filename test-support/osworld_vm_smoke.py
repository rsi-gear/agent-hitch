"""Synthetic process/lease checks; this is not an OSWorld VM execution."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path('benchmark-packages/osworld/runtime') / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


vm = load('vm_owner'); provider = load('vm_provider')
with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'KVM': 'N', 'VM_BOOT_TIMEOUT_SEC': '2', 'MONITOR': 'telnet:0.0.0.0:7100,server,nowait', 'SERIAL': 'mon:stdio'}):
    root = Path(directory)
    hook = {'lease_id': 'lease-test', 'epoch': 1, 'logical_trial_id': 'trial-test'}
    session = provider.create_private_session(root / 'control', hook)
    assert provider.create_private_session(root / 'control', hook) == session
    try:
        provider.create_private_session(root / 'control', {**hook, 'epoch': 2})
        raise AssertionError('foreign epoch adopted control volume')
    except ValueError:
        pass
    base = root / 'base.qcow2'; base.write_bytes(b'synthetic base; not a bootable VM')
    witness = root / 'launch-environment.json'
    command = (sys.executable, '-c', 'import json,os,sys,time; temporary=sys.argv[1]+".tmp"; open(temporary, "w").write(json.dumps({key:os.environ.get(key) for key in ["MONITOR","SERIAL"]})); os.replace(temporary,sys.argv[1]); time.sleep(60)', str(witness))
    owner = vm.VMOwner(root / 'control/session.json', root / 'storage', base, root / 'overlay', command)
    request = {'request_id': 'start-one', 'operation': 'start', 'lease_id': hook['lease_id'], 'epoch': 1}
    class Ready:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def read(self, size): return b'\x89PNG\r\n\x1a\n'
    try:
        with patch.object(vm, 'urlopen', return_value=Ready()):
            assert owner.control(session['token'], request)['ready']
            process = owner.process
            assert process.poll() is None
            deadline = time.monotonic() + 5
            while not witness.exists() and time.monotonic() < deadline: time.sleep(.01)
            assert json.loads(witness.read_text()) == {'MONITOR': 'none', 'SERIAL': 'stdio'}
            assert owner.control(session['token'], request)['generation'] == 1
            assert owner.process.pid == process.pid
            for token, value in [('wrong-token', request), (session['token'], {**request, 'epoch': 2})]:
                try:
                    owner.control(token, value)
                    raise AssertionError('unauthorized request accepted')
                except PermissionError:
                    pass
            (root / 'storage/changed').write_text('guest mutation')
            assert owner.control(session['token'], {**request, 'request_id': 'reset-one', 'operation': 'reset'})['generation'] == 2
            assert process.poll() is not None and not (root / 'storage/changed').exists()
            assert base.read_bytes() == b'synthetic base; not a bootable VM'
            process = owner.process
            assert owner.control(session['token'], {**request, 'request_id': 'close-one', 'operation': 'close'})['closed']
            assert process.poll() is not None
    finally:
        owner.stop()
    failed = vm.VMOwner(root / 'control/session.json', root / 'failed-storage', base, root / 'failed-overlay', (sys.executable, '-c', 'raise SystemExit(17)'))
    with patch.object(vm, 'urlopen', side_effect=OSError('synthetic guest unavailable')):
        for _ in range(2):
            try:
                failed.control(session['token'], request)
                raise AssertionError('failed emulator became ready')
            except RuntimeError:
                pass
        assert failed.generation == 1 and failed.process is None
    print('OSWorld VM ownership, stale lease, idempotent reset and failed-boot receipts passed (synthetic only)')
