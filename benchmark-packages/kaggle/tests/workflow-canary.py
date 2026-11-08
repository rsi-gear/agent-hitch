"""Run in the pinned Linux image: real confinement, search and fit-only delivery."""
import hashlib
import gzip
import json
import sys
from pathlib import Path
sys.path.insert(0, '/runner')
import worker
import research_worker

factory = b'''from sklearn.dummy import DummyClassifier
def build_pipeline(config):
    return DummyClassifier(strategy='constant',constant=config['hyperparameters']['constant'])
'''
def config(constant):
    return {'inputSchema': {}, 'preprocessing': {}, 'features': {}, 'model': 'dummy',
            'hyperparameters': {'constant': constant}, 'prediction': {'kind': 'label'}, 'seed': 42}

data = b'id,x,target\n0,0,0\n1,1,0\n2,2,0\n3,3,1\n4,4,0\n5,5,0\n6,6,0\n7,7,1\n8,8,0\n9,9,1\n'
schema = {'kind': 'tabular', 'idColumn': 'id', 'targetColumns': ['target'], 'metric': 'accuracy', 'labels': ['0','1']}
plan = {'variants': [{'id': 'zero', 'config': config(0)}, {'id': 'one', 'config': config(1)}],
        'validation': {'kind': 'stratified', 'folds': 2}, 'seed': 42, 'maxFits': 5}
job = {'searchPlan': plan, 'prediction': schema, 'entrypoint': 'solution.py',
       'validationPlan': {'trainDigest': 'sha256:'+hashlib.sha256(data).hexdigest(), 'assignments': [0,0,0,0,0,0,0,0,1,1], 'metric': 'accuracy'},
       'outputDirectory': '/run/research-result', 'cpuSeconds': 60, 'wallSeconds': 90}
result = research_worker.research(worker, job, {'solution.py': factory}, data)
assert result['status'] == 'completed', result
assert result['formalVariantId'] == 'zero' and result['fits'] == 5, result
resolved = {'config': config(0), 'actualParameters': result['formalFit']['parametersBefore']}
expanded = data + b''.join(f'{i},{i},1\n'.encode() for i in range(10, 40))
delivered = research_worker.invoke(worker, {**job, 'resolvedPipeline': resolved}, {'solution.py': factory},
    {'train.csv': expanded, 'predict.csv': b'id,x\n99,99\n'}, config(0), 20, 30)
assert delivered['exitCode'] == 0, delivered
assert delivered['outputs']['predictions.csv'] == b'id,target\n99,0\n'
assert delivered['fitReceipt']['searchCalls'] == 0 and delivered['fitReceipt']['fits'] == 1
# The new protocol uses every labeled row once as OOF validation and has no
# separate formal holdout fit. Model seed 42 is independent of split seed 1234.
cv_data = b'id,x,target\n' + b''.join(f'{i},{i},{i%2}\n'.encode() for i in range(20))
cv_plan = {'protocol': 'analysis-round-cv-plan@1', 'trainDigest': 'sha256:'+hashlib.sha256(cv_data).hexdigest(),
           'kind': 'stratified', 'folds': 5, 'shuffle': True, 'seed': 1234, 'metric': 'accuracy',
           'splitter': 'python-random-stratified-round-robin@1'}
cv_search = {**plan, 'validation': {'kind': 'stratified', 'folds': 5, 'shuffle': True, 'seed': 1234},
             'maxFits': 11, 'refitReserve': 1}
cv = research_worker.research(worker, {**job, 'searchPlan': cv_search, 'validationPlan': cv_plan,
    'outputDirectory': '/run/cv-result', 'cpuSeconds': 120, 'wallSeconds': 180}, {'solution.py': factory}, cv_data)
assert cv['status'] == 'completed' and cv['fits'] == 10 and cv['formalFit'] is None, cv
assert cv['validationRows'] == 0 and len(cv['foldMetrics']) == 5, cv
assert len(json.loads(gzip.decompress(Path(cv['oofPath']).read_bytes()))) == 20
# Parameterized plans are persisted once and then consumed without resampling.
parameterized = []
for policy in [
    {'method': 'stratified_kfold', 'folds': 5, 'shuffle': False, 'seed': 42},
    {'method': 'stratified_kfold', 'folds': 10, 'shuffle': True, 'seed': 7},
    {'method': 'stratified_holdout', 'fraction': .2, 'shuffle': True, 'seed': 42},
]:
    frozen = research_worker.materialize_plan(cv_data, schema, {
        'experiment': {'validation': policy}, 'configurationDigest': 'sha256:'+'1'*64,
        'policyDigest': 'sha256:'+'2'*64})
    saved = json.dumps(frozen)
    declared = {k: frozen[k] for k in ('kind', 'method', 'folds', 'shuffle', 'seed')}
    if 'fraction' in frozen:
        declared['fraction'] = frozen['fraction']
    search = {**cv_search, 'variants': [plan['variants'][0]], 'validation': declared,
              'maxFits': frozen['folds']+1}
    original_splitter = research_worker.folds
    def no_resample(*args):
        raise AssertionError('execution attempted to resample a frozen split')
    research_worker.folds = no_resample
    try:
        evaluated = research_worker.research(worker, {**job, 'searchPlan': search, 'validationPlan': frozen,
            'outputDirectory': '/run/parameterized-'+str(len(parameterized)), 'cpuSeconds': 180, 'wallSeconds': 240},
            {'solution.py': factory}, cv_data)
    finally:
        research_worker.folds = original_splitter
    assert evaluated['status'] == 'completed', evaluated
    assert evaluated['fits'] == frozen['folds'] and len(evaluated['foldMetrics']) == frozen['folds'], evaluated
    assert evaluated['cv']['foldAssignments'] == frozen['foldAssignments']
    assert json.dumps(frozen) == saved
    expected_rows = 4 if 'fraction' in policy else 20
    assert len(json.loads(gzip.decompress(Path(evaluated['oofPath']).read_bytes()))) == expected_rows
    parameterized.append({'method': policy['method'], 'folds': frozen['folds'], 'fits': evaluated['fits'], 'rows': expected_rows})
# Importing a previously unloaded estimator cannot turn free-form EDA into training.
guard = Path('/runner/pipeline_runner.py').read_bytes()
eda = b"from guard import install_fit_guard\ninstall_fit_guard(0)\nfrom sklearn.dummy import DummyClassifier\nDummyClassifier().fit([[0],[1]],[0,1])\n"
blocked = worker.run_python({'guard.py': guard, 'eda.py': eda}, {}, 'eda.py', [], 30, 10)
assert blocked['exitCode'] != 0 and 'fit outside' in str(blocked['logs']['stderr']), blocked
print(json.dumps({'search': 'passed', 'trialFits': result['fits'], 'sharedEvaluations': 1,
                  'parameterized': parameterized, 'frozenAssignments': 'passed', 'roundCv': 'passed', 'cvFits': cv['fits'], 'cvHoldoutFits': 0, 'cvRows': 20,
                  'expandedRefit': 'frozen', 'refitFits': delivered['fitReceipt']['fits'], 'searchCalls': 0, 'edaFitGuard': 'passed'}))
