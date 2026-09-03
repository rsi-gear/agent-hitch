"""Pinned installed SDK + authorized Task031, with controlled model failures.

Run only in a disposable network-none controller container. It invokes the
original grader method with synthetic messages/criteria, never an agent or VM.
No official task score or successful live model call is established here.
"""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types


def main(args):
    root, source = Path(args.sdk_root), Path(args.task_source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != '883db214a66bcf00016e3c25a1111c626afc4aca8586868c45faa392164b0ce1':
        raise ValueError('Task031 differs from the authorized release')
    sys.path.insert(0, str(root))
    os.environ['WEBSITE_HOST_SUFFIX'] = 'trial.hitch.test'
    from model_audit import install_model_audit, ModelDependencyFailure
    client = importlib.import_module('desktop_env.evaluators.model_client')
    task = importlib.import_module('task_loader').load_task_from_file(str(source))
    from desktop_env.user_simulator import LLMUserSimulator
    # This alias was captured when the original task was imported, before audit.
    judge = lambda: task._judge_channel('synthetic-channel', ['synthetic message'], ['synthetic criterion'])
    assert not any(os.environ.get(k) for k in ('OPENAI_API_KEY', 'OSWORLD_EVAL_MODEL_API_KEY', 'OSWORLD_USER_SIM_API_KEY'))
    assert judge() is False, 'baseline must reproduce the swallowed missing-credential failure'
    real_factory = client.create_backend
    checks = []
    with tempfile.TemporaryDirectory() as temporary:
        for name in ('missing-key', 'network-error', 'yes', 'no', 'user-simulator'):
            path = Path(temporary) / (name + '.json')
            if name != 'missing-key': os.environ['OPENAI_API_KEY'] = 'synthetic-not-a-real-key'
            def generate(*_args, **_kwargs):
                if name == 'network-error': raise TimeoutError('PRIVATE_ERROR_SENTINEL')
                return 'YES' if name == 'yes' else 'NO'
            if name != 'missing-key':
                client.create_backend = lambda _config: types.SimpleNamespace(generate=generate, chat=lambda *_a, **_k: 'synthetic reply')
            audit = install_model_audit(root, path)
            try:
                if name == 'user-simulator':
                    simulator = LLMUserSimulator({'type': 'llm', 'model': 'gpt-4o', 'knowledge': 'synthetic knowledge'})
                    simulator.reset('synthetic instruction')
                    assert simulator.respond('synthetic question') == 'synthetic reply'
                else:
                    assert judge() is (name == 'yes')
                try:
                    audit.assert_healthy()
                    healthy = True
                except ModelDependencyFailure:
                    healthy = False
                assert healthy is (name not in ('missing-key', 'network-error'))
                raw = path.read_text(); receipt = json.loads(raw)
                assert len(receipt['calls']) == 1
                assert all(text not in raw for text in ('synthetic-not-a-real-key', 'PRIVATE_ERROR_SENTINEL', 'synthetic message', 'synthetic criterion', 'synthetic question', 'synthetic knowledge'))
                if name != 'missing-key':
                    assert receipt['calls'][0]['effective_config']['model'] == ('gpt-4o' if name == 'user-simulator' else 'gpt-5.2')
                checks.append({'case': name, 'healthy': healthy, 'audit': receipt})
            finally:
                audit.close()
                client.create_backend = real_factory
                os.environ.pop('OPENAI_API_KEY', None)
    print(json.dumps({'protocol': 'osworld-model-audit-canary@1', 'passed': True,
        'official_task_source': 'task_031', 'source_task_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'real_scored_tasks': 0, 'live_model_calls': 0, 'checks': checks}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-root', required=True)
    parser.add_argument('--task-source', required=True)
    main(parser.parse_args())
