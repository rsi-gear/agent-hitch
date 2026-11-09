"""Opt-in closed tabular training service; ordinary Agent training never imports it.

plan/finalize do not fit. Each execute enters exactly one top-level estimator.fit
attempt. The host reserves and accounts attempts durably before invoking execute.
Input contains only JSON model specifications and task-owned CSVs, never modules,
pickles, dynamic factories or expressions. Coverage is this service's attempts,
not arbitrary learning elsewhere in the Agent sandbox.
"""
from __future__ import annotations
import base64
import csv
import hashlib
import io
import json
import math
import platform
import sys
from pathlib import Path

VERSION = 1
COUNT_UNIT = 'trusted-service-top-level-attempt'
MAX_REQUEST_BYTES = 16 * 1024 * 1024


def canonical(value):
    # JSON crosses the host JS authority: 1.0 and 1 are one JSON number.
    def normalize(item):
        if isinstance(item, float) and math.isfinite(item) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [normalize(v) for v in item]
        if isinstance(item, dict):
            return {k: normalize(v) for k, v in item.items()}
        return item
    return json.dumps(normalize(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return 'sha256:' + hashlib.sha256(canonical(value).encode()).hexdigest()


def file_digest(path):
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()


def source_digest():
    return file_digest(Path(__file__))


def runtime():
    import numpy
    import pandas
    import sklearn
    return {'python': platform.python_version(), 'numpy': numpy.__version__, 'pandas': pandas.__version__, 'sklearn': sklearn.__version__}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, allowed, required=()):
    require(isinstance(value, dict) and not set(value) - set(allowed) and set(required) <= set(value), 'unsupported service request fields')


def task_input(data_root):
    import pandas as pd
    config = json.loads((data_root / 'service-task.json').read_text())
    fields(config, ['version', 'id_column', 'target_column', 'predict_ids', 'metric'], ['version', 'id_column', 'target_column', 'predict_ids', 'metric'])
    require(config['version'] == 1 and config['metric'] in ('accuracy', 'auc-roc'), 'service supports one classification target')
    train_bytes, test_bytes = (data_root / 'train.csv').read_bytes(), (data_root / 'test.csv').read_bytes()
    train, test = pd.read_csv(io.BytesIO(train_bytes)), pd.read_csv(io.BytesIO(test_bytes))
    idc, target = config['id_column'], config['target_column']
    require(idc in train and target in train and idc in test and target not in test, 'training and prediction columns do not match service contract')
    train_ids = pd.read_csv(io.BytesIO(train_bytes), dtype=str)[idc].tolist()
    test_ids = pd.read_csv(io.BytesIO(test_bytes), dtype=str)[idc].tolist()
    require(len(train_ids) > 1 and len(set(train_ids)) == len(train_ids) and all(isinstance(v, str) and v for v in train_ids), 'training row IDs must be unique strings')
    require(test_ids == config['predict_ids'] and len(set(test_ids)) == len(test_ids), 'prediction input IDs/order differ')
    labels = pd.read_csv(io.BytesIO(train_bytes), dtype=str)[target]
    require(not labels.isna().any() and len(set(labels)) >= 2, 'classification training labels unavailable')
    if config['metric'] == 'auc-roc':
        require(set(labels) == {'0', '1'}, 'AUC service requires binary 0/1 labels')
    identity = {'task': file_digest(data_root / 'service-task.json'), 'train': file_digest(data_root / 'train.csv'), 'predict': file_digest(data_root / 'test.csv')}
    return config, train, test, labels, train_ids, identity


def model_spec(raw, train, test, config):
    fields(raw, ['algorithm', 'features', 'scale', 'parameters'], ['algorithm', 'features'])
    require(raw['algorithm'] in ('logistic_regression', 'decision_tree'), 'unsupported training interface: choose logistic_regression or decision_tree')
    features = raw['features']
    require(isinstance(features, list) and 0 < len(features) <= 256 and all(isinstance(c, str) and c in train and c in test for c in features)
            and len(set(features)) == len(features) and config['id_column'] not in features and config['target_column'] not in features, 'features must be distinct public numeric columns excluding ID and target')
    import pandas as pd
    for frame in (train, test):
        for column in features:
            try:
                values = pd.to_numeric(frame[column], errors='raise')
            except Exception:
                raise ValueError('trusted service only accepts numeric features') from None
            require(all(pd.isna(v) or math.isfinite(float(v)) for v in values), 'feature contains nonfinite value')
    scale = raw.get('scale', False)
    require(type(scale) is bool, 'scale must be boolean')
    params = raw.get('parameters', {})
    if raw['algorithm'] == 'logistic_regression':
        fields(params, ['C', 'max_iter', 'fit_intercept'])
        defaults = {'C': 1.0, 'max_iter': 300, 'fit_intercept': True}
        params = {**defaults, **params}
        require(type(params['C']) in (int, float) and 0 < params['C'] <= 100 and math.isfinite(params['C']), 'C outside supported range')
        require(type(params['max_iter']) is int and 1 <= params['max_iter'] <= 2000 and type(params['fit_intercept']) is bool, 'invalid logistic parameters')
    else:
        fields(params, ['max_depth', 'min_samples_leaf'])
        params = {'max_depth': 8, 'min_samples_leaf': 1, **params}
        require(type(params['max_depth']) is int and 1 <= params['max_depth'] <= 64 and type(params['min_samples_leaf']) is int
                and 1 <= params['min_samples_leaf'] <= 1024, 'invalid decision tree parameters')
    return {'algorithm': raw['algorithm'], 'features': features, 'scale': scale, 'parameters': params}


def parameters(raw):
    require(isinstance(raw, dict), 'effective parameters required')
    cv = raw.get('method', {}).get('cv', {})
    require(cv.get('method') in ('kfold', 'stratified_kfold') and type(cv.get('folds')) is int and 2 <= cv['folds'] <= 10
            and type(cv.get('seed')) is int and 0 <= cv['seed'] <= 2**32 - 1, 'unsupported CV configuration')
    return cv


def make_plan(request, data_root):
    fields(request, ['command', 'execution_id', 'request_id', 'operation', 'parameters', 'parameter_action_id', 'model', 'source_action'],
           ['command', 'execution_id', 'request_id', 'operation', 'parameters', 'parameter_action_id'])
    require(request['operation'] in ('evaluate', 'deliver'), 'unsupported service operation')
    require(all(isinstance(request[k], str) and request[k] for k in ['execution_id', 'request_id', 'parameter_action_id']), 'action identities required')
    config, train, test, labels, train_ids, inputs = task_input(data_root)
    cv = parameters(request['parameters'])
    source = request.get('source_action')
    freeze = bool(request['parameters'].get('delivery', {}).get('freeze_selection', False))
    if source is not None:
        require(request['operation'] == 'deliver' and isinstance(source, dict) and source.get('status') == 'completed', 'delivery source must be a completed trusted action')
        selected = source.get('plan', {})
        validate_plan(selected, data_root)
        require(selected.get('operation') == 'evaluate' and selected['execution_id'] == request['execution_id'], 'selected action belongs to another execution')
        require(selected['parameters'] == request['parameters'], 'delivery must use selected concrete parameters')
        require('model' not in request, 'selected delivery cannot override its model')
        model = selected['model']
    else:
        require(not (request['operation'] == 'deliver' and freeze), 'frozen delivery requires a completed selected action')
        require('model' in request, 'model specification required')
        model = model_spec(request['model'], train, test, config)
    assignments, steps = [], []
    if request['operation'] == 'evaluate':
        from sklearn.model_selection import KFold, StratifiedKFold
        require(cv['folds'] <= len(train), 'fold count exceeds training rows')
        splitter = (StratifiedKFold if cv['method'] == 'stratified_kfold' else KFold)(n_splits=cv['folds'], shuffle=True, random_state=cv['seed'])
        assignments = [-1] * len(train)
        for index, (training, validation) in enumerate(splitter.split(train, labels)):
            training, validation = list(map(int, training)), list(map(int, validation))
            for row in validation:
                assignments[row] = index
            steps.append({'kind': 'cv_fold', 'index': index, 'training': training, 'validation': validation})
        require(all(i >= 0 for i in assignments), 'CV did not assign all rows')
    else:
        steps = [{'kind': 'final_fit', 'index': 0, 'training': list(range(len(train))), 'validation': []}]
    body = {'version': 1, 'execution_id': request['execution_id'], 'request_id': request['request_id'], 'operation': request['operation'],
            'parameter_action_id': request['parameter_action_id'], 'parameters': request['parameters'], 'model': model,
            'source_digest': source_digest(), 'runtime': runtime(), 'inputs': inputs, 'train_ids': train_ids,
            'assignments': assignments, 'assignments_digest': digest({'inputs': inputs, 'rows': train_ids, 'assignments': assignments, 'cv': cv}),
            'steps': steps, 'selected_plan_id': source['plan']['id'] if source else None}
    plan = json.loads(canonical({**body, 'id': digest(body)}))
    return {'version': 1, 'plan': plan, 'steps': steps, 'count_unit': COUNT_UNIT, 'source_digest': body['source_digest'], 'runtime': body['runtime'],
            **({'freeze': {'key': 'delivery-selection', 'identity': source['plan']['id']}} if freeze and request['operation'] == 'deliver' else {})}


def validate_plan(plan, data_root):
    require(isinstance(plan, dict) and plan.get('version') == 1 and plan.get('id') == digest({k: v for k, v in plan.items() if k != 'id'}), 'frozen service plan is corrupt')
    require(plan['source_digest'] == source_digest() and plan['runtime'] == runtime(), 'trusted service runtime changed')
    config, train, test, labels, train_ids, inputs = task_input(data_root)
    require(plan['inputs'] == inputs and plan['train_ids'] == train_ids, 'trusted service input changed')
    require(model_spec(plan['model'], train, test, config) == plan['model'], 'model is not a resolved supported specification')
    parameters(plan['parameters'])
    return config, train, test, labels


def execute_step(request, data_root):
    fields(request, ['command', 'plan', 'step', 'step_index'], ['command', 'plan', 'step', 'step_index'])
    plan, step, index = request['plan'], request['step'], request['step_index']
    config, train, test, labels = validate_plan(plan, data_root)
    require(type(index) is int and 0 <= index < len(plan['steps']) and plan['steps'][index] == step, 'step differs from frozen plan')
    # All validation above precedes the host's declared top-level training
    # attempt. The host already marked this step consumed before this invocation.
    try:
        from sklearn.pipeline import Pipeline
        from sklearn.impute import SimpleImputer
        from sklearn.preprocessing import StandardScaler
        from sklearn.linear_model import LogisticRegression
        from sklearn.tree import DecisionTreeClassifier
        model, cv = plan['model'], parameters(plan['parameters'])
        estimator = (LogisticRegression if model['algorithm'] == 'logistic_regression' else DecisionTreeClassifier)(**model['parameters'], random_state=cv['seed'])
        pipeline_steps = [('imputer', SimpleImputer(strategy='median', keep_empty_features=True))]
        if model['scale']:
            pipeline_steps.append(('scaler', StandardScaler()))
        pipeline_steps.append(('classifier', estimator))
        pipeline = Pipeline(pipeline_steps)
        training = step['training']
        pipeline.fit(train.iloc[training][model['features']], labels.iloc[training])
        frame = train.iloc[step['validation']] if step['kind'] == 'cv_fold' else test
        if config['metric'] == 'auc-roc':
            values = list(map(float, pipeline.predict_proba(frame[model['features']])[:, list(pipeline.classes_).index('1')]))
        else:
            values = list(map(str, pipeline.predict(frame[model['features']])))
        return {'version': 1, 'status': 'completed', 'plan_id': plan['id'], 'step_index': index, 'top_level_attempts': 1,
                'predictions': values, 'rows': step['validation'] if step['kind'] == 'cv_fold' else list(range(len(test)))}
    except Exception as exc:
        return {'version': 1, 'status': 'training_failed', 'plan_id': plan['id'], 'step_index': index, 'top_level_attempts': 1,
                'error': {'type': type(exc).__name__, 'message': str(exc)[:2000]}}


def finalize(request, data_root):
    fields(request, ['command', 'plan', 'results'], ['command', 'plan', 'results'])
    plan, results = request['plan'], request['results']
    config, train, test, labels = validate_plan(plan, data_root)
    require(isinstance(results, list) and len(results) == len(plan['steps']), 'trusted execution results are incomplete')
    for index, result in enumerate(results):
        require(isinstance(result, dict) and result.get('plan_id') == plan['id'] and result.get('step_index') == index
                and result.get('top_level_attempts') == 1, 'trusted result identity differs')
    summary = {'source': 'trusted_training_service', 'count_unit': COUNT_UNIT, 'fits': len(results), 'plan_id': plan['id'],
               'assignments_digest': plan['assignments_digest'], 'model_digest': digest(plan['model']), 'source_digest': plan['source_digest'],
               'parameter_action_id': plan['parameter_action_id'], 'selected_plan_id': plan['selected_plan_id']}
    failed = [r for r in results if r.get('status') != 'completed']
    if failed:
        return {'version': 1, 'status': 'training_failed', 'summary': summary, 'errors': [r.get('error', {'type': 'evidence_unavailable'}) for r in failed]}
    if plan['operation'] == 'evaluate':
        predicted = [None] * len(train)
        for result in results:
            require(len(result['rows']) == len(result['predictions']), 'prediction evidence length differs')
            for index, value in zip(result['rows'], result['predictions']):
                require(predicted[index] is None, 'duplicate CV row result')
                predicted[index] = value
        require(all(v is not None for v in predicted), 'CV prediction evidence incomplete')
        from sklearn.metrics import accuracy_score, roc_auc_score
        metric = float(accuracy_score(labels, predicted) if config['metric'] == 'accuracy' else roc_auc_score(list(map(int, labels)), predicted))
        summary.update(cv_metric=config['metric'], cv_score=metric, quality_source='internal_trusted_cv_not_official')
        return {'version': 1, 'status': 'completed', 'summary': summary}
    values = results[0]['predictions']
    require(len(values) == len(config['predict_ids']), 'final prediction row count differs')
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow([config['id_column'], config['target_column']])
    writer.writerows(zip(config['predict_ids'], values))
    content = output.getvalue().encode()
    return {'version': 1, 'status': 'completed', 'summary': summary,
            'delivery': {'path': 'submission.csv', 'bytes_base64': base64.b64encode(content).decode(), 'sha256': 'sha256:' + hashlib.sha256(content).hexdigest()}}


def main():
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    require(len(raw) <= MAX_REQUEST_BYTES, 'training service request exceeds limit')
    request = json.loads(raw)
    command = request.get('command')
    if command == 'probe':
        return {'version': 1, 'source_digest': source_digest(), 'runtime': runtime(), 'count_unit': COUNT_UNIT}
    root = Path('/data')
    if len(sys.argv) == 3 and sys.argv[1] == '--data':
        root = Path(sys.argv[2])
    if command == 'plan':
        return make_plan(request, root)
    if command == 'execute':
        return execute_step(request, root)
    if command == 'finalize':
        return finalize(request, root)
    raise ValueError('unsupported service command')


if __name__ == '__main__':
    try:
        result = main()
        print(canonical(result))
    except Exception as exc:
        print(canonical({'version': 1, 'status': 'service_error', 'error': {'type': type(exc).__name__, 'message': str(exc)[:2000]}}))
        raise SystemExit(1)
