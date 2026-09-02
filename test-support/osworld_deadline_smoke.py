"""Actual pinned SDK loop/grade behavior with synthetic environment and actions."""
import ast
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
import sys


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


channel_module = module('channel', 'benchmark-packages/osworld/runtime/agent_channel.py')
adapter = module('deadline_runner', 'benchmark-packages/osworld/runtime/deadline_runner.py')
wrapper = module('native_runner', 'benchmark-packages/osworld/runtime/native_runner.py')
sys.modules['deadline_runner'] = adapter
fixture = Path('test-support/fixtures/osworld/native_runner_source.py')
source = fixture.read_bytes()
provenance = json.loads(fixture.with_name('provenance.json').read_text())
assert hashlib.sha256(source).hexdigest() == provenance['source_sha256'] == adapter.RUNNER_SHA256
tree = ast.parse(source)
native = types.ModuleType('synthetic-native-runtime')
native.datetime, native.json, native.os = __import__('datetime'), json, __import__('os')
native.logger = logging.getLogger('synthetic-deadline')
native.time = types.SimpleNamespace(sleep=lambda _: None, perf_counter=lambda: 0)
native.DEFAULT_USER_RESPONSE = 'synthetic user answer'
native.GuestMemoryTracer = lambda *_a: types.SimpleNamespace(capture=lambda *_a, **_k: None)
native.log_task_completion = lambda *_a: None
native.setup_logger = lambda *_a: None
names = adapter.FUNCTIONS | {'_get_task_phases', '_configure_agent_for_task', '_persist_evaluation_result', '_parse_checkpoint_steps'}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), '<native-fixture>', 'exec'), vars(native))
run, identity = adapter.compile_deadline_runner(source, native, channel_module.CandidateBudgetExpired)
assert identity['protocol'] == adapter.PROTOCOL
assert identity['source_sha256'] == provenance['source_sha256']
try:
    adapter.compile_deadline_runner(source + b'\n', native, channel_module.CandidateBudgetExpired)
    raise AssertionError('unlocked source accepted')
except ValueError:
    pass


PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + struct.pack('!II', 40, 30)


class Environment:
    def __init__(self):
        self.require_a11y_tree, self.require_terminal, self.action_space = False, False, 'computer_13'
        self.actions, self.setups, self.evaluations, self.recordings = [], [], [], []
        self.enable_proxy, self.user_simulator = False, None
        self.action_history, self._step_no, self._traj_no = [], 0, 0
        self.setup_controller = object()
        self.controller = types.SimpleNamespace(start_recording=lambda: self.recordings.append('start'), end_recording=lambda _: self.recordings.append('end'))
        self.after_action = lambda: None
    def reset(self, task_config):
        pass
    def _get_obs(self):
        return {'screenshot': PNG}
    def step(self, action, pause):
        self.actions.append(action)
        self.after_action()
        return self._get_obs(), 0, action == 'DONE', {}
    def evaluate(self):
        self.evaluations.append('single')
        return {'score': 0.125, 'native_detail': {'untouched': True}}


class Task(dict):
    def __init__(self, env, gated=False):
        super().__init__(id='synthetic-task', instruction='single instruction')
        self.env, self.gated = env, gated
    def get_phases(self):
        def evaluate(name, value):
            self.env.evaluations.append(name)
            return value
        return [dict(name='one', instruction='one', evaluate=lambda _: evaluate('one', 0.25), gate_min_score=0.3 if self.gated else None),
                dict(name='two', instruction='two', setup=lambda *_a, **_k: self.env.setups.append('two'), evaluate=lambda _: evaluate('two', 0.5))]


def exercise(directory, case):
    channel = channel_module.AgentChannel(directory / 'channel', (40, 30), lambda _: None, max_actions_per_turn=2, max_text_bytes=4096)
    env = Environment()
    task = {'id': 'single', 'instruction': 'single'} if case == 'single' else Task(env, case == 'gate')
    result = directory / 'result'
    if case != 'single': result.mkdir()
    scores, failures = [], []
    def execute():
        try:
            if case == 'single':
                with patch.object(wrapper.importlib.util, 'find_spec', return_value=types.SimpleNamespace(origin=str(fixture))), patch.object(wrapper.importlib, 'import_module', return_value=native):
                    metadata = wrapper.run_native(channel, env, task, 2, types.SimpleNamespace(sleep_after_execution=0), result, finalize_on_budget=True)
                scores.extend(metadata['scores'])
                assert metadata['deadline_adapter'] == json.loads((result / 'deadline-adapter.json').read_text())
                assert metadata['deadline_adapter']['protocol'] == adapter.PROTOCOL
            else:
                run(channel, env, task, 2, task['instruction'], types.SimpleNamespace(sleep_after_execution=0), str(result), scores)
            channel.finish('completed')
        except BaseException as error:
            failures.append(error); channel.finish('failed')
    thread = threading.Thread(target=execute); thread.start()
    try:
        for generation in range(1, 3):
            with channel.condition:
                assert channel.condition.wait_for(lambda: channel.pending is not None and channel.generation == generation or channel.state in ['completed', 'failed'], 3)
                if channel.state == 'completed': break
                assert not failures
                token = channel.bind_context(generation, 'run_' + str(generation).zfill(32))
                if case == 'batch':
                    env.after_action = channel.expire_budget
                    channel.submit(token, channel.sequence, 'batch_action', '', ['WAIT', 'WAIT'])
                elif case in ['normal', 'gate'] or case == 'second' and generation == 1:
                    channel.submit(token, channel.sequence, 'normal_action', '', ['DONE'])
                else:
                    receipt = channel.expire_budget()
                    assert channel.expire_budget() == receipt
                    assert receipt['run_id'] == 'run_' + str(generation).zfill(32)
                    try:
                        channel.submit(token, channel.sequence, 'late_action', '', ['DONE'])
                        raise AssertionError('expired candidate submitted an action')
                    except PermissionError:
                        pass
                if case not in ['normal', 'second']: break
        thread.join(3)
        assert not thread.is_alive() and not failures, failures
        assert channel.state == 'completed'
        expected = 0.125 if case == 'single' else 0.75 if case in ['normal', 'second'] else 0.25
        assert scores == [expected] and float((result / 'result.txt').read_text()) == expected
        assert env.recordings == ['start', 'end']
        assert env.setups == (['two'] if case in ['normal', 'second'] else [])
        assert env.actions == (['WAIT'] if case == 'batch' else ['DONE', 'DONE'] if case == 'normal' else ['DONE'] if case in ['gate', 'second'] else [])
        assert env.evaluations == (['single'] if case == 'single' else ['one', 'two'] if case in ['normal', 'second'] else ['one'])
        if case == 'single':
            assert json.loads((result / 'result.json').read_text()) == {'score': 0.125, 'native_detail': {'untouched': True}}
        else:
            assert [p['score'] for p in json.loads((result / 'phase_results.json').read_text())] == ([0.25, 0.5] if case in ['normal', 'second'] else [0.25])
        audit = [json.loads(line) for line in (directory / 'channel/channel.jsonl').read_text().splitlines()]
        assert sum(row['event'] == 'budget_exhausted' for row in audit) == (0 if case in ['normal', 'gate'] else 1)
        assert audit[-1]['event'] == 'completed'
        if case in ['blocked', 'single']:
            assert not any(row['event'] == 'action_submitted' for row in audit)
            assert not (result / 'traj.jsonl').exists(), 'deadline must not fabricate DONE or ASK_USER'
    finally:
        channel.finish('cancelled'); thread.join(3)


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    for case in ['normal', 'gate', 'blocked', 'batch', 'second', 'single']:
        directory = root / case; directory.mkdir(); exercise(directory, case)
print('pinned native final-state grading preserves phases, gates, partial sums and raw single-task results; synthetic only')
