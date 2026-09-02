"""Pinned native phase-runner control-flow test with a synthetic environment.

No gated OSWorld task, guest VM, model request or benchmark score is represented.
"""
import base64
import hashlib
import importlib.util
import json
import logging
from pathlib import Path
import struct
import tempfile
import threading
import types
from unittest.mock import patch
import zlib


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


channel_module = module('agent_channel', 'benchmark-packages/osworld/runtime/agent_channel.py')
policy_module = module('action_policy', 'benchmark-packages/osworld/runtime/action_policy.py')
runner_module = module('native_runner', 'benchmark-packages/osworld/runtime/native_runner.py')
fixture = Path('test-support/fixtures/osworld/native_phases.py')
provenance = json.loads(fixture.with_name('provenance.json').read_text())
assert hashlib.sha256(fixture.read_bytes()).hexdigest() == provenance['fixture_sha256']
assert runner_module.SDK_COMMIT == provenance['commit'] and runner_module.RUNNER_SHA256 == provenance['source_sha256']
action_file = fixture.with_name('native_actions.py')
assert hashlib.sha256(action_file.read_bytes()).hexdigest() == provenance['additional_unmodified_files'][0]['sha256']
assert policy_module.ACTIONS_SHA256 == provenance['additional_unmodified_files'][0]['sha256']
actions = module('native_actions', action_file)
policy = policy_module.GraphicalActionPolicy(actions.ACTION_SPACE)
policy(['DONE', {'action_type': 'CLICK', 'parameters': {'x': 200.5, 'y': 100, 'button': 'left'}}, {'action_type': 'HOTKEY', 'keys': ['ctrl', 'c']}, {'action_type': 'TYPING', 'text': 'literal text; $(not a host command)'}])
for bad in ['pyautogui.click(10, 20)', {'action_type': 'EXECUTE', 'command': 'echo forbidden'}, {'action_type': 'CLICK', 'x': True, 'y': 1}, {'action_type': 'CLICK', 'x': 1}, {'action_type': 'CLICK', 'x': float('nan'), 'y': 1}, {'action_type': 'HOTKEY', 'keys': ['invalid_key']}, {'action_type': 'CLICK', 'x': 2000, 'y': 1}]:
    try: policy([bad]); raise AssertionError('invalid graphical action accepted')
    except ValueError: pass
native = module('native_phases', fixture)
native.logger = logging.getLogger('synthetic-osworld')
native.datetime = __import__('datetime')
native.json, native.os = json, __import__('os')
native.DEFAULT_USER_RESPONSE = 'synthetic user response'
native.log_task_completion = lambda *_args: None
native.GuestMemoryTracer = lambda *_args: types.SimpleNamespace(capture=lambda *_a, **_k: None)


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 40, 30, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x11\x22\x33' * 40) * 30)) + chunk(b'IEND', b'')


def validate_actions(actions):
    if any(action not in ['WAIT', 'DONE'] for action in actions):
        raise ValueError('synthetic action policy rejected input')


class Environment:
    def __init__(self):
        self.resets, self.setups, self.actions, self.recordings = 0, [], [], []
        self.enable_proxy, self.user_simulator = False, None
        self.action_history, self._step_no, self._traj_no = [], 0, 0
        self.setup_controller = object()
        self.controller = types.SimpleNamespace(start_recording=lambda: self.recordings.append('start'), end_recording=lambda p: self.recordings.append('end'))
    def reset(self, task_config):
        self.resets += 1
    def _get_obs(self):
        return dict(screenshot=png, accessibility_tree=None, terminal=None)
    def step(self, action, pause):
        self._step_no += 1
        self.action_history.append(action)
        self.actions.append((self.instruction, action, pause))
        return self._get_obs(), 0, action == 'DONE', {}


class Task(dict):
    proxy = False
    def __init__(self, env, gated):
        self.env, self.gated = env, gated
    def get_phases(self):
        return [dict(name='first', instruction='first instruction', evaluate=lambda _env: 0.25, gate_min_score=0.3 if self.gated else None),
                dict(name='second', instruction='second instruction', setup=lambda *_a, **_k: self.env.setups.append('second'), evaluate=lambda _env: 0.5)]


def run_case(root, gated, batch):
    env = Environment(); channel = channel_module.AgentChannel(root / 'channel', (40, 30), validate_actions, max_actions_per_turn=2, max_text_bytes=4096)
    waits = []; native.time = types.SimpleNamespace(sleep=lambda seconds: waits.append(seconds), perf_counter=lambda: 0)
    results = root / 'results'; results.mkdir()
    scores, errors = [], []
    def run():
        try:
            native._run_multi_phase_task_example(channel, env, Task(env, gated), 1, types.SimpleNamespace(sleep_after_execution=2), str(results), scores, None)
            channel.finish('completed')
        except BaseException as error:
            errors.append(error); channel.finish('failed')
    thread = threading.Thread(target=run); thread.start()
    tokens, generations = [], []
    try:
        for generation in range(1, 2 if gated else 3):
            with channel.condition:
                assert channel.condition.wait_for(lambda: channel.pending is not None and channel.generation == generation or errors, timeout=3)
                assert not errors
                if generation > 1:
                    try: channel.observe(tokens[-1]); raise AssertionError('old phase observed new screenshot')
                    except PermissionError: pass
                    try: channel.bind_context(generation, 'run_' + '1'.zfill(32)); raise AssertionError('reused candidate context')
                    except ValueError: pass
                token = channel.bind_context(generation, 'run_' + str(generation).zfill(32)); tokens.append(token)
                assert channel.bind_context(generation, 'run_' + str(generation).zfill(32)) == token
                observed = channel.observe(token)
                assert base64.b64decode(observed['content'][1]['data']) == png
                metadata = json.loads(observed['content'][0]['text']); generations.append(metadata['generation'])
                assert set(metadata) == {'generation', 'sequence', 'instruction', 'user_response', 'width', 'height'}
                seq = metadata['sequence']
                try: channel.submit(token, seq - 1, 'stale_request', '', batch); raise AssertionError('accepted stale observation')
                except ValueError: pass
                try: channel.submit(token, seq, 'invalid_action', '', ['EXECUTE']); raise AssertionError('accepted forbidden action')
                except ValueError: pass
                submitted = list(batch)
                receipt = channel.submit(token, seq, 'valid_request', '', submitted)
                assert channel.submit(token, seq, 'valid_request', '', submitted) == receipt
                try: channel.submit(token, seq, 'valid_request', 'changed', submitted); raise AssertionError('reused request with different payload')
                except ValueError: pass
                submitted.append('EXECUTE')  # must not mutate the already copied SDK response
        thread.join(3); assert not thread.is_alive() and not errors
        assert env.resets == 1 and env.recordings == ['start', 'end']
        assert scores == ([0.25] if gated else [0.75])
        assert env.setups == ([] if gated else ['second'])
        assert generations == ([1] if gated else [1, 2])
        assert waits == ([60] if gated else [60, 5])
        assert len(env.actions) == len(batch) * len(generations)
        assert all(action in ['WAIT', 'DONE'] and pause == 2 for _, action, pause in env.actions)
        assert len(list((root / 'channel').glob('observation-*.png'))) == len(generations)
        audit = (root / 'channel/channel.jsonl').read_text()
        assert all(token not in audit for token in tokens)
    finally:
        channel.finish('cancelled'); thread.join(3)


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    for name, gated, batch in [('normal', False, ['DONE']), ('gated', True, ['DONE']), ('budget', False, ['WAIT', 'WAIT'])]:
        case = root / name; case.mkdir(); run_case(case, gated, batch)
    channel = channel_module.AgentChannel(root / 'cancel', (40, 30), validate_actions, max_actions_per_turn=1, max_text_bytes=4096)
    channel.reset(); errors = []
    def predict():
        try: channel.predict('instruction', dict(screenshot=png))
        except channel_module.ChannelClosed as error: errors.append(error)
    thread = threading.Thread(target=predict); thread.start()
    with channel.condition:
        assert channel.condition.wait_for(lambda: channel.pending is not None, 3)
    channel.finish('cancelled'); thread.join(3)
    assert not thread.is_alive() and len(errors) == 1
    # A pinned-source preflight error must also close a waiting candidate. It
    # must not import or execute an unverified SDK module before failing.
    channel = channel_module.AgentChannel(root / 'bad-runner', (40, 30), validate_actions, max_actions_per_turn=1, max_text_bytes=4096)
    channel.reset(); errors = []
    thread = threading.Thread(target=predict); thread.start()
    with channel.condition:
        assert channel.condition.wait_for(lambda: channel.pending is not None, 3)
    wrong_source = root / 'wrong_runner.py'; wrong_source.write_text('raise RuntimeError("must not execute")\n')
    env = types.SimpleNamespace(require_a11y_tree=False, require_terminal=False, action_space='computer_13')
    with patch.object(runner_module.importlib.util, 'find_spec', return_value=types.SimpleNamespace(origin=str(wrong_source))), patch.object(runner_module.importlib, 'import_module') as imported:
        try:
            runner_module.run_native(channel, env, {}, 1, None, root / 'never-results')
            raise AssertionError('unverified native runner accepted')
        except RuntimeError as error:
            assert 'differs from the locked' in str(error)
        imported.assert_not_called()
    thread.join(3)
    assert not thread.is_alive() and len(errors) == 1
    assert channel.management_state()['state'] == 'failed' and not (root / 'never-results').exists()
print('OSWorld native phase/reset/gate/batch-budget channel parity passed (synthetic only)')
