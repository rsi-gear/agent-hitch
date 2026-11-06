"""CSV-only external verifier. No candidate modules, models or pickle imports."""
import csv
import hashlib
import io
import json
from pathlib import Path
import scoring


def read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 ** 2:
        raise ValueError('missing or unsafe trusted artifact: ' + path.name)
    return path.read_bytes()


def rows(content, columns):
    reader = csv.DictReader(io.StringIO(content.decode('utf-8-sig'), newline=''))
    if reader.fieldnames != columns:
        raise ValueError('unexpected CSV columns')
    result = {}
    for row in reader:
        key = row[columns[0]]
        if not key or key in result or None in row or any(v is None for v in row.values()):
            raise ValueError('invalid CSV row or ID')
        result[key] = row
    if not result:
        raise ValueError('empty predictions')
    return result


def score(private, output):
    request = json.loads(read(private / 'request.json'))
    # Receipt loss/corruption is unavailable, never an invented model failure.
    receipt = json.loads(read(output / 'receipt.json'))
    if receipt.get('requestDigest') != request['digest']:
        raise ValueError('execution receipt request mismatch')
    if request['protocol'] in ('analysis-rollout-request@1', 'analysis-rollout-request@2'):
        if receipt.get('protocol') != 'analysis-rollout-output@1':
            raise ValueError('invalid research receipt')
        return {'reward': 1, 'total_score': 1, 'valid_output': 1, 'completed': 1}
    if receipt.get('protocol') != 'analysis-execution-receipt@1' or receipt.get('modelRequests') != 0 or receipt.get('solutionDigest') != request['solution']['digest']:
        raise ValueError('sealed execution identity mismatch')
    failure = {'reward': 0, 'total_score': 0, 'valid_output': 0, 'completed': 0}
    if receipt['status'] == 'candidate_failed':
        return failure
    if receipt['status'] != 'completed':
        raise ValueError('unavailable execution status')
    content = read(output / 'predictions.csv')
    if 'sha256:' + hashlib.sha256(content).hexdigest() != receipt['predictionsDigest']:
        raise ValueError('sealed predictions changed')
    schema = request['task']['prediction']
    if schema.get('kind') == 'tabular':
        ids = request['task']['predictIds']
        try:
            predictions = scoring.predictions(content, schema, ids)
            # Every exported submission, including positional NOMAD, has the
            # pinned public sample/test order.
            _, ordered = scoring.table(content)
            if [r[schema['idColumn']] for r in ordered] != ids:
                raise ValueError('noncanonical submission order')
        except (ValueError, UnicodeError, csv.Error):
            return failure
        labeled = (private / 'expected.csv').exists()
        if not labeled:
            return {'reward': 1, 'total_score': 1, 'valid_output': 1, 'completed': 1}
        columns = [schema['idColumn'], *schema['targetColumns']]
        expected = rows(read(private / 'expected.csv'), columns)
        if set(expected) != set(ids):
            raise ValueError('private answer IDs changed')
        value = scoring.score(schema, expected, predictions, ids)
        quality = scoring.quality(schema['metric'], value)
        return {'reward': quality, 'total_score': quality, 'valid_output': 1, 'completed': 1,
                'task_score': value, **({'accuracy': value} if schema['metric'] == 'accuracy' else {})}
    columns = [schema['idColumn'], schema['targetColumn']]
    labeled = (private / 'expected.csv').exists()
    expected = rows(read(private / 'expected.csv'), columns) if labeled else {i: {} for i in request['task']['predictIds']}
    try:
        predictions = rows(content, columns)
        if predictions.keys() != expected.keys() or any(r[columns[1]] not in schema['allowedLabels'] for r in predictions.values()):
            raise ValueError('prediction IDs or labels mismatch')
    except (ValueError, UnicodeError, csv.Error):
        return failure
    accuracy = sum(predictions[i][columns[1]] == expected[i][columns[1]] for i in expected) / len(expected) if labeled else None
    value = accuracy if labeled else 1
    return {'reward': value, 'total_score': value, 'valid_output': 1, 'completed': 1, **({'accuracy': accuracy} if labeled else {})}


if __name__ == '__main__':
    result = Path('/logs/verifier')
    result.mkdir(parents=True, exist_ok=True)
    for name in ('reward.json', 'feedback.json'):
        (result / name).unlink(missing_ok=True)
    rewards = score(Path('/tests/private'), Path('/output'))
    (result / 'reward.json').write_text(json.dumps(rewards))
    (result / 'feedback.json').write_text(json.dumps({'schema_version': '1', 'items': []}))
