#!/usr/bin/env python3
"""Check an already authenticated CLIProxy service without reading OAuth files."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cliproxy_runtime import ResponsesClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="reachable proxy API base, including /v1")
    parser.add_argument("--model", required=True, help="explicit Codex model or unique Codex-only alias")
    parser.add_argument("--api-key-env", default="HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY")
    parser.add_argument("--allow-http", action="store_true")
    args = parser.parse_args()
    try:
        client = ResponsesClient(args.base_url, os.environ.get(args.api_key_env), args.model, args.allow_http)
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}
        result = client.evaluate([{"role": "user", "content": 'Return exactly {"ok":true}.'}], schema, "hitch_proxy_smoke")
        if result != {"ok": True}: raise ValueError("proxy smoke returned an unexpected result")
        print(json.dumps({"status": "ok", "transport": client.provenance}, indent=2))
        return 0
    except Exception as error:
        # Print no raw provider payload, environment values or OAuth material.
        message = str(error)
        secret = os.environ.get(args.api_key_env)
        if secret: message = message.replace(secret, "[REDACTED]")
        print(json.dumps({"status": "error", "type": type(error).__name__, "message": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
