"""Run the locked OSWorld control flow with a Hitch-controlled agent channel.

The caller owns the VM lifecycle and the fresh-candidate supervisor. This module
does not download tasks, start a candidate, or derive a strict score from partial.
"""
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path

SDK_COMMIT = 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154'
RUNNER_SHA256 = '41dae164d16e1ee5ddd788073548caabb1bdceb551195b9f566463c1c156b5e0'


def run_native(channel, env, task, max_steps, args, result_directory, *, finalize_on_budget=False, model_audit=None):
    try:
        if type(finalize_on_budget) is not bool:
            raise ValueError('native deadline mode must be explicit')
        if type(max_steps) is not int or not 1 <= max_steps <= 100000:
            raise ValueError('an explicit native prediction-step budget is required')
        if env.require_a11y_tree or env.require_terminal or env.action_space != 'computer_13':
            raise ValueError('this channel requires the declared screenshot/computer_13 profile')
        spec = importlib.util.find_spec('lib_run_single')
        if spec is None or not spec.origin or hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest() != RUNNER_SHA256:
            raise RuntimeError('OSWorld runner differs from the locked v2026.08.08 source')
        runner = importlib.import_module('lib_run_single')
        directory = Path(result_directory)
        directory.mkdir(parents=True, exist_ok=False)
        scores = []
        run = runner.run_single_example
        if finalize_on_budget:
            from deadline_runner import compile_deadline_runner
            run, identity = compile_deadline_runner(Path(spec.origin).read_bytes(), runner, channel.budget_exception)
            (directory / 'deadline-adapter.json').write_text(json.dumps(identity, sort_keys=True) + '\n', encoding='utf-8')
        run(channel, env, task, max_steps, task.get('instruction', ''), args, str(directory), scores)
        if model_audit is not None:
            model_audit.assert_healthy()
        channel.finish('completed')
        if channel.management_state()['state'] != 'completed':
            raise RuntimeError('native execution finished after its candidate channel closed')
    except BaseException:
        channel.finish('failed')
        raise
    # Keep native result.txt, result.json (when provided), phase_results.json,
    # trajectory, screenshots and recording. Metric normalization is a separate
    # release-specific stage; scores alone cannot establish strict completion.
    result = dict(sdk_commit=SDK_COMMIT, runner_sha256=RUNNER_SHA256, prediction_step_limit=max_steps, scores=scores)
    if finalize_on_budget:
        result['deadline_adapter'] = identity
    return result
