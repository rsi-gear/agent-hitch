"""Public rubric arithmetic contract; these are synthetic decisions, not evals."""
import importlib.util
from pathlib import Path
import sys
import types
stub = types.ModuleType('render'); stub.render_tree = lambda *_: None
sys.modules['render'] = stub
source = Path('benchmark-packages/gdpval/runtime/grade.py')
spec = importlib.util.spec_from_file_location('grade', source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
rubric = [{'score': 3}, {'score': 1}, {'score': -2}]
def decisions(values):
    return [{'id': str(i), 'met': v, 'evidence': 'synthetic evidence'} for i, v in enumerate(values)]
assert module.aggregate(rubric, decisions([True, False, False])) == {'rubric_score': .75, 'strict_success': 0}
assert module.aggregate(rubric, decisions([True, True, False])) == {'rubric_score': 1, 'strict_success': 1}
assert module.aggregate(rubric, decisions([False, False, True])) == {'rubric_score': 0, 'strict_success': 0}
for invalid in [decisions([True, True]), decisions([True, 1, False]), [*decisions([True, True]), decisions([True])[0]]]:
    try: module.aggregate(rubric, invalid)
    except ValueError: pass
    else: raise AssertionError('invalid decisions accepted')
print('public rubric contract passed')
