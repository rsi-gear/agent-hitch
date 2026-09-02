"""Official HLE extraction/equivalence prompt with a pinned structured judge.

The original prompt and grader source are supplied by the producer at an exact
Git revision. API/parse failures do not produce zero scores.
"""
import json
import os
from pathlib import Path
import time
import urllib.request


def main():
    logs = Path("/logs/verifier"); logs.mkdir(parents=True, exist_ok=True)
    question = json.loads(Path("/tests/question.json").read_text())
    submission = json.loads(Path("/hitch-evidence/final-response.json").read_text())
    if submission.get("source") != "hitch-run-result" or not isinstance(submission.get("response"), str):
        raise ValueError("canonical response evidence missing")
    config = json.loads(Path("/tests/judge.json").read_text())
    prompt = Path("/tests/judge-prompt.txt").read_text().format(question=question["question"], correct_answer=question["answer"], response=submission["response"])
    schema = {"type": "object", "properties": {"extracted_final_answer": {"type": "string"}, "reasoning": {"type": "string"},
        "correct": {"type": "string", "enum": ["yes", "no"]}, "confidence": {"type": "integer"}, "strict": {"type": "boolean", "enum": [True]}},
        "required": ["extracted_final_answer", "reasoning", "correct", "confidence", "strict"], "additionalProperties": False}
    body = {"model": config["model"], "max_completion_tokens": 4096, "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "ExtractedAnswer", "strict": True, "schema": schema}}}
    key = os.environ["HLE_JUDGE_API_KEY"]
    request = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    started = time.time()
    with urllib.request.urlopen(request, timeout=300) as response:
        raw = json.load(response)
    (logs / "judge-response.json").write_text(json.dumps(raw, indent=2))
    judged = json.loads(raw["choices"][0]["message"]["content"])
    if set(judged) != set(schema["required"]) or judged["correct"] not in ["yes", "no"] or judged["strict"] is not True or type(judged["confidence"]) is not int:
        raise ValueError("invalid official judge response")
    (logs / "judge-provenance.json").write_text(json.dumps({**config, "observed_model": raw.get("model"), "elapsed_sec": time.time()-started, "usage": raw.get("usage")}, indent=2))
    (logs / "reward.json").write_text(json.dumps({"correct": int(judged["correct"] == "yes")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        Path("/logs/verifier/grading-error.json").write_text(json.dumps({"code": "hle_judge_failed", "type": type(error).__name__}))
        raise
