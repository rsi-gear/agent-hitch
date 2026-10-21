"""Verifier-only CLIProxyAPI Responses transport; no OAuth or SDK dependency."""
import json
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

PROFILE = "cliproxy-codex"
COMPATIBILITY_REFERENCE = "ce07d189b3de2a39d37fd68ae093b102ce3aabee"
JOB_SCHEMA = {"type": "object", "properties": {
    "criteria_results": {"type": "array", "items": {"type": "object", "properties": {
        "index": {"type": "integer"}, "passed": {"type": "boolean"}, "reasoning": {"type": "string"}, "evidence": {"type": "string"}},
        "required": ["index", "passed", "reasoning", "evidence"], "additionalProperties": False}},
    "rubric_passed": {"type": "boolean"}, "overall_reasoning": {"type": "string"}},
    "required": ["criteria_results", "rubric_passed", "overall_reasoning"], "additionalProperties": False}


def validate_endpoint(endpoint, allow_http=False):
    if not isinstance(endpoint, str) or any(ord(c) < 33 for c in endpoint):
        raise ValueError("CLIProxy judge base URL must be explicit nonempty text")
    url = urlsplit(endpoint)
    if (url.scheme not in (("https", "http") if allow_http else ("https",)) or not url.hostname
            or url.username or url.password or url.query or url.fragment):
        raise ValueError("CLIProxy judge base URL requires credential-free HTTPS; HTTP requires --judge-allow-http")
    return endpoint.rstrip("/")


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def constant(value):
        raise ValueError("nonfinite JSON value")
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def validate_schema(value, schema):
    """Validate the small official object/array/scalar schemas used by these judges."""
    types = schema.get("type")
    if types:
        types = types if isinstance(types, list) else [types]
        checks = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
            "boolean": isinstance(value, bool), "integer": isinstance(value, int) and not isinstance(value, bool), "null": value is None}
        if not any(checks.get(kind, False) for kind in types): raise ValueError("CLIProxy judge JSON schema type mismatch")
    if "enum" in schema and value not in schema["enum"]: raise ValueError("CLIProxy judge JSON schema enum mismatch")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if not set(schema.get("required", [])).issubset(value): raise ValueError("CLIProxy judge JSON schema missing keys")
        if schema.get("additionalProperties") is False and set(value) - set(properties): raise ValueError("CLIProxy judge JSON schema extra keys")
        for key, item in value.items():
            if key in properties: validate_schema(item, properties[key])
    if isinstance(value, list):
        for item in value: validate_schema(item, schema["items"])
    return value


def chat_input(messages):
    """Preserve message order, text and all image URLs, including inline data URLs."""
    result = []
    for message in messages:
        role = message.get("role")
        if role not in ("system", "developer", "user", "assistant"): raise ValueError("unsupported judge message role")
        content = message.get("content")
        if isinstance(content, str): content = [{"type": "text", "text": content}]
        if not isinstance(content, list) or not content: raise ValueError("empty judge input")
        parts = []
        for part in content:
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                parts.append({"type": "input_text", "text": part["text"]})
            elif part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
                image = part["image_url"]
                if not isinstance(image.get("url"), str) or not image["url"]: raise ValueError("invalid judge image URL")
                converted = {"type": "input_image", "image_url": image["url"]}
                if "detail" in image: converted["detail"] = image["detail"]
                parts.append(converted)
            else:
                raise ValueError("unsupported judge input part")
        result.append({"role": role, "content": parts})
    if not result: raise ValueError("empty judge messages")
    return result


def completed_text(response):
    if (not isinstance(response, dict) or response.get("object") != "response" or response.get("status") != "completed"
            or response.get("error") is not None or response.get("incomplete_details") is not None):
        raise ValueError("CLIProxy judge response did not complete normally")
    output = response.get("output")
    if not isinstance(output, list) or not output: raise ValueError("CLIProxy judge returned no output")
    messages = []
    for item in output:
        if not isinstance(item, dict) or item.get("status") not in (None, "completed"):
            raise ValueError("CLIProxy judge returned an incomplete output item")
        if item.get("type") == "reasoning":
            continue
        if (item.get("type") != "message" or item.get("role") != "assistant" or item.get("status") != "completed"
                or item.get("refusal") or item.get("tool_calls")):
            raise ValueError("CLIProxy judge returned a refusal, tool call or invalid message")
        content = item.get("content")
        if not isinstance(content, list) or not content: raise ValueError("CLIProxy judge returned empty content")
        text = []
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "output_text" or not isinstance(part.get("text"), str):
                raise ValueError("CLIProxy judge returned non-text or refused content")
            text.append(part["text"])
        messages.append("\n".join(text))
    if len(messages) != 1 or not messages[0].strip(): raise ValueError("CLIProxy judge must return one nonempty text message")
    return messages[0]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ResponsesClient:
    def __init__(self, base_url, api_key, model, allow_http=False, reasoning_effort=None):
        self.base_url = validate_endpoint(base_url, allow_http)
        if not api_key: raise ValueError("missing dedicated CLIProxy judge API key")
        if not isinstance(model, str) or not model.strip(): raise ValueError("missing explicit CLIProxy judge model")
        self.api_key, self.model, self.reasoning_effort = api_key, model, reasoning_effort
        self.provenance = {"profile": PROFILE, "api": "openai-responses", "model": model, "base_url": self.base_url,
            "reasoning_effort": reasoning_effort, "stream": False, "store": False, "strict_json_schema": True,
            "proxy_compatibility_reference": COMPATIBILITY_REFERENCE,
            "generation_controls": "temperature and token caps omitted: reviewed Codex proxy translator removes them; effective limits are upstream-controlled"}

    def evaluate(self, messages, schema, name, timeout=300):
        body = {"model": self.model, "input": chat_input(messages), "stream": False, "store": False,
            "tools": [], "tool_choice": "none", "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema}}}
        if self.reasoning_effort is not None: body["reasoning"] = {"effort": self.reasoning_effort}
        request = Request(self.base_url + "/responses", data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with build_opener(NoRedirect).open(request, timeout=timeout) as response:
                payload = strict_json(response.read().decode("utf-8"))
        except HTTPError as error:
            raise ValueError("CLIProxy judge HTTP error " + str(error.code)) from None
        text = completed_text(payload)
        return validate_schema(strict_json(text), schema)


class ChatBridge:
    """The exact OpenAI surface used by JobBench, scoped to its judge subprocess."""
    def __init__(self, config, *, base_url, api_key):
        if base_url.rstrip("/") != config["base_url"].rstrip("/"): raise ValueError("CLIProxy judge endpoint differs from locked profile")
        self.client = ResponsesClient(base_url, api_key, config["model"], config.get("allow_http", False), config.get("reasoning_effort"))
        self.chat = SimpleNamespace(completions=self)

    def create(self, *, model, messages, timeout=300, **kwargs):
        if model != self.client.model: raise ValueError("CLIProxy judge model differs from locked profile")
        if set(kwargs) - {"max_completion_tokens", "max_tokens", "temperature"}: raise ValueError("unsupported JobBench judge request options")
        result = self.client.evaluate(messages, JOB_SCHEMA, "jobbench_rubric", timeout=timeout)
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=json.dumps(result), refusal=None, tool_calls=None))])
