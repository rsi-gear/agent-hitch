"""Real upstream grader parity in a pinned Linux image (no model calls).

Usage: python3 native-grader-parity.py UPSTREAM_REPOSITORY RUNTIME_DIRECTORY
Requires the original MLE-bench Python dependencies in the verifier image.
"""
import hashlib
import importlib.util
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

upstream, runtime = map(Path, sys.argv[1:])
sys.path.insert(0, str(runtime))
spec = importlib.util.spec_from_file_location('task_verify', runtime / 'verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)

cases = [
    ('tabular-playground-series-may-2022', 'auc-roc', ['target'], 'probability',
     [[0], [1], [0], [1]], [[.3], [.3], [.2], [.8]], .875),
    ('nomad2018-predict-transparent-conductors', 'mean-column-wise-rmsle',
     ['formation_energy_ev_natom', 'bandgap_energy_ev'], 'nonnegative',
     [[0, 1], [2, 3], [4, 5], [6, 7]], [[.1, .8], [1.5, 2.8], [4.4, 6], [6.1, 8]], None),
]
results = []
for competition, metric, targets, value_type, truths, predictions, exact in cases:
    # Production invokes a separate verifier process per task. This harness
    # reuses Python only to compare cases, so discard prior temporary modules.
    for module in list(sys.modules):
        if module == 'mlebench' or module.startswith('mlebench.'):
            del sys.modules[module]
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        private, output = root / 'private', root / 'output'
        private.mkdir(); output.mkdir()
        shutil.copytree(upstream / 'mlebench', private / 'native/mlebench',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        ids = ['3', '1', '4', '2']
        def csv(values):
            return ','.join(['id', *targets]) + '\n' + ''.join(','.join([key, *map(str, row)]) + '\n' for key, row in zip(ids, values))
        expected, submission = csv(truths).encode(), csv(predictions).encode()
        (private / 'expected.csv').write_bytes(expected)
        (output / 'submission.csv').write_bytes(submission)
        plan = {'version': 1,
                'delivery': {'format': 'csv', 'path': 'submission.csv', 'idColumn': 'id', 'targetColumns': targets,
                             'predictIds': ids, 'valueType': value_type, 'maxBytes': 1024 * 1024},
                'evaluation': {'mode': 'scored', 'version': 'upstream-parity', 'metric': metric,
                               'grader': {'kind': 'native', 'entrypoint': f'mlebench.competitions.{competition}.grade:grade'}},
                'privateAnswersDigest': 'sha256:' + hashlib.sha256(expected).hexdigest(), 'graderFiles': []}
        (private / 'task.json').write_text(json.dumps(plan))
        rewards, detail = verify.score(private, output)
        actual = rewards['task_score']
        if exact is not None:
            assert math.isclose(actual, exact, abs_tol=1e-12), actual
        else:
            expected_rmsle = sum(math.sqrt(sum((math.log1p(t[i]) - math.log1p(p[i])) ** 2 for t, p in zip(truths, predictions)) / len(ids)) for i in range(2)) / 2
            assert math.isclose(actual, round(expected_rmsle, 5), abs_tol=1e-12), actual
        assert detail['quality']['source'] == 'external_verifier'
        results.append({'competition': competition, 'native_score': actual, 'quality_available': rewards['quality_available']})
print(json.dumps({'status': 'passed', 'results': results}))
