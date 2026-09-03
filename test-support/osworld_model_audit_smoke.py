"""Model failures caught by task code must still invalidate native completion."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'benchmark-packages/osworld/runtime'))
import model_audit
import native_runner


def facade():
    module = types.ModuleType('synthetic_model_facade')
    module.config = types.SimpleNamespace(provider='openai', model='fixture-model', max_tokens=100,
        temperature=0.0, retry_attempts=3, retry_delay=2.0, image_detail='high',
        extra={'reasoning_effort': None}, base_url=None, api_key='SECRET_FIXTURE_KEY')
    module.backend = types.SimpleNamespace(generate=lambda *_a, **_k: ' YES\n', chat=lambda *_a, **_k: ' NO\n')
    exec('''
def _build_config(*args, **kwargs):
    return config
def create_backend(config):
    return backend
def generate_text(prompt, bad_image=False):
    value = _build_config()
    if bad_image:
        raise FileNotFoundError('SECRET_FIXTURE_INPUT_PATH')
    return create_backend(value).generate(prompt)
def generate_chat(messages):
    return create_backend(_build_config()).chat(messages)
''', vars(module))
    return module


def swallowed(operation):
    try:
        return operation()
    except Exception:
        return 0.0


class ModelAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.module = facade()
        self.audit = None

    def tearDown(self):
        if self.audit: self.audit.close()
        self.temporary.cleanup()

    def install(self):
        self.audit = model_audit.ModelCallAudit(self.module, self.root / 'audit.json')
        return self.audit

    def receipt(self):
        return json.loads((self.root / 'audit.json').read_text())

    def test_existing_aliases_keep_exact_text_and_chat_results_and_omit_secrets(self):
        text, chat = self.module.generate_text, self.module.generate_chat
        original = self.module._build_config
        audit = self.install()
        self.assertEqual(text('PRIVATE_PROMPT'), ' YES\n')
        self.assertEqual(chat([{'role': 'user', 'content': 'PRIVATE_CHAT'}]), ' NO\n')
        audit.assert_healthy()
        calls = self.receipt()['calls']
        self.assertEqual([r['method'] for r in calls], ['generate', 'chat'])
        self.assertEqual([r['state'] for r in calls], ['completed', 'completed'])
        self.assertEqual(calls[0]['response_sha256'], 'sha256:' + hashlib.sha256(b' YES\n').hexdigest())
        raw = (self.root / 'audit.json').read_text()
        for secret in ('SECRET_FIXTURE_KEY', 'PRIVATE_PROMPT', 'PRIVATE_CHAT', ' YES', ' NO'):
            self.assertNotIn(secret, raw)
        audit.close()
        self.assertIs(self.module._build_config, original)

    def test_missing_credential_caught_as_zero_still_fails_audit(self):
        self.module._build_config = lambda *_a, **_k: (_ for _ in ()).throw(ValueError('SECRET_FIXTURE_KEY'))
        text = self.module.generate_text
        audit = self.install()
        self.assertEqual(swallowed(lambda: text('input')), 0.0)
        with self.assertRaises(model_audit.ModelDependencyFailure): audit.assert_healthy()
        self.assertEqual(self.receipt()['calls'][0]['stage'], 'configuration')
        self.assertNotIn('SECRET_FIXTURE_KEY', (self.root / 'audit.json').read_text())

    def test_backend_creation_error_and_later_network_error_are_sticky(self):
        for stage in ('backend_creation', 'generate'):
            with self.subTest(stage=stage):
                self.module = facade()
                if stage == 'backend_creation':
                    self.module.create_backend = lambda *_a: (_ for _ in ()).throw(ValueError('PRIVATE_FACTORY_ERROR'))
                else:
                    self.module.backend.generate = lambda *_a: (_ for _ in ()).throw(TimeoutError('PRIVATE_NETWORK_ERROR'))
                self.audit = model_audit.ModelCallAudit(self.module, self.root / (stage + '.json'))
                self.assertEqual(swallowed(lambda: self.module.generate_text('input')), 0.0)
                # A later successful call cannot erase the earlier failure.
                self.module.backend.generate = lambda *_a: 'YES'
                if stage == 'generate': self.assertEqual(self.module.generate_text('input'), 'YES')
                with self.assertRaises(model_audit.ModelDependencyFailure): self.audit.assert_healthy()
                raw = (self.root / (stage + '.json')).read_text()
                self.assertEqual(json.loads(raw)['calls'][0]['stage'], stage)
                self.assertNotIn('PRIVATE_', raw)
                self.audit.close()

    def test_failure_between_configuration_and_backend_is_not_missed(self):
        audit = self.install()
        self.assertEqual(swallowed(lambda: self.module.generate_text('input', bad_image=True)), 0.0)
        with self.assertRaises(model_audit.ModelDependencyFailure): audit.assert_healthy()
        self.assertEqual(self.receipt()['calls'][0]['state'], 'configured')

    def test_receipt_write_failure_cannot_be_swallowed_into_success(self):
        audit = self.install()
        with patch.object(model_audit, 'write_json', side_effect=OSError('PRIVATE_DISK_ERROR')):
            self.assertEqual(swallowed(lambda: self.module.generate_text('input')), 0.0)
        with self.assertRaises(model_audit.ModelDependencyFailure): audit.assert_healthy()

    def test_changed_facade_fails_before_import(self):
        source = self.root / 'desktop_env/evaluators/model_client.py'
        source.parent.mkdir(parents=True); source.write_text('raise RuntimeError("must not import")')
        with patch.object(model_audit.importlib, 'import_module') as imported:
            with self.assertRaises(ValueError): model_audit.install_model_audit(self.root, self.root / 'audit.json')
            imported.assert_not_called()

    def test_native_channel_never_completes_after_swallowed_model_error(self):
        self.module.backend.generate = lambda *_a: (_ for _ in ()).throw(TimeoutError('private error'))
        audit = self.install()
        states = []
        channel = types.SimpleNamespace(finish=states.append, management_state=lambda: {'state': states[-1]})
        env = types.SimpleNamespace(require_a11y_tree=False, require_terminal=False, action_space='computer_13')
        def run(_channel, _env, _task, _steps, _instruction, _args, directory, scores):
            score = swallowed(lambda: self.module.generate_text('input'))
            scores.append(score)
            (Path(directory) / 'result.txt').write_text(str(score))
        fixture = ROOT / 'test-support/fixtures/osworld/native_runner_source.py'
        with patch.object(native_runner.importlib.util, 'find_spec', return_value=types.SimpleNamespace(origin=str(fixture))), \
             patch.object(native_runner.importlib, 'import_module', return_value=types.SimpleNamespace(run_single_example=run)):
            with self.assertRaises(model_audit.ModelDependencyFailure):
                native_runner.run_native(channel, env, {}, 1, None, self.root / 'native', model_audit=audit)
        self.assertEqual(states, ['failed'])
        self.assertEqual((self.root / 'native/result.txt').read_text(), '0.0')

    def test_no_model_call_does_not_invalidate_a_deterministic_grader(self):
        audit = self.install()
        audit.assert_healthy()
        self.assertEqual(self.receipt()['calls'], [])


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(ModelAuditTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    print('OSWorld swallowed model errors invalidate native completion; successful results preserved')
