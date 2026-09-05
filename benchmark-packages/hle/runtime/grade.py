"""Official HLE extraction/equivalence prompt with a pinned structured judge.

The original prompt and grader source are supplied by the producer at an exact
Git revision. API/parse failures do not produce zero scores.
"""
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit, urlunsplit
import urllib.request


SCHEMA = {"type": "object", "properties": {"extracted_final_answer": {"type": "string"}, "reasoning": {"type": "string"},
    "correct": {"type": "string", "enum": ["yes", "no"]}, "confidence": {"type": "integer"}, "strict": {"type": "boolean", "enum": [True]}},
    "required": ["extracted_final_answer", "reasoning", "correct", "confidence", "strict"], "additionalProperties": False}


def judge_endpoint(base_url, api):
    parts = urlsplit(base_url)
    if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment):
        raise ValueError("judge base URL must be HTTPS without credentials, query or fragment")
    if api not in ("chat-completions", "responses"):
        raise ValueError("unsupported judge API")
    suffix = "responses" if api == "responses" else "chat/completions"
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/") + "/" + suffix, "", ""))


def judge_request(config, prompt):
    api = config.get("api", "chat-completions")
    endpoint = judge_endpoint(config.get("base_url", "https://api.openai.com/v1/"), api)
    structured = {"name": "ExtractedAnswer", "strict": True, "schema": SCHEMA}
    messages = [{"role": "user", "content": prompt}]
    guidance = config.get("schema_instruction")
    if guidance is not None:
        if guidance != "system-json-schema@1":
            raise ValueError("unsupported judge schema instruction")
        messages.insert(0, {"role": "system", "content": "Return only a JSON object conforming exactly to this schema. Do not coerce strings to null.\n" + json.dumps(SCHEMA, separators=(",", ":"))})
    if api == "responses":
        body = {"model": config["model"], "max_output_tokens": 4096,
            "input": messages, "tools": [], "tool_choice": "none", "store": False,
            "text": {"format": {"type": "json_schema", **structured}}}
    else:
        body = {"model": config["model"], "max_completion_tokens": 4096,
            "messages": messages,
            "response_format": {"type": "json_schema", "json_schema": structured}}
    return endpoint, body


def parse_judgment(config, raw):
    if config.get("api", "chat-completions") == "responses":
        if raw.get("status") != "completed" or not isinstance(raw.get("output"), list):
            raise ValueError("judge response did not complete")
        if any(item.get("type") not in ("message", "reasoning") for item in raw["output"]):
            raise ValueError("judge returned an unexpected action")
        parts = [part for item in raw["output"] if item.get("type") == "message" for part in item.get("content", [])]
        if not parts or any(part.get("type") != "output_text" or not isinstance(part.get("text"), str) for part in parts):
            raise ValueError("judge returned no structured text")
        content = "".join(part["text"] for part in parts)
    else:
        choices = raw.get("choices", [])
        if len(choices) != 1 or choices[0].get("finish_reason") != "stop":
            raise ValueError("judge response did not complete")
        content = choices[0]["message"]["content"]
    judged = json.loads(content)
    if (not isinstance(judged, dict) or set(judged) != set(SCHEMA["required"])
            or not isinstance(judged["extracted_final_answer"], str) or not isinstance(judged["reasoning"], str)
            or judged["correct"] not in ("yes", "no") or judged["strict"] is not True
            or type(judged["confidence"]) is not int):
        raise ValueError("invalid official judge response")
    return judged


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("judge endpoint redirected")


def main():
    logs = Path("/logs/verifier"); logs.mkdir(parents=True, exist_ok=True)
    question = json.loads(Path("/tests/question.json").read_text())
    submission = json.loads(Path("/hitch-evidence/final-response.json").read_text())
    if submission.get("source") != "hitch-run-result" or not isinstance(submission.get("response"), str):
        raise ValueError("canonical response evidence missing")
    config = json.loads(Path("/tests/judge.json").read_text())
    prompt = Path("/tests/judge-prompt.txt").read_text().format(question=question["question"], correct_answer=question["answer"], response=submission["response"])
    endpoint, body = judge_request(config, prompt)
    key = os.environ["HLE_JUDGE_API_KEY"]
    request = urllib.request.Request(endpoint, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    started = time.time()
    with urllib.request.build_opener(NoRedirect).open(request, timeout=300) as response:
        raw = json.load(response)
    (logs / "judge-response.json").write_text(json.dumps(raw, indent=2))
    judged = parse_judgment(config, raw)
    (logs / "judge-provenance.json").write_text(json.dumps({**config, "observed_model": raw.get("model"), "elapsed_sec": time.time()-started, "usage": raw.get("usage")}, indent=2))
    (logs / "reward.json").write_text(json.dumps({"correct": int(judged["correct"] == "yes")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        Path("/logs/verifier/grading-error.json").write_text(json.dumps({"code": "hle_judge_failed", "type": type(error).__name__}))
        raise
