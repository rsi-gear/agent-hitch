"""Independent CSV-only task verifier. Never imports candidate code or models."""
from __future__ import annotations
import argparse
import contextlib
import csv
import hashlib
import io
import json
import math
import sys
from pathlib import Path
import scoring


class InvalidSubmission(ValueError):
    pass


class ConstraintViolation(InvalidSubmission):
    pass


def bounded(path, limit, *, candidate=False):
    error = InvalidSubmission if candidate else RuntimeError
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise error('missing, unsafe, or oversized submission' if candidate else 'verifier input unavailable')
    return path.read_bytes()


def csv_rows(content, columns, *, candidate=False):
    error = InvalidSubmission if candidate else RuntimeError
    try:
        reader = csv.reader(io.StringIO(content.decode('utf-8-sig'), newline=''), strict=True)
        if next(reader, None) != columns:
            raise error('submission columns differ from declared schema' if candidate else 'private answer columns differ')
        rows = list(reader)
        if not rows or any(len(row) != len(columns) for row in rows):
            raise error('malformed or empty submission' if candidate else 'private answer schema invalid')
        return rows
    except (UnicodeError, csv.Error) as exc:
        raise error('CSV encoding or syntax invalid') from exc


def parse_submission(content, delivery):
    rows = csv_rows(content, [delivery['idColumn'], *delivery['targetColumns']], candidate=True)
    if [row[0] for row in rows] != delivery['predictIds']:
        raise InvalidSubmission('submission row IDs/order differ from declared schema')
    for row in rows:
        for value in row[1:]:
            if delivery['valueType'] == 'label':
                if value not in delivery['labels']:
                    raise InvalidSubmission('prediction outside allowed labels')
            else:
                try:
                    numeric = float(value)
                except ValueError as exc:
                    raise InvalidSubmission('prediction must be numeric') from exc
                if not math.isfinite(numeric) or (delivery['valueType'] != 'number' and numeric < 0) or (delivery['valueType'] == 'probability' and numeric > 1):
                    raise InvalidSubmission('prediction outside declared numeric domain')
    return rows


class DiscardOutput(io.TextIOBase):
    """Private grader diagnostics cannot escape through stdout/stderr."""
    def write(self, value):
        return len(value)
    def flush(self):
        pass


def native_score(private, evaluation, content, expected):
    # The native tree was imported from the benchmark repository, never the agent.
    native_root = private / 'native'
    sys.path.insert(0, str(native_root))
    try:
        with contextlib.redirect_stdout(DiscardOutput()), contextlib.redirect_stderr(DiscardOutput()):
            import pandas as pd
            from mlebench.grade_helpers import Grader
            grader = Grader(evaluation['metric'], evaluation['grader']['entrypoint'])
            original, errors = grader.grade_fn, []
            def observed_grade(submission, answers):
                try:
                    return original(submission, answers)
                except Exception as exc:
                    errors.append(exc)
                    raise
            # Keep upstream rounding and result semantics. Preserve the error
            # category upstream's logging wrapper otherwise collapses to None.
            grader.grade_fn = observed_grade
            submission = pd.read_csv(io.BytesIO(content))
            answers = pd.read_csv(io.BytesIO(expected))
            result = grader(submission, answers)
            if errors:
                if type(errors[0]).__name__ == 'InvalidSubmissionError':
                    raise InvalidSubmission('native grader rejected submission')
                raise RuntimeError('native grader execution unavailable')
            if result is None:
                raise RuntimeError('native grader returned no score')
            return float(result)
    except InvalidSubmission:
        raise
    except Exception as exc:
        # Native InvalidSubmissionError is an expected artifact failure. Other
        # exceptions are verifier infrastructure failures, never model quality 0.
        if type(exc).__name__ == 'InvalidSubmissionError':
            raise InvalidSubmission('native grader rejected submission') from None
        raise RuntimeError('native grader unavailable (' + type(exc).__name__ + ')') from None
    finally:
        sys.path.pop(0)


def trusted_constraints(plan, content, evidence_path):
    if not plan.get('trustedTraining'):
        return None
    evidence = json.loads(bounded(evidence_path, 64 * 1024 ** 2))
    if evidence.get('version') != 1 or evidence.get('source') != 'host_parameter_authority' or evidence.get('evidence_error'):
        raise RuntimeError('trusted constraint evidence unavailable')
    state = evidence.get('state', {})
    binding_id = plan['trustedTraining']['binding']
    bindings = state.get('bindings', [])
    binding = next((b for b in bindings if b.get('id') == binding_id), None)
    expected_binding = next((b for b in plan.get('parameters', {}).get('capability_bindings', []) if b.get('id') == binding_id), None)
    if not binding or binding != expected_binding or binding.get('coverage') != 'trusted-service-top-level-attempts' or binding.get('source', {}).get('sha256') != plan['trustedTraining']['source_digest']:
        raise RuntimeError('trusted capability binding evidence differs')
    observation = state.get('capability_runtime', {}).get(binding_id, {})
    if observation.get('source_digest') != binding['source']['sha256'] or observation.get('network_mode') != 'none' or observation.get('mounts') != [] or observation.get('privileged') is not False:
        raise RuntimeError('trusted runtime isolation observation unavailable')
    for name, expected_version in binding['dependencies'].items():
        actual_version = observation.get('runtime', {}).get(name)
        if actual_version != expected_version and not (name == 'python' and isinstance(actual_version, str) and actual_version.startswith(expected_version + '.')):
            raise RuntimeError('trusted runtime dependency observation differs')
    if observation.get('cpu_millis') != (plan['runtime']['cpus'] - 2) * 1000 or observation.get('memory_bytes') != (plan['runtime']['memoryMb'] - 1024) * 1024 ** 2:
        raise RuntimeError('trusted runtime resource observation differs')
    counter = state.get('counters', {}).get(binding_id)
    if not isinstance(counter, dict) or counter.get('unit') != plan['trustedTraining']['count_unit'] or any(type(counter.get(k)) is not int or counter[k] < 0 for k in ('reserved', 'consumed')):
        raise RuntimeError('trusted fit accounting unavailable')
    limit = state.get('effective', {}).get('training', {}).get('max_fits')
    if limit is not None and (type(limit) is not int or counter['reserved'] + counter['consumed'] > limit):
        raise ConstraintViolation('trusted fit limit exceeded')
    actions = state.get('capability_actions', {})
    scoped = [a for a in actions.values() if a.get('binding') == binding_id]
    if any(a.get('status') == 'unavailable' or any(s.get('status') == 'started' for s in a.get('steps', [])) for a in scoped):
        raise RuntimeError('trusted action execution evidence unavailable')
    reserved = consumed = 0
    for candidate in scoped:
        steps = candidate.get('steps')
        if not isinstance(steps, list) or not steps:
            raise RuntimeError('trusted action step accounting unavailable')
        for step in steps:
            if step.get('status') == 'reserved':
                reserved += 1
            elif step.get('status') in ('completed', 'failed') and step.get('result', {}).get('top_level_attempts') == 1:
                consumed += 1
            else:
                raise RuntimeError('trusted action attempt evidence unavailable')
    if reserved != counter['reserved'] or consumed != counter['consumed']:
        raise RuntimeError('trusted fit accounting inconsistent')
    completed = [a for a in actions.values() if a.get('binding') == binding_id and a.get('status') == 'completed'
                 and a.get('plan', {}).get('operation') == 'deliver' and a.get('result', {}).get('status') == 'completed']
    actual = 'sha256:' + hashlib.sha256(content).hexdigest()
    matching = [a for a in completed if a.get('result', {}).get('delivery', {}).get('sha256') == actual]
    if not matching:
        raise ConstraintViolation('submission is not bound to a completed trusted delivery')
    action = matching[-1]
    delivery_plan = action['plan']
    if delivery_plan.get('execution_id') != state.get('execution_id') or delivery_plan.get('source_digest') != plan['trustedTraining']['source_digest']:
        raise ConstraintViolation('trusted delivery execution/source identity differs')
    public = {f['path']: f['digest'] for f in plan['publicFiles']}
    if delivery_plan.get('inputs', {}).get('train') != public.get('train.csv') or delivery_plan.get('inputs', {}).get('predict') != public.get('test.csv'):
        raise ConstraintViolation('trusted delivery input identity differs')
    effective = delivery_plan.get('parameters', {})
    selected_id = delivery_plan.get('selected_plan_id')
    selected = next((a for a in actions.values() if a.get('binding') == binding_id and a.get('status') == 'completed'
                     and a.get('plan', {}).get('id') == selected_id and a.get('plan', {}).get('operation') == 'evaluate'
                     and a.get('result', {}).get('status') == 'completed'), None)
    if effective.get('delivery', {}).get('freeze_selection'):
        if not selected or selected['plan'].get('model') != delivery_plan.get('model') or selected['plan'].get('parameters') != effective:
            raise ConstraintViolation('frozen selection differs from final training')
        if any(a['plan'].get('selected_plan_id') != selected_id for a in completed):
            raise ConstraintViolation('frozen delivery selection was changed')
    if effective.get('training', {}).get('cv_execution') == 'trusted':
        if not selected or not selected['plan'].get('assignments') or selected['plan'].get('assignments_digest') != selected['result'].get('summary', {}).get('assignments_digest'):
            raise ConstraintViolation('trusted CV allocation evidence unavailable')
        if selected['plan'].get('inputs') != delivery_plan.get('inputs') or selected['plan'].get('source_digest') != delivery_plan.get('source_digest'):
            raise ConstraintViolation('trusted CV data/source identity differs')
    return {'status': 'verified', 'coverage': binding['coverage'], 'count_unit': counter['unit'],
            'reserved': counter['reserved'], 'consumed': counter['consumed'], 'execution_id': state['execution_id'],
            'delivery_plan_id': delivery_plan['id'], 'selected_plan_id': selected_id}


def score(private, output, constraints=Path('/hitch-constraints/parameter-evidence.json')):
    plan = json.loads(bounded(private / 'task.json', 64 * 1024 ** 2))
    if plan.get('version') != 1 or plan.get('evaluation', {}).get('mode') not in ('scored', 'delivery'):
        raise RuntimeError('unsupported task contract')
    delivery, evaluation = plan['delivery'], plan['evaluation']
    expected = None
    if evaluation['mode'] == 'scored':
        expected = bounded(private / 'expected.csv', 1024 ** 3)
        if 'sha256:' + hashlib.sha256(expected).hexdigest() != plan['privateAnswersDigest']:
            raise RuntimeError('private scoring input changed')
        columns = [delivery['idColumn'], *delivery['targetColumns']]
        answer_reader = csv.reader(io.StringIO(expected.decode('utf-8-sig'), newline=''), strict=True)
        answer_columns = next(answer_reader, [])
        if len(set(answer_columns)) != len(answer_columns) or any(c not in answer_columns for c in columns):
            raise RuntimeError('private answer columns differ')
        answer_rows = list(answer_reader)
        if any(len(r) != len(answer_columns) for r in answer_rows):
            raise RuntimeError('private answer schema invalid')
        truth_rows = [[row[answer_columns.index(c)] for c in columns] for row in answer_rows]
        if [r[0] for r in truth_rows] != delivery['predictIds']:
            raise RuntimeError('private answer IDs/order differ')
        for row in truth_rows:
            for value in row[1:]:
                if evaluation['metric'] == 'accuracy':
                    if value not in delivery['labels']:
                        raise RuntimeError('private answer outside declared label domain')
                else:
                    try:
                        numeric = float(value)
                    except ValueError:
                        raise RuntimeError('private answer is not numeric') from None
                    if not math.isfinite(numeric) or numeric < 0 or (evaluation['metric'] == 'auc-roc' and value not in ('0', '1')):
                        raise RuntimeError('private answer outside declared metric domain')
        if evaluation['metric'] == 'auc-roc' and {row[1] for row in truth_rows} != {'0', '1'}:
            raise RuntimeError('private AUC answers require both classes')
        for entry in plan.get('graderFiles', []):
            raw = bounded(private / 'native' / entry['path'], 1024 ** 3)
            if 'sha256:' + hashlib.sha256(raw).hexdigest() != entry['digest']:
                raise RuntimeError('native grader source changed')
    try:
        relative = Path(delivery['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('invalid delivery path')
        path = output / relative
        if output.is_symlink() or any(output.joinpath(*relative.parts[:i]).is_symlink() for i in range(1, len(relative.parts) + 1)):
            raise InvalidSubmission('symlink delivery paths are not accepted')
        content = bounded(path, delivery['maxBytes'], candidate=True)
        rows = parse_submission(content, delivery)
        constraint_result = trusted_constraints(plan, content, constraints)
        detail = {'status': 'completed', 'delivery': 'valid', 'format': 'valid', 'rows': len(rows),
                  'constraints': constraint_result or 'not_requested', 'configuration_compliance': 'service_verified' if constraint_result else 'unverified',
                  'quality': {'status': 'unavailable', 'source': 'external_verifier', 'reason': 'no_private_answers'}}
        rewards = {'reward': 1, 'total_score': 1, 'valid_output': 1, 'completed': 1, 'quality_available': 0}
        if constraint_result:
            rewards['constraints_verified'] = 1
        if expected is not None:
            if evaluation['grader']['kind'] == 'native':
                value = native_score(private, evaluation, content, expected)
            else:
                schema = {'idColumn': delivery['idColumn'], 'targetColumns': delivery['targetColumns'], 'labels': delivery.get('labels', ['0', '1']), 'metric': evaluation['metric']}
                truths = {row[0]: dict(zip(columns, row)) for row in truth_rows}
                predicted = scoring.predictions(content, schema, delivery['predictIds'])
                value = scoring.score(schema, truths, predicted, delivery['predictIds'])
            if not math.isfinite(value) or value < 0 or (evaluation['metric'] != 'mean-column-wise-rmsle' and value > 1):
                raise RuntimeError('grader returned an invalid metric')
            quality = scoring.quality(evaluation['metric'], value)
            rewards.update(reward=quality, total_score=quality, task_score=value, quality_available=1)
            detail['quality'] = {'status': 'available', 'source': 'external_verifier', 'metric': evaluation['metric'], 'value': value, 'version': evaluation['version']}
        return rewards, detail
    except InvalidSubmission as exc:
        violation = isinstance(exc, ConstraintViolation)
        rewards = {'reward': 0, 'total_score': 0, 'valid_output': 1 if violation else 0, 'completed': 0, 'quality_available': 0}
        if plan.get('trustedTraining'):
            rewards['constraints_verified'] = 0
        return rewards, {
            'status': 'contract_violation' if violation else 'delivery_failed', 'delivery': 'invalid', 'format': 'valid' if violation else 'invalid_or_missing', 'message': str(exc),
            'quality': {'status': 'unavailable', 'source': 'external_verifier', 'reason': 'invalid_delivery'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private', type=Path, default=Path('/tests/private'))
    parser.add_argument('--output', type=Path, default=Path('/output'))
    parser.add_argument('--result', type=Path, default=Path('/logs/verifier'))
    parser.add_argument('--constraints', type=Path, default=Path('/hitch-constraints/parameter-evidence.json'))
    args = parser.parse_args()
    args.result.mkdir(parents=True, exist_ok=True)
    for name in ('reward.json', 'feedback.json'):
        (args.result / name).unlink(missing_ok=True)
    try:
        rewards, detail = score(args.private, args.output, args.constraints)
    except Exception as exc:
        # Never include private labels, grader internals, or row-level outcomes.
        detail = {'status': 'infrastructure_error', 'quality': {'status': 'unavailable'},
                  'message': 'Verifier evidence unavailable (' + type(exc).__name__ + ')'}
        feedback = {'schema_version': '1', 'items': [{'code': 'verifier_unavailable', 'severity': 'error', 'message': json.dumps(detail)}]}
        (args.result / 'feedback.json').write_text(json.dumps(feedback) + '\n')
        print(json.dumps(detail))
        return 1
    (args.result / 'reward.json').write_text(json.dumps(rewards) + '\n')
    feedback = {'schema_version': '1', 'items': [{'code': detail['status'], 'severity': 'info' if detail['status'] == 'completed' else 'error', 'message': json.dumps(detail)}]}
    (args.result / 'feedback.json').write_text(json.dumps(feedback) + '\n')
    print(json.dumps(detail))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
