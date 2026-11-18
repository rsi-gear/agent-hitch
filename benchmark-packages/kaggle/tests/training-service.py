"""Real sklearn service checks; run with the benchmark's pinned Python stack."""
import base64
import copy
import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

runtime = Path(__file__).resolve().parents[1] / 'runtime'
sys.path.insert(0, str(runtime))
spec = importlib.util.spec_from_file_location('training_service', runtime / 'training-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
import verify
from sklearn.pipeline import Pipeline


def rejected(fn, text):
    try:
        fn()
    except (ValueError, RuntimeError) as error:
        assert text in str(error), (text, str(error))
    else:
        raise AssertionError('expected rejection: ' + text)


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    data, output, private = (root / name for name in ('data', 'output', 'private'))
    for child in (data, output, private):
        child.mkdir()
    (data / 'train.csv').write_text('id,x,target\n' + ''.join(f'{i},{i % 2},{i % 2}\n' for i in range(20)))
    (data / 'test.csv').write_text('id,x\na,0\nb,1\n')
    (data / 'service-task.json').write_text(json.dumps({'version': 1, 'id_column': 'id', 'target_column': 'target', 'predict_ids': ['a', 'b'], 'metric': 'accuracy'}))
    parameters = {'method': {'cv': {'method': 'stratified_kfold', 'folds': 5, 'seed': 42}}, 'training': {'max_fits': 6, 'fit_accounting': 'enforced', 'cv_execution': 'trusted'}, 'delivery': {'freeze_selection': True}}
    request = {'command': 'plan', 'operation': 'evaluate', 'execution_id': 'execution-a', 'request_id': 'cv-a', 'parameter_action_id': 'action-a', 'parameters': parameters,
               'model': {'algorithm': 'logistic_regression', 'features': ['x'], 'scale': True}}
    fits = []
    original_fit = Pipeline.fit
    def observed_fit(self, *args, **kwargs):
        fits.append(len(args[0]))
        return original_fit(self, *args, **kwargs)
    with patch.object(Pipeline, 'fit', observed_fit):
        planned = service.make_plan(request, data)
        assert fits == [] and len(planned['steps']) == 5
        assert service.make_plan(request, data) == planned, 'planning retry must preserve exact folds'
        plan = planned['plan']
        # A JSON JS-style integral number round trip preserves the frozen digest.
        plan['model']['parameters']['C'] = 1
        service.validate_plan(plan, data)
        result = [service.execute_step({'command': 'execute', 'plan': plan, 'step': step, 'step_index': index}, data) for index, step in enumerate(planned['steps'])]
        assert fits == [16] * 5 and all(row['top_level_attempts'] == 1 for row in result)
        evaluated = service.finalize({'command': 'finalize', 'plan': plan, 'results': result}, data)
        assert evaluated['status'] == 'completed' and evaluated['summary']['cv_score'] == 1 and len(fits) == 5
        changed = copy.deepcopy(request)
        changed['parameters']['method']['cv']['seed'] = 43
        assert service.make_plan(changed, data)['plan']['assignments_digest'] != plan['assignments_digest']
        delivery_request = {k: v for k, v in request.items() if k != 'model'}
        delivery_request.update(operation='deliver', request_id='final', source_action={'status': 'completed', 'plan': plan, 'summary': evaluated['summary']})
        delivery = service.make_plan(delivery_request, data)
        assert delivery['freeze']['identity'] == plan['id'] and len(fits) == 5
        final_plan = delivery['plan']
        final_step = service.execute_step({'command': 'execute', 'plan': final_plan, 'step': final_plan['steps'][0], 'step_index': 0}, data)
        final = service.finalize({'command': 'finalize', 'plan': final_plan, 'results': [final_step]}, data)
        assert fits == [16] * 5 + [20] and final['status'] == 'completed'
        content = base64.b64decode(final['delivery']['bytes_base64'])
        assert content == b'id,target\na,0\nb,1\n'
        changed = copy.deepcopy(delivery_request)
        changed['parameters']['method']['cv']['folds'] = 4
        rejected(lambda: service.make_plan(changed, data), 'selected concrete parameters')
        rejected(lambda: service.make_plan({**delivery_request, 'model': request['model']}, data), 'override its model')
        rejected(lambda: service.make_plan({**request, 'model': {'algorithm': 'import', 'features': ['x'], 'module': 'candidate'}}, data), 'unsupported service request fields')
        corrupted = copy.deepcopy(plan); corrupted['steps'][0]['training'].append(0)
        rejected(lambda: service.validate_plan(corrupted, data), 'plan is corrupt')
    # Host-owned evidence is separate from ordinary output artifacts.
    contract = {'version': 1, 'delivery': {'path': 'submission.csv', 'maxBytes': 4096, 'idColumn': 'id', 'targetColumns': ['target'], 'predictIds': ['a', 'b'], 'valueType': 'label', 'labels': ['0', '1']},
                'evaluation': {'mode': 'scored', 'version': 'fixture-v1', 'metric': 'accuracy', 'grader': {'kind': 'builtin'}},
                'trustedTraining': {'binding': 'trainer', 'source_digest': service.source_digest(), 'count_unit': service.COUNT_UNIT},
                'privateAnswersDigest': 'sha256:' + __import__('hashlib').sha256(content).hexdigest(),
                'publicFiles': [{'path': name, 'digest': service.file_digest(data / name)} for name in ('train.csv', 'test.csv')]}
    (private / 'task.json').write_text(json.dumps(contract)); (private / 'expected.csv').write_bytes(content)
    (output / 'submission.csv').write_bytes(content)
    state = {'execution_id': 'execution-a', 'effective': parameters, 'bindings': [{'id': 'trainer', 'coverage': 'trusted-service-top-level-attempts', 'source': {'sha256': service.source_digest()}}],
             'counters': {'trainer': {'reserved': 0, 'consumed': 6, 'unit': service.COUNT_UNIT}},
             'capability_actions': {'cv-a': {'binding': 'trainer', 'status': 'completed', 'plan': plan, 'result': evaluated, 'steps': [{'status': 'completed', 'result': row} for row in result]}, 'final': {'binding': 'trainer', 'status': 'completed', 'plan': final_plan, 'result': final, 'steps': [{'status': 'completed', 'result': final_step}]}}}
    state['bindings'][0]['dependencies'] = {'python': service.runtime()['python'], **{k: v for k, v in service.runtime().items() if k != 'python'}}
    state['capability_runtime'] = {'trainer': {'source_digest': service.source_digest(), 'runtime': service.runtime(), 'network_mode': 'none', 'mounts': [], 'privileged': False, 'cpu_millis': 1000, 'memory_bytes': 1024 * 1024 ** 2}}
    contract['parameters'] = {'capability_bindings': state['bindings']}
    contract['runtime'] = {'cpus': 3, 'memoryMb': 2048}
    (private / 'task.json').write_text(json.dumps(contract))
    evidence = root / 'evidence.json'
    def save():
        evidence.write_text(json.dumps({'version': 1, 'source': 'host_parameter_authority', 'state': state, 'evidence_error': None}))
    save()
    rewards, detail = verify.score(private, output, evidence)
    assert rewards['constraints_verified'] == 1 and rewards['task_score'] == 1 and detail['constraints']['consumed'] == 6
    observed_runtime = state.pop('capability_runtime'); save()
    rejected(lambda: verify.score(private, output, evidence), 'isolation observation unavailable')
    state['capability_runtime'] = observed_runtime
    state['counters']['trainer']['reserved'] = 1; save()
    assert verify.score(private, output, evidence)[1]['status'] == 'contract_violation'
    state['counters']['trainer']['reserved'] = 0; save()
    (output / 'submission.csv').write_text('id,target\na,1\nb,1\n')
    rewards, detail = verify.score(private, output, evidence)
    assert detail['status'] == 'contract_violation' and rewards['valid_output'] == 1 and rewards['quality_available'] == 0
    (output / 'submission.csv').write_bytes(content)
    state['capability_actions']['final']['plan']['model']['scale'] = False; save()
    assert verify.score(private, output, evidence)[1]['status'] == 'contract_violation'
    evidence.unlink()
    rejected(lambda: verify.score(private, output, evidence), 'verifier input unavailable')
    # A failed real fit is still a consumed top-level attempt; no receipt success.
    (data / 'train.csv').write_text('id,x,target\n0,0,0\n1,1,1\n')
    failed_request = copy.deepcopy(request)
    failed_request['parameters']['method']['cv'].update(method='kfold', folds=2)
    failed_plan = service.make_plan(failed_request, data)['plan']
    failed = service.execute_step({'command': 'execute', 'plan': failed_plan, 'step': failed_plan['steps'][0], 'step_index': 0}, data)
    assert failed['status'] == 'training_failed' and failed['top_level_attempts'] == 1
print(json.dumps({'status': 'passed', 'cv_fits': 5, 'final_fits': 1, 'runtime': service.runtime(), 'checks': ['no-fit-plan-finalize', 'frozen-model-and-parameters', 'bound-row-assignments', 'real-fit-failure', 'verified-delivery', 'quota-violation', 'substituted-output', 'missing-evidence']}))
