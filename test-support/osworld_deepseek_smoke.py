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

    def test_flash_thinking_preserves_images_history_and_wire_parameters(self):
        sent, records = [], []
        raw = {'model': 'deepseek-flash', 'choices': [{'finish_reason': 'stop', 'message': {'content': 'RED', 'reasoning_content': 'PRIVATE_REASONING'}}], 'usage': {'completion_tokens': 3}}
        def create(**body):
            sent.append(body)
            return types.SimpleNamespace(model_dump=lambda **_: raw)
        operation = module.DeepSeekCompletions(create, types.SimpleNamespace(extra={}), records, thinking=True)
        messages = [
            {'role': 'assistant', 'content': '', 'reasoning_content': 'PRIVATE_TOOL_REASONING', 'tool_calls': [{'id': 'call-1'}]},
            {'role': 'tool', 'tool_call_id': 'call-1', 'content': 'done'},
            {'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,...'}}]},
        ]
        operation(model='deepseek-flash', messages=messages, max_completion_tokens=1024)
        self.assertEqual(sent[0]['messages'], messages)
        self.assertEqual(sent[0]['extra_body'], {'thinking': {'type': 'enabled'}})
        self.assertEqual(sent[0]['reasoning_effort'], 'high')
        self.assertEqual(sent[0]['max_tokens'], 1024)
        self.assertEqual(records[0]['protocol'], 'osworld-deepseek-chat@2')
        self.assertEqual(records[0]['reasoning_effort'], 'high')
        self.assertEqual(records[0]['observed_model'], 'deepseek-flash')
        self.assertNotIn('PRIVATE', json.dumps(records))

    def test_thinking_effort_uses_sdk_config_and_rejects_unknown_values(self):
        sent = []
        operation = module.DeepSeekCompletions(lambda **body: sent.append(body),
            types.SimpleNamespace(extra={'reasoning_effort': 'max'}), [], thinking=True)
        # A fake response is sufficient to inspect the request before response validation.
        with self.assertRaises(AttributeError):
            operation(model='deepseek-flash', messages=[], max_completion_tokens=16)
        self.assertEqual(sent[0]['reasoning_effort'], 'max')
        with self.assertRaisesRegex(ValueError, 'reasoning effort'):
            operation(model='deepseek-flash', messages=[], max_completion_tokens=16, reasoning_effort='xhigh')
        self.assertEqual(len(sent), 1)

    def test_thinking_truncation_and_empty_replies_remain_invalid(self):
        for choice in ({'finish_reason': 'length', 'message': {'content': 'YES'}},
                       {'finish_reason': 'stop', 'message': {'content': '', 'reasoning_content': 'still thinking'}},
                       {'finish_reason': 'stop', 'message': {'content': 'YES', 'tool_calls': [{'id': 'x'}]}}):
            records = []
            operation = module.DeepSeekCompletions(
                lambda **_: types.SimpleNamespace(model_dump=lambda **_: {'choices': [choice]}), None, records, thinking=True)
            with self.assertRaises(ValueError):
                operation(model='deepseek-flash', messages=[], max_completion_tokens=16)
            self.assertEqual(records[0]['state'], 'failed')

    def test_profile_selects_thinking_for_both_model_roles_and_keeps_legacy(self):
        root = Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld'
        legacy = json.loads((root / 'deepseek-profile.json').read_text())
        current = json.loads((root / 'deepseek-flash-thinking-high-profile.json').read_text())
        self.assertEqual(legacy['transport']['thinking'], 'disabled')
        self.assertEqual(current['transport']['thinking'], 'enabled')
        for role in ('OSWORLD_EVAL_MODEL_PROVIDER', 'OSWORLD_USER_SIM_PROVIDER'):
            self.assertEqual(current['environment'][role], 'hitch_deepseek_chat_v2')
        self.assertEqual(current['environment']['OSWORLD_EVAL_MODEL_REASONING_EFFORT'], 'high')
        self.assertIn('deepseek-flash', module.DeepSeekThinkingBackend.models)
        self.assertNotIn('deepseek-flash', module.DeepSeekBackend.models)
        with self.assertRaisesRegex(ValueError, 'unsupported DeepSeek model'):
            module.DeepSeekThinkingBackend(types.SimpleNamespace(model='unknown'))


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(TransportTests))
    if not result.wasSuccessful(): sys.exit(1)
    print('OSWorld DeepSeek token and response contracts passed')
