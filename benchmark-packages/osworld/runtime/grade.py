"""Offline normalization of a frozen controller snapshot for the fixed samples.

The native SDK has already evaluated the final VM state. This process verifies
its evidence before exporting the scalar score; it does not call a model,
reexecute the task, or infer strict success from rounded partial credit.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re

TASKS = {
    'task_031': 'sha256:883db214a66bcf00016e3c25a1111c626afc4aca8586868c45faa392164b0ce1',
    'task_095': 'sha256:58413e35891268ac0a13098e580a9bc018d0bb61f5737277dce538e7fd36de3d',
}
SDK = 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154'
RUNNER = '41dae164d16e1ee5ddd788073548caabb1bdceb551195b9f566463c1c156b5e0'
MODEL_CLIENT = 'sha256:02c75be6fc42dcd426464c25cb58a5cbbdf61e551bce2f41bd36dde0e73c2297'


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('duplicate JSON key')
            value[key] = item
        return value
    def constant(_): raise ValueError('nonfinite JSON number')
    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)


def read(file, limit=16 * 1024 * 1024):
    info = file.lstat()
    if file.is_symlink() or not file.is_file() or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError('invalid evidence file')
    return file.read_bytes()


def normalized_score(root, config_file):
    root, config_file = Path(root), Path(config_file)
    if root.is_symlink() or not root.is_dir(): raise ValueError('invalid evidence root')
    raw_config = read(config_file)
    config = strict_json(raw_config)
    source_id = config['source_task_id']
    if source_id not in TASKS or config['task_sha256'] != TASKS[source_id] or config['sdk_commit'] != SDK:
        raise ValueError('unsupported native score contract')
    config_digest = sha(raw_config)
    snapshot_raw = read(root / 'snapshot.json')
    snapshot = strict_json(snapshot_raw)
    if (snapshot['protocol'] != 'osworld-controller-snapshot@1' or snapshot['config_digest'] != config_digest
            or snapshot['source_task_id'] != source_id or snapshot['task_sha256'] != TASKS[source_id]):
        raise ValueError('snapshot source identity mismatch')
    identity = snapshot['identity']
    if (identity['task_id'] != config['task_id'] or identity['profile_digest'] != config['profile_digest']
            or type(identity['epoch']) is not int or identity['epoch'] < 1
            or any(not isinstance(identity[k], str) or not identity[k] for k in ('logical_trial_id', 'lease_id'))):
        raise ValueError('snapshot trial identity mismatch')
    expected, total = {}, len(snapshot_raw)
    for entry in snapshot['files']:
        name = entry['path']
        if (not isinstance(name, str) or not name or '\\' in name
                or PurePosixPath(name).is_absolute() or any(part in ('', '.', '..') for part in name.split('/'))
                or name == 'snapshot.json' or name in expected or type(entry['bytes']) is not int or entry['bytes'] < 0
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', str(entry['sha256']))):
            raise ValueError('invalid snapshot inventory')
        expected[name] = entry
    actual = set()
    for file in root.rglob('*'):
        if file.is_symlink(): raise ValueError('linked evidence is forbidden')
        if file.is_dir(): continue
        name = file.relative_to(root).as_posix()
        if name == 'snapshot.json': continue
        info = file.lstat()
        if name not in expected or not file.is_file() or info.st_nlink != 1 or info.st_size != expected[name]['bytes']:
            raise ValueError('snapshot file inventory mismatch')
        total += info.st_size
        if total > config['max_artifact_bytes'] or len(actual) >= 100000:
            raise ValueError('native evidence exceeds package budget')
        hasher = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): hasher.update(block)
        if 'sha256:' + hasher.hexdigest() != expected[name]['sha256']:
            raise ValueError('snapshot file digest mismatch')
        actual.add(name)
    if actual != set(expected): raise ValueError('snapshot file missing')
    native = strict_json(read(root / 'native-execution.json'))
    if (native['protocol'] != 'osworld-native-execution@1' or native['config_digest'] != config_digest
            or native['source_task_id'] != source_id or native['task_sha256'] != TASKS[source_id]
            or native['native']['sdk_commit'] != SDK or native['native']['runner_sha256'] != RUNNER
            or native['native']['prediction_step_limit'] != config['max_steps']):
        raise ValueError('native execution identity mismatch')
    screenshot_timeout = config.get('screenshot_http_timeout_sec', 10)
    if type(screenshot_timeout) is not int or not 10 <= screenshot_timeout <= 120:
        raise ValueError('invalid screenshot transport configuration')
    transport = {'protocol': 'osworld-screenshot-transport@1',
        'mode': 'sdk-default' if screenshot_timeout == 10 else 'custom-http-timeout',
        'http_timeout_sec': screenshot_timeout, 'retry_times': 3, 'retry_interval_sec': 5}
    if ('screenshot_http_timeout_sec' in config or 'screenshot_transport' in native) and native.get('screenshot_transport') != transport:
        raise ValueError('native screenshot transport differs from the frozen configuration')
    scores = native['native']['scores']
    if not isinstance(scores, list) or len(scores) != 1: raise ValueError('expected one native final score')
    score = scores[0]
    if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError('invalid native final score')
    # Both pinned selected task classes return a scalar. Reject a new result
    # shape instead of dropping its extra semantics.
    if (root / 'native/result.json').exists() or (root / 'native/phase_results.json').exists():
        raise ValueError('native task result shape changed')
    text_score = read(root / 'native/result.txt', 128).decode().strip()
    if not re.fullmatch(r'(?:0|1)(?:\.[0-9]+)?', text_score) or float(text_score) != score:
        raise ValueError('native persisted score disagrees with execution')
    audit = strict_json(read(root / 'model-calls.json'))
    if (audit['protocol'] != 'osworld-model-audit@1' or audit['model_client_sha256'] != MODEL_CLIENT
            or audit['persistence_failed'] is not False or not isinstance(audit['calls'], list)
            or any(call.get('state') != 'completed' or call.get('index') != i for i, call in enumerate(audit['calls']))):
        raise ValueError('native model dependency was not healthy')
    events = [strict_json(line) for line in read(root / 'channel/channel.jsonl').splitlines()]
    if (not events or events[-1].get('event') != 'completed'
            or any(e.get('event') in ('failed', 'cancelled') for e in events)
            or not any(e.get('event') == 'context_bound' for e in events)):
        raise ValueError('candidate channel did not complete')
    return {'native_score': score}, {
        'protocol': 'osworld-native-score@1', 'source_task_id': source_id,
        'task_sha256': TASKS[source_id], 'config_digest': config_digest,
        'snapshot_digest': sha(snapshot_raw), 'identity': identity,
        'metric': 'native_score', 'value': score, 'strict_success': None,
        'semantics': 'Unchanged scalar returned by the pinned task evaluator; task_095 rounds partial credit to two decimal places.',
        'model_calls': len(audit['calls']), 'candidate_executes': False,
        'screenshot_transport': transport,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', default='/evidence')
    parser.add_argument('--config', default='/tests/controller.json')
    parser.add_argument('--out', default='/logs/verifier')
    args = parser.parse_args()
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in ('reward.json', 'native-score.json')):
        raise ValueError('grader requires fresh output files')
    reward, receipt = normalized_score(args.evidence, args.config)
    (output / 'native-score.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (output / 'reward.json').write_text(json.dumps(reward) + '\n')


if __name__ == '__main__':
    main()
