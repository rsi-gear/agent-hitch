"""Real owned child + Unix/HTTP + Harbor hooks, synthetic SDK/VM only."""
import asyncio
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'benchmark-packages/osworld/runtime'
sys.path.insert(0, str(RUNTIME))
from controller_client import control
from controller_lifecycle import LifecycleServer, NativeLifecycle
from lifecycle_client import hook
from runtime_config import SDK_COMMIT, digest, inventory, load_config, read_json, write_json

spec = importlib.util.spec_from_file_location('hitch_benchmark', ROOT / 'integrations/harbor/hitch_benchmark.py')
harbor = importlib.util.module_from_spec(spec); spec.loader.exec_module(harbor)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='oswl-', dir='/tmp')
        self.root = Path(self.temporary.name).resolve()
        self.runtimes, self.servers = [], []
        self.closed_sessions = []
        source = self.root / 'tasks'; source.mkdir()
        (source / 'task_031.py').write_text('# synthetic task, not an authorized release\n')
        sdk = self.root / 'sdk'; sdk.mkdir()
        (self.root / 'assets').mkdir()
        (sdk / 'core.py').write_text('# synthetic sdk core\n')
        self.config = {
            'protocol': 'osworld-controller@1', 'task_id': 'osworld-task-031', 'source_task_id': 'task_031',
            'profile_digest': 'sha256:' + 'a' * 64, 'sdk_root': str(sdk), 'sdk_commit': SDK_COMMIT,
            'task_path': str(source / 'task_031.py'), 'task_sha256': digest((source / 'task_031.py').read_bytes()),
            'assets_directory': str(self.root / 'assets'),
            **{key: str(self.root / name) for key, name in [('private_root', 'private'), ('session_directory', 'session'), ('evidence_directory', 'evidence'), ('cache_directory', 'cache')]},
            'max_steps': 3, 'max_actions_per_turn': 2, 'max_text_bytes': 16384, 'max_artifact_bytes': 1024 * 1024,
            'prepare_timeout_sec': 3, 'shutdown_timeout_sec': 1, 'sleep_after_execution': 0, 'native_deadline': True,
            'public_endpoint': 'http://controller:8765/', 'website_host_suffix': 'websites.private', 'client_password_file': None,
        }
        self.config_file = self.root / 'controller.json'

    def tearDown(self):
        for runtime in self.runtimes:
            try: runtime._cleanup(None)
            except Exception: pass
        for server, thread in self.servers:
            server.close(); thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(server.path.exists())
        self.temporary.cleanup()

    def start(self, mode='normal', close_vm=None):
        write_json(self.config_file, self.config)
        config_digest = digest(self.config_file.read_bytes())
        def close(session):
            self.closed_sessions.append(copy.deepcopy(session))
            return True
        runtime = NativeLifecycle(self.config, config_digest, self.config_file,
            worker_command=[sys.executable, str(ROOT / 'test-support/osworld_lifecycle_worker.py'), str(self.config_file), config_digest, mode], close_vm=close_vm or close)
        self.runtimes.append(runtime)
        server = LifecycleServer(runtime)
        thread = threading.Thread(target=server.server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True); thread.start()
        self.servers.append((server, thread))
        return runtime, server

    def request(self, phase, **overrides):
        return {'schema_version': '1', 'request_id': 'request_' + phase, 'phase': phase,
            'task_id': self.config['task_id'], 'logical_trial_id': 'synthetic-trial', 'execution_index': 0,
            'lease_id': 'lease_synthetic', 'epoch': 1, 'profile_digest': self.config['profile_digest'], 'input_refs': [], **overrides}

    def call(self, server, phase, **overrides):
        return hook(server.path, self.request(phase, **overrides), 8)

    def submit(self, runtime):
        binding = control(runtime.private / 'phase.sock', runtime.session, {'request_id': 'bind_candidate', 'operation': 'bind', 'parameters': {'generation': 1, 'run_id': 'run_' + '1' * 32}})['binding']
        request = Request(binding['endpoint'] + 'call', data=json.dumps({'name': 'desktop.submit', 'arguments': {'sequence': 1, 'request_id': 'action_done', 'response': '', 'actions': ['DONE']}}).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + binding['token']})
        with urlopen(request, timeout=3) as response:
            self.assertTrue(json.loads(response.read())['accepted'])
        return binding

    def test_harbor_hooks_freeze_after_exit_and_cleanup_replay(self):
        runtime, server = self.start()
        owner = self
        class Environment:
            session_id = 'synthetic-trial'
            _hitch_ownership_labels = {'io.hitch.lease-id': 'lease_synthetic', 'io.hitch.lease-epoch': '1'}
            trial_paths = types.SimpleNamespace(trial_dir=owner.root / 'harbor')
            async def service_exec(self, command, *, service, timeout_sec):
                owner.assertEqual(service, 'controller')
                child = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                out, err = await asyncio.wait_for(child.communicate(), timeout_sec)
                return types.SimpleNamespace(return_code=child.returncode, stdout=out.decode(), stderr=err.decode())
        config = {'task_id': self.config['task_id'], 'profile_digest': self.config['profile_digest'],
            'profile': {'budget': {'collection_timeout_ms': 8000}}, 'task': {
                'driver': {'kind': 'tool-server', 'config': {'native_phases': {'protocol': 'hitch-native-phase-control@2'}}},
                'lifecycle': {phase: {'target': 'service:controller', 'timeout_ms': 8000, 'argv': [sys.executable, str(RUNTIME / 'lifecycle_client.py'), '--socket', str(server.path), '--timeout-sec', '7']} for phase in ['prepare', 'quiesce', 'snapshot', 'cleanup']},
                'submission': {'paths': [str(runtime.evidence)], 'max_bytes': self.config['max_artifact_bytes']}}}
        session = harbor.BenchmarkSession(Environment(), config)
        async def run():
            await session.prepare()
            pid = runtime.worker.pid
            await session.prepare()
            owner.assertEqual(runtime.worker.pid, pid)
            binding = owner.submit(runtime)
            await session.snapshot()
            owner.assertEqual(runtime.worker.returncode, 0)
            await session.cleanup(); await session.cleanup()
            return binding
        binding = asyncio.run(run())
        snapshot = read_json(runtime.evidence / 'snapshot.json')
        self.assertIn('worker-exit.json', [entry['path'] for entry in snapshot['files']])
        for entry in snapshot['files']:
            data = (runtime.evidence / entry['path']).read_bytes()
            self.assertEqual((len(data), digest(data)), (entry['bytes'], entry['sha256']))
        files, size = inventory(runtime.evidence, self.config['max_artifact_bytes'])
        self.assertEqual(session.responses['snapshot']['output']['artifacts'][0]['bytes'], size)
        self.assertEqual(len(self.closed_sessions), 1)
        receipt = runtime.receipts[session.responses['snapshot']['request_id']]['response']
        self.assertEqual(hook(server.path, self.request('snapshot', request_id=receipt['request_id']), 3), receipt)
        self.assertEqual(inventory(runtime.evidence, self.config['max_artifact_bytes']), (files, size))
        exported = runtime.journal.read_bytes() + session.journal.read_bytes() + b''.join((runtime.evidence / f['path']).read_bytes() for f in files)
        for secret in [runtime.session['token'], binding['token']]: self.assertNotIn(secret.encode(), exported)
        self.assertFalse((runtime.private / 'phase.sock').exists())

    def test_foreign_lease_and_request_reuse_fail_without_restart(self):
        runtime, server = self.start()
        ready = self.call(server, 'prepare'); self.assertEqual(ready['status'], 'ok')
        self.assertEqual(self.call(server, 'prepare'), ready)
        for overrides in [{'epoch': 2}, {'lease_id': 'foreign'}, {'profile_digest': 'sha256:' + 'b' * 64}, {'execution_index': 1}, {'phase': 'cleanup'}]:
            self.assertEqual(hook(server.path, {**self.request('prepare'), **overrides}, 3)['status'], 'error')
        self.assertEqual(self.call(server, 'prepare', request_id='different_request')['status'], 'error')
        self.assertIsNone(runtime.worker.poll())
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')

    def test_snapshot_rejects_live_worker(self):
        runtime, server = self.start()
        self.assertEqual(self.call(server, 'prepare')['status'], 'ok')
        self.assertEqual(self.call(server, 'snapshot')['status'], 'error')
        self.assertFalse((runtime.evidence / 'snapshot.json').exists())
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')
        self.assertIsNotNone(runtime.worker.poll())
        self.assertFalse((runtime.evidence / 'native/result.json').exists())

    def test_worker_crash_after_action_cannot_quiesce_or_snapshot(self):
        runtime, server = self.start('crash-after-action')
        self.assertEqual(self.call(server, 'prepare')['status'], 'ok'); self.submit(runtime)
        (runtime.private / 'crash-now').touch()
        runtime.worker.wait(timeout=3)
        self.assertEqual(self.call(server, 'quiesce')['status'], 'error')
        self.assertEqual(self.call(server, 'snapshot')['status'], 'error')
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')

    def test_failed_prepare_replays_failure_and_closes_vm(self):
        runtime, server = self.start('crash-before-ready')
        failed = self.call(server, 'prepare'); self.assertEqual(failed['status'], 'error')
        self.assertEqual(self.call(server, 'prepare'), failed)
        self.assertTrue(runtime.closed)
        self.assertEqual(len(self.closed_sessions), 1)
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')
        self.assertEqual(len(self.closed_sessions), 1)

    def test_configuration_change_before_observation_rejected(self):
        runtime, server = self.start('wrong-config')
        self.assertEqual(self.call(server, 'prepare')['output'], {'error_code': 'native_worker_configuration_mismatch'})
        self.assertTrue(runtime.closed); self.assertIsNotNone(runtime.worker.poll())

    def test_cleanup_during_prepare_prevents_late_readiness(self):
        runtime, server = self.start('wait-before-ready')
        outputs = []
        thread = threading.Thread(target=lambda: outputs.append(self.call(server, 'prepare'))); thread.start()
        deadline = time.monotonic() + 2
        while runtime.worker is None and time.monotonic() < deadline: time.sleep(0.01)
        self.assertIsNotNone(runtime.worker)
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')
        thread.join(5); self.assertFalse(thread.is_alive())
        self.assertEqual(outputs[0]['status'], 'error'); self.assertIsNotNone(runtime.worker.poll())

    def test_unresponsive_worker_is_killed_and_reaped(self):
        runtime, server = self.start('ignore-stop')
        self.assertEqual(self.call(server, 'prepare')['status'], 'ok')
        self.assertEqual(self.call(server, 'cleanup')['status'], 'ok')
        self.assertEqual(runtime.worker.returncode, -signal.SIGKILL)

    def test_vm_close_error_is_recorded_without_error_message_or_token(self):
        def failure(session): raise RuntimeError('secret ' + session['token'])
        runtime, server = self.start(close_vm=failure)
        self.assertEqual(self.call(server, 'prepare')['status'], 'ok')
        failed = self.call(server, 'cleanup'); self.assertEqual(failed['status'], 'error')
        self.assertEqual(self.call(server, 'cleanup'), failed)
        receipt = read_json(runtime.journal)['phases']['resource_cleanup']
        self.assertEqual(receipt, {'sdk_stopped': True, 'vm_closed': False, 'error_types': ['RuntimeError']})
        self.assertNotIn(runtime.session['token'], runtime.journal.read_text())

    def test_prepare_accepts_empty_volume_mount_points(self):
        for key in ('evidence_directory', 'cache_directory'):
            Path(self.config[key]).mkdir(mode=0o755)
        runtime, server = self.start()
        self.assertEqual(self.call(server, 'prepare')['status'], 'ok')
        for key in ('evidence_directory', 'cache_directory'):
            self.assertEqual(Path(self.config[key]).stat().st_mode & 0o777, 0o700)
        self.submit(runtime)
        self.assertEqual(self.call(server, 'quiesce')['status'], 'ok')
        self.assertEqual(self.call(server, 'snapshot')['status'], 'ok')

    def test_prepare_rejects_prior_volume_evidence_before_spawning_worker(self):
        directory = Path(self.config['evidence_directory']); directory.mkdir()
        stale = directory / 'prior-result'; stale.write_text('previous task evidence')
        runtime, server = self.start()
        result = self.call(server, 'prepare')
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['output']['error_code'], 'native_runtime_directory_not_empty')
        self.assertIsNone(runtime.worker)
        self.assertEqual(stale.read_text(), 'previous task evidence')

    def test_prepare_rejects_linked_cache_mount(self):
        target = self.root / 'unrelated-cache'; target.mkdir()
        Path(self.config['cache_directory']).symlink_to(target)
        runtime, server = self.start()
        self.assertEqual(self.call(server, 'prepare')['status'], 'error')
        self.assertIsNone(runtime.worker)
        self.assertEqual(list(target.iterdir()), [])

    def test_config_pins_and_paths_and_bounded_inventory(self):
        def load(value):
            write_json(self.config_file, value)
            with patch('runtime_config.SDK_FILES', {'core.py': hashlib.sha256((self.root / 'sdk/core.py').read_bytes()).hexdigest()}):
                return load_config(self.config_file)
        self.assertEqual(load(self.config)[0], self.config)
        explicit = {**self.config, 'screenshot_http_timeout_sec': 120}
        self.assertEqual(load(explicit), (explicit, digest(self.config_file.read_bytes())))
        for timeout in (None, True, 9, 121, '120', 120.0):
            with self.assertRaises(ValueError): load({**self.config, 'screenshot_http_timeout_sec': timeout})
        for change in [{'sdk_commit': '0' * 40}, {'task_sha256': 'sha256:' + 'b' * 64}, {'max_steps': True}, {'website_host_suffix': ''}, {'evidence_directory': self.config['sdk_root']}, {'assets_directory': str(self.root / 'missing')}, {'cache_directory': str(self.root / 'assets')}]:
            with self.assertRaises(ValueError): load({**self.config, **change})
        evidence = Path(self.config['evidence_directory']); evidence.mkdir()
        secret = evidence / 'secret'; secret.write_text('private-password')
        with self.assertRaises(ValueError): load({**self.config, 'client_password_file': str(secret)})
        alias = evidence / 'linked'; alias.symlink_to(secret)
        with self.assertRaises(ValueError): inventory(evidence, 1000)
        alias.unlink(); os.link(secret, alias)
        with self.assertRaises(ValueError): inventory(evidence, 1000)
        alias.unlink()
        with self.assertRaises(ValueError): inventory(evidence, 1)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(LifecycleTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    print('OSWorld lifecycle child ownership, Harbor hooks, immutable snapshot and failure receipts passed (synthetic only)')
