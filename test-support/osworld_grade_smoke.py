#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile

MODULE = Path(__file__).parents[1] / 'benchmark-packages/osworld/runtime/grade.py'
spec = importlib.util.spec_from_file_location('osworld_grade', MODULE)
grade = importlib.util.module_from_spec(spec); spec.loader.exec_module(grade)


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, separators=(',', ':')) + '\n' if not isinstance(value, str) else value)


def fixture(root, screenshot_timeout=None, native_transport=None):
    config = {'protocol': 'osworld-controller@1', 'task_id': 'osworld-task-031', 'source_task_id': 'task_031',
        'profile_digest': 'sha256:' + 'a' * 64, 'sdk_commit': grade.SDK, 'task_sha256': grade.TASKS['task_031'],
        'max_steps': 100, 'max_artifact_bytes': 16 * 1024 * 1024}
    if screenshot_timeout is not None: config['screenshot_http_timeout_sec'] = screenshot_timeout
    config_file = root / 'controller.json'; write(config_file, config)
    config_digest = grade.sha(config_file.read_bytes())
    evidence = root / 'evidence'; evidence.mkdir()
    write(evidence / 'model-calls.json', {'protocol': 'osworld-model-audit@1', 'model_client_sha256': grade.MODEL_CLIENT,
        'calls': [{'index': 0, 'state': 'completed'}], 'persistence_failed': False})
    write(evidence / 'channel/channel.jsonl', '{"event":"context_bound","generation":1,"sequence":1}\n{"event":"completed","generation":1,"sequence":1}\n')
    native = {'protocol': 'osworld-native-execution@1', 'config_digest': config_digest, 'source_task_id': 'task_031',
        'task_sha256': grade.TASKS['task_031'], 'native': {'sdk_commit': grade.SDK, 'runner_sha256': grade.RUNNER,
        'prediction_step_limit': 100, 'scores': [0.25]}}
    if native_transport is not None: native['screenshot_transport'] = native_transport
    write(evidence / 'native-execution.json', native); write(evidence / 'native/result.txt', '0.25\n')
    entries = []
    for file in sorted(evidence.rglob('*')):
        if file.is_file():
            data = file.read_bytes(); entries.append({'path': file.relative_to(evidence).as_posix(), 'bytes': len(data), 'sha256': grade.sha(data)})
    write(evidence / 'snapshot.json', {'protocol': 'osworld-controller-snapshot@1',
        'identity': {'task_id': config['task_id'], 'logical_trial_id': 'trial-1', 'lease_id': 'lease-1', 'epoch': 1,
                     'profile_digest': config['profile_digest']},
        'config_digest': config_digest, 'source_task_id': 'task_031', 'task_sha256': grade.TASKS['task_031'], 'files': entries})
    return evidence, config_file


def main():
    with tempfile.TemporaryDirectory() as name:
        evidence, config = fixture(Path(name))
        reward, receipt = grade.normalized_score(evidence, config)
        assert reward == {'native_score': 0.25} and receipt['strict_success'] is None and receipt['candidate_executes'] is False
        target = evidence / 'native/result.txt'; original = target.read_bytes(); target.write_text('0.26\n')
        try: grade.normalized_score(evidence, config); raise AssertionError('tampered evidence accepted')
        except ValueError as error: assert 'snapshot' in str(error)
        target.write_bytes(original)
        audit = evidence / 'model-calls.json'; old = audit.read_bytes(); value = json.loads(old); value['calls'][0]['state'] = 'failed'; write(audit, value)
        # Update only the inventory to prove the semantic audit is independent
        # of the byte-sealing check.
        snapshot = json.loads((evidence / 'snapshot.json').read_text())
        item = next(x for x in snapshot['files'] if x['path'] == 'model-calls.json')
        item.update(bytes=audit.stat().st_size, sha256=grade.sha(audit.read_bytes())); write(evidence / 'snapshot.json', snapshot)
        try: grade.normalized_score(evidence, config); raise AssertionError('failed model dependency accepted')
        except ValueError as error: assert 'model dependency' in str(error)
        audit.write_bytes(old)
    with tempfile.TemporaryDirectory() as name:
        evidence, config = fixture(Path(name))
        native_file = evidence / 'native-execution.json'
        native = json.loads(native_file.read_text()); native['native']['scores'] = [1.0]; write(native_file, native)
        write(evidence / 'native/result.txt', '1.0\n')
        snapshot = json.loads((evidence / 'snapshot.json').read_text())
        for entry in snapshot['files']:
            data = (evidence / entry['path']).read_bytes(); entry.update(bytes=len(data), sha256=grade.sha(data))
        write(evidence / 'snapshot.json', snapshot)
        reward, receipt = grade.normalized_score(evidence, config)
        assert reward == {'native_score': 1.0} and receipt['strict_success'] is None
    transport = {'protocol': 'osworld-screenshot-transport@1', 'mode': 'custom-http-timeout',
                 'http_timeout_sec': 120, 'retry_times': 3, 'retry_interval_sec': 5}
    with tempfile.TemporaryDirectory() as name:
        evidence, config = fixture(Path(name), 120, transport)
        assert grade.normalized_score(evidence, config)[1]['screenshot_transport'] == transport
    for recorded in (None, {**transport, 'http_timeout_sec': 10}):
        with tempfile.TemporaryDirectory() as name:
            evidence, config = fixture(Path(name), 120, recorded)
            try: grade.normalized_score(evidence, config); raise AssertionError('unrecorded transport accepted')
            except ValueError as error: assert 'transport' in str(error)
    print('OSWorld offline scalar score and evidence gates passed')


if __name__ == '__main__': main()
