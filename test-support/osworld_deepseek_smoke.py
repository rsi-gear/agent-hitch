"""Unit checks for the explicit provider's wire contract; no model credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

stub = types.ModuleType('desktop_env.evaluators.backends')
stub.OpenAIBackend = object
stub.register_backend = lambda _: lambda cls: cls
sys.modules['desktop_env.evaluators.backends'] = stub
spec = importlib.util.spec_from_file_location('deepseek_backend', Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld/runtime/deepseek_backend.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class TransportTests(unittest.TestCase):
    def call(self, raw=None, **overrides):
        raw = raw if raw is not None else {'model': 'served-model', 'choices': [{'finish_reason': 'stop', 'message': {'content': 'YES'}}], 'usage': {'completion_tokens': 1}}
        self.sent, self.records = [], []
        def create(**body):
            self.sent.append(body)
            return types.SimpleNamespace(model_dump=lambda **_: raw)
        operation = module.DeepSeekCompletions(create, None, self.records)
        return operation(model='deepseek-v4-flash', messages=[{'role': 'user', 'content': 'PRIVATE_PROMPT'}], max_completion_tokens=1024, temperature=0, **overrides)

    def test_wire_budget_text_and_identity(self):
        response = self.call()
        self.assertEqual(response.model_dump()['choices'][0]['message']['content'], 'YES')
        self.assertEqual(self.sent[0]['max_tokens'], 1024)
        self.assertNotIn('max_completion_tokens', self.sent[0])
        self.assertEqual(self.sent[0]['extra_body'], {'thinking': {'type': 'disabled'}})
        self.assertEqual(self.sent[0]['temperature'], 0)
        self.assertEqual(self.records[0]['observed_model'], 'served-model')
        self.assertNotIn('PRIVATE_PROMPT', json.dumps(self.records))

    def test_incomplete_refusal_action_and_empty_are_invalid(self):
        for choice in ({'finish_reason': 'length', 'message': {'content': 'YES'}},
                       {'finish_reason': 'stop', 'message': {'content': ''}},
                       {'finish_reason': 'stop', 'message': {'content': 'YES', 'refusal': 'no'}},
                       {'finish_reason': 'stop', 'message': {'content': 'YES', 'tool_calls': [{'id': 'x'}]}}):
            with self.assertRaises(ValueError): self.call({'choices': [choice]})
            self.assertEqual(self.records[0]['state'], 'failed')

    def test_image_input_cannot_silently_use_text_model(self):
        called = []
        create = module.DeepSeekCompletions(lambda **body: called.append(body), None, [])
        with self.assertRaises(ValueError):
            create(model='deepseek-v4-flash', max_completion_tokens=100, messages=[{'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,...'}}]}])
        self.assertEqual(called, [])


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(TransportTests))
    if not result.wasSuccessful(): sys.exit(1)
    print('OSWorld DeepSeek token and response contracts passed')
