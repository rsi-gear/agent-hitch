"""Installed SDK + declared DeepSeek profile, with synthetic task inputs.

The task_031 grader method is upstream code; this exercises model integration,
not official scoring. No candidate or desktop is run.
"""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile


def main(args):
    root, source = Path(args.sdk_root), Path(args.task_source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != '883db214a66bcf00016e3c25a1111c626afc4aca8586868c45faa392164b0ce1':
        raise ValueError('unexpected Task031 source')
    sys.path.insert(0, str(root))
    from image_entrypoint import verify_image
    image = verify_image()
    from model_audit import install_model_audit
    import deepseek_backend  # registers the explicit provider
    profile_bytes = Path(args.profile).read_bytes()
    profile = json.loads(profile_bytes)
    os.environ.update(profile['environment'])
    os.environ['WEBSITE_HOST_SUFFIX'] = 'trial.hitch.test'
    if not os.environ.get('DEEPSEEK_API_KEY'): raise ValueError('missing configured credential')
    task = importlib.import_module('task_loader').load_task_from_file(str(source))
    from desktop_env.user_simulator import LLMUserSimulator
    from desktop_env.evaluators.model_client import generate_text
    with tempfile.TemporaryDirectory() as temporary:
        receipt = Path(temporary) / 'audit.json'
        audit = install_model_audit(root, receipt)
        try:
            yes = task._judge_channel('synthetic-channel', ['The report is missing its required signature.'], ['The report is missing its required signature.'])
            no = task._judge_channel('synthetic-channel', ['Lunch is at noon.'], ['The report is missing its required signature.'])
            assert yes is True and no is False
            simulator = LLMUserSimulator({'type': 'llm', 'model': 'gpt-4o', 'knowledge': 'The preferred delivery day is Tuesday.'})
            simulator.reset('Arrange a delivery on the preferred day.')
            answer = simulator.respond('Which day should I arrange the delivery?')
            assert 'tuesday' in answer.lower()
            audit.assert_healthy()
            healthy_calls = json.loads(receipt.read_text())
            # Real truncation must fail even if an upstream caller swallows it.
            try:
                generate_text('Explain prime numbers in detail.', options={'max_tokens': 1})
                raise AssertionError('truncated model reply was accepted')
            except ValueError:
                pass
            try:
                audit.assert_healthy()
                raise AssertionError('failed model dependency remained healthy')
            except RuntimeError:
                pass
            failed_calls = json.loads(receipt.read_text())['calls'][-1:]
        finally:
            audit.close()
    print(json.dumps({'protocol': 'osworld-deepseek-canary@1', 'passed': True,
        'synthetic_inputs_only': True, 'official_scored_tasks': 0, 'image': image,
        'profile_sha256': 'sha256:' + hashlib.sha256(profile_bytes).hexdigest(),
        'source_task_sha256': 'sha256:' + hashlib.sha256(source.read_bytes()).hexdigest(),
        'judge_yes': yes, 'judge_no': no, 'user_simulator_answer_checked': True,
        'healthy_model_calls': healthy_calls, 'truncated_call_invalidated': failed_calls}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-root', required=True)
    parser.add_argument('--task-source', required=True)
    parser.add_argument('--profile', required=True)
    main(parser.parse_args())
