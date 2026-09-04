"""Add a deadline exit to the pinned SDK loops without replacing its graders.

The trusted native controller alone can expire the candidate budget. This adapter
adds checks before predictions/actions and a narrow exception-to-loop-exit path.
The original phase evaluation, gates, score aggregation and result writers remain
in the SDK AST. A source or control-flow mismatch fails before task execution.
"""
import ast
import copy
import hashlib
from pathlib import Path

PROTOCOL = 'osworld-native-deadline@1'
RUNNER_SHA256 = '41dae164d16e1ee5ddd788073548caabb1bdceb551195b9f566463c1c156b5e0'
FUNCTIONS = {'run_single_example', '_run_multi_phase_task_example'}


def _check():
    return ast.Expr(value=ast.Call(func=ast.Attribute(value=ast.Name(id='agent', ctx=ast.Load()), attr='check_budget', ctx=ast.Load()), args=[], keywords=[]))


def _guard(body):
    return ast.Try(body=[_check(), *body], handlers=[ast.ExceptHandler(
        type=ast.Name(id='_hitch_budget_expired', ctx=ast.Load()), name=None, body=[ast.Break()])], orelse=[], finalbody=[])


def compile_deadline_runner(source, native, exception_type):
    if hashlib.sha256(source).hexdigest() != RUNNER_SHA256:
        raise ValueError('deadline adapter requires the locked OSWorld runner')
    tree = ast.parse(source)
    functions = [copy.deepcopy(node) for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    if len(functions) != 2:
        raise ValueError('native task entrypoints changed')

    class Adapt(ast.NodeTransformer):
        predictions = actions = phases = 0

        def visit_While(self, node):
            self.generic_visit(node)
            if ast.dump(node.test) != ast.dump(ast.parse('not done and step_idx < max_steps', mode='eval').body):
                raise ValueError('native prediction loop changed')
            if node.orelse:
                raise ValueError('native prediction loop has an unexpected else branch')
            self.predictions += 1
            node.body = [_guard(node.body)]
            return node

        def visit_Assign(self, node):
            self.generic_visit(node)
            if isinstance(node.value, ast.Call) and ast.dump(node.value.func) == ast.dump(ast.parse('env.step', mode='eval').body):
                self.actions += 1
                return [_check(), node]
            return node

        def visit_For(self, node):
            self.generic_visit(node)
            if ast.dump(node.iter) == ast.dump(ast.parse('enumerate(phases, start=1)', mode='eval').body):
                if node.orelse:
                    raise ValueError('native phase loop changed')
                self.phases += 1
                # This catches expiration before a new conversation starts;
                # active prediction/action expiration is caught by its while.
                node.body = [_guard(node.body)]
            return node

    adapter = Adapt()
    transformed = ast.fix_missing_locations(adapter.visit(ast.Module(body=functions, type_ignores=[])))
    if (adapter.predictions, adapter.actions, adapter.phases) != (2, 2, 1):
        raise ValueError('native deadline control-flow coverage changed')
    namespace = dict(vars(native), _hitch_budget_expired=exception_type)
    exec(compile(transformed, '<osworld-native-deadline@1>', 'exec'), namespace)
    identity = dict(protocol=PROTOCOL, source_sha256=RUNNER_SHA256,
                    adapter_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    transformed_ast_sha256=hashlib.sha256(ast.dump(transformed).encode()).hexdigest())
    return namespace['run_single_example'], identity
