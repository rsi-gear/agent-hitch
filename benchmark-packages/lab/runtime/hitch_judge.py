"""Opt-in transport for OpenAI-compatible Chat Completions judges.

The official prompt loader and JSON parser are inherited unchanged. Rubric
scoping, document extraction and score aggregation remain in lab_core.
"""
from contextlib import contextmanager
from urllib.parse import urlsplit


def validate_verdict(result):
    """Enforce the official verdict schema before score_rubric supplies defaults."""
    if (not isinstance(result, dict) or set(result) != {"verdict", "reasoning"}
            or result["verdict"] not in ("pass", "fail") or not isinstance(result["reasoning"], str)):
        raise ValueError("LAB judge returned an invalid verdict schema")
    return result


@contextmanager
def validated_judges(evaluation):
    # Official dual evaluation instantiates its module-global Judge. Swap only
    # that reference for this grading scope; never mutate the reusable class.
    original = evaluation.Judge

    class ValidatedJudge(original):
        def evaluate_from_file(self, *args, **kwargs):
            return validate_verdict(super().evaluate_from_file(*args, **kwargs))

    evaluation.Judge = ValidatedJudge
    try:
        yield ValidatedJudge
    finally:
        evaluation.Judge = original


def chat_judge(official_judge, model, reasoning_effort=None):
    import openai
    from lab_core.evaluation.judge import _JUDGE_MAX_OUTPUT_TOKENS

    class ChatJudge(official_judge):
        def __init__(self):
            self.model = model
            self.provider = "openai-chat-completions"
            self.client = openai.OpenAI()
            endpoint = str(self.client.base_url)
            url = urlsplit(endpoint)
            if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError("judge endpoint must be an HTTP(S) URL without credentials, query or fragment")
            self.transport_provenance = {"api": self.provider, "model": model, "base_url": endpoint,
                "max_tokens": _JUDGE_MAX_OUTPUT_TOKENS, "reasoning_effort": reasoning_effort,
                "response_format": "json_object on first attempt; upstream-style plain JSON fallback",
                "prompt_and_parser": "official Judge.evaluate_from_file and Judge._parse_json"}

        def evaluate(self, prompt_template, variables, temperature=0.0, _retries=2):
            prompt = prompt_template.format(**variables)
            last_error = None
            for attempt in range(_retries):
                kwargs = {"model": self.model, "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": _JUDGE_MAX_OUTPUT_TOKENS, "temperature": temperature}
                if reasoning_effort is not None: kwargs["reasoning_effort"] = reasoning_effort
                if attempt < _retries - 1: kwargs["response_format"] = {"type": "json_object"}
                try:
                    response = self.client.chat.completions.create(**kwargs)
                    if len(response.choices) != 1: raise ValueError("judge must return exactly one choice")
                    choice = response.choices[0]
                    if choice.finish_reason != "stop": raise ValueError("judge did not finish normally: " + str(choice.finish_reason))
                    message = choice.message
                    if getattr(message, "refusal", None) or getattr(message, "tool_calls", None):
                        raise ValueError("judge returned a refusal or tool call")
                    text = message.content
                    if not isinstance(text, str) or not text.strip(): raise ValueError("judge returned empty content")
                    return validate_verdict(self._parse_json(text))
                except Exception as error:
                    last_error = error
            raise ValueError(f"Chat judge failed after {_retries} attempts: {last_error}")

    return ChatJudge()
