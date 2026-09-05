"""Small candidate-facing CLI for the task-owned AutomationBench tool server."""

from __future__ import annotations

import json
import os
import sys
from urllib.request import Request, urlopen


if len(sys.argv) != 3:
    raise SystemExit("usage: python /runtime/call.py TOOL_NAME JSON_ARGUMENTS")

arguments = json.loads(sys.argv[2])
if not isinstance(arguments, dict):
    raise SystemExit("JSON_ARGUMENTS must be an object")
body = json.dumps({"name": sys.argv[1], "arguments": arguments}).encode()
base_url = os.environ.get("AUTOMATIONBENCH_API_URL", "http://simulator:8765").rstrip("/")
request = Request(f"{base_url}/call", data=body, headers={"Content-Type": "application/json"})
with urlopen(request, timeout=60) as response:
    sys.stdout.write(response.read().decode())
    sys.stdout.write("\n")
