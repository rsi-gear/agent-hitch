"""Run byte-identical JobBench code with its opt-in Responses transport facade."""
import json
import os
from pathlib import Path
import runpy
import sys
from types import ModuleType
from hitch_cliproxy import ChatBridge


def main():
    tests = Path(__file__).resolve().parent
    config = json.loads((tests / "judge.json").read_text())
    if config.get("profile") != "cliproxy-codex": raise ValueError("CLIProxy wrapper requires explicit profile")
    os.environ["JUDGE_MODEL"] = config["model"]
    os.environ["JUDGE_API_BASE"] = config["base_url"]
    facade = ModuleType("openai")
    facade.OpenAI = lambda **kwargs: ChatBridge(config, **kwargs)
    original = sys.modules.get("openai")
    argv = sys.argv[:]
    try:
        sys.modules["openai"] = facade
        sys.argv[0] = str(tests / "judge.py")
        runpy.run_path(str(tests / "judge.py"), run_name="__main__")
    finally:
        sys.argv[:] = argv
        if original is None: sys.modules.pop("openai", None)
        else: sys.modules["openai"] = original


if __name__ == "__main__":
    main()
