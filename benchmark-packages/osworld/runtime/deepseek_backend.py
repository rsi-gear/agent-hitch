"""Explicit DeepSeek transport for the pinned SDK's provider extension point.

Preserve upstream message/image construction and retry policy. Map the token
parameter that DeepSeek actually enforces; this named provider uses non-thinking
mode for judge/user simulation and rejects incomplete replies before scoring.
"""
import hashlib
import json
import types

from desktop_env.evaluators.backends import OpenAIBackend, register_backend


def sha(value):
    return 'sha256:' + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class DeepSeekCompletions:
    def __init__(self, create, config, records):
        self.create, self.config, self.records = create, config, records

    def __call__(self, **kwargs):
        if 'max_tokens' in kwargs or 'max_completion_tokens' not in kwargs:
            raise ValueError('unexpected SDK token parameter contract')
        body = dict(kwargs)
        body['max_tokens'] = body.pop('max_completion_tokens')
        body['extra_body'] = {'thinking': {'type': 'disabled'}}
        if not isinstance(body['max_tokens'], int) or body['max_tokens'] < 1:
            raise ValueError('invalid model token budget')
        if body['model'] != 'deepseek-v4-flash-vision-exp':
            for message in body['messages']:
                if isinstance(message['content'], list) and any(part.get('type') == 'image_url' for part in message['content']):
                    raise ValueError('DeepSeek image input requires the vision model')
        record = {'protocol': 'osworld-deepseek-chat@1', 'state': 'running', 'request_sha256': sha(body),
                  'requested_model': body['model'], 'max_tokens': body['max_tokens'], 'thinking': 'disabled'}
        self.records.append(record)
        try:
            response = self.create(**body)
            raw = response.model_dump(mode='json')
            record.update(observed_model=raw.get('model'), usage=raw.get('usage'), response_sha256=sha(raw))
            choices = raw.get('choices', [])
            if len(choices) != 1 or choices[0].get('finish_reason') != 'stop':
                raise ValueError('DeepSeek judge or simulator reply did not complete')
            record['finish_reason'] = choices[0]['finish_reason']
            message = choices[0].get('message', {})
            if (not isinstance(message.get('content'), str) or not message['content'].strip()
                    or message.get('tool_calls') or message.get('refusal')):
                raise ValueError('DeepSeek judge or simulator reply is not text')
            record['state'] = 'completed'
            return response
        except BaseException as error:
            record.update(state='failed', error_type=type(error).__name__)
            raise


@register_backend('hitch_deepseek_chat_v1')
class DeepSeekBackend(OpenAIBackend):
    def __init__(self, config):
        # Preserve native images when the explicit vision variant is selected.
        if config.model not in ('deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'):
            raise ValueError('unsupported DeepSeek model')
        if config.base_url not in ('https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/'):
            raise ValueError('DeepSeek provider requires its declared HTTPS endpoint')
        from openai import OpenAI
        from httpx import Client
        # Keep the SDK's outer retry count; do not add OpenAI SDK retries on top.
        self.config = config
        self.hitch_model_calls = []
        self.transport = OpenAI(api_key=config.api_key, base_url=config.base_url,
                                max_retries=0, timeout=300, http_client=Client(follow_redirects=False))
        self._client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(
            create=DeepSeekCompletions(self.transport.chat.completions.create, config, self.hitch_model_calls))))

    def close(self):
        self.transport.close()
