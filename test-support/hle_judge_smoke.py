"""HLE transport substitution preserves the schema and rejects invalid judges."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import sys

spec = importlib.util.spec_from_file_location("hle_grade", Path(__file__).resolve().parents[1] / "benchmark-packages/hle/runtime/grade.py")
grade = importlib.util.module_from_spec(spec); spec.loader.exec_module(grade)


class JudgeContract(unittest.TestCase):
    def setUp(self):
        self.config = {"api": "responses", "base_url": "https://api.deepseek.com/", "model": "deepseek-v4-flash"}
        self.judged = {"extracted_final_answer": "42", "reasoning": "matches", "correct": "yes", "confidence": 100, "strict": True}
        self.raw = {"status": "completed", "output": [{"type": "reasoning"}, {"type": "message", "content": [{"type": "output_text", "text": json.dumps(self.judged)}]}]}

    def test_transport_preserves_prompt_schema_and_budget(self):
        endpoint, body = grade.judge_request(self.config, "unchanged official prompt")
        self.assertEqual(endpoint, "https://api.deepseek.com/responses")
        self.assertEqual(body["input"][0]["content"], "unchanged official prompt")
        self.assertEqual(body["text"]["format"]["schema"], grade.SCHEMA)
        self.assertEqual(body["max_output_tokens"], 4096)
        self.assertEqual(body["tools"], [])
        self.assertEqual(body["tool_choice"], "none")
        self.assertEqual(grade.parse_judgment(self.config, self.raw), self.judged)
        endpoint, old = grade.judge_request({"model": "o3-mini-2025-01-31"}, "unchanged official prompt")
        self.assertEqual(endpoint, "https://api.openai.com/v1/chat/completions")
        self.assertEqual(old["response_format"]["json_schema"]["schema"], body["text"]["format"]["schema"])
        self.assertEqual(grade.parse_judgment({}, {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(self.judged)}}]}), self.judged)

    def test_false_is_valid_but_transport_and_parse_errors_are_not(self):
        for status in ("incomplete", "failed", "in_progress"):
            with self.assertRaises(ValueError):
                grade.parse_judgment(self.config, {**self.raw, "status": status})
        for extra in ({"type": "function_call"}, {"type": "web_search_call"}):
            with self.assertRaises(ValueError):
                grade.parse_judgment(self.config, {**self.raw, "output": self.raw["output"] + [extra]})
        for content in ({"type": "refusal", "refusal": "no"}, {"type": "output_text", "text": "{"}):
            with self.assertRaises(ValueError):
                grade.parse_judgment(self.config, {"status": "completed", "output": [{"type": "message", "content": [content]}]})
        for field, value in (("confidence", True), ("strict", False), ("correct", "maybe"), ("reasoning", None), ("extracted_final_answer", 42)):
            raw = copy.deepcopy(self.raw)
            raw["output"][1]["content"][0]["text"] = json.dumps({**self.judged, field: value})
            with self.assertRaises(ValueError):
                grade.parse_judgment(self.config, raw)
        for finish in ("length", "tool_calls", "content_filter"):
            with self.assertRaises(ValueError):
                grade.parse_judgment({}, {"choices": [{"finish_reason": finish, "message": {"content": json.dumps(self.judged)}}]})
        self.raw["output"][1]["content"][0]["text"] = json.dumps({**self.judged, "correct": "no"})
        self.assertEqual(grade.parse_judgment(self.config, self.raw)["correct"], "no")

    def test_credential_destination_is_explicit_and_redirects_fail(self):
        for url in ("http://api.deepseek.com", "https://key@api.deepseek.com", "https://api.deepseek.com/?key=secret", "https://api.deepseek.com/#secret", "file:///tmp/judge"):
            with self.assertRaises(ValueError):
                grade.judge_request({**self.config, "base_url": url}, "question")
        with self.assertRaises(ValueError):
            grade.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example")

    def test_explicit_schema_message_keeps_original_user_prompt(self):
        config = {**self.config, "schema_instruction": "system-json-schema@1"}
        _, body = grade.judge_request(config, "original user prompt")
        self.assertEqual(body["input"][1], {"role": "user", "content": "original user prompt"})
        self.assertEqual(body["input"][0]["role"], "system")
        self.assertEqual(json.loads(body["input"][0]["content"].split("\n", 1)[1]), grade.SCHEMA)
        self.assertNotIn("original user prompt", body["input"][0]["content"])
        with self.assertRaises(ValueError):
            grade.judge_request({**self.config, "schema_instruction": "implicit-repair"}, "prompt")


if __name__ == "__main__":
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(JudgeContract))
    if not result.wasSuccessful():
        sys.exit(1)
    print("HLE provider schema and failure gates passed")
