"""Untrusted transport only; all permissions and action state live on the host."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

root = Path("/tmp/hitch-parameter-channel")
if len(sys.argv) == 2 and sys.argv[1] == "show":
    print(Path("/tmp/hitch-parameters.json").read_text())
else:
    capability = len(sys.argv) == 3 and sys.argv[1] == "call"
    submit = len(sys.argv) == 4 and sys.argv[1] == "submit"
    if not (capability or submit):
        raise SystemExit("Usage: python3 /tmp/hitch-parameters.py show | submit ACTION_ID FULL_PARAMETERS_JSON_FILE | call REQUEST_JSON_FILE")
    data = Path(sys.argv[2] if capability else sys.argv[3]).read_text()
    if len(data.encode()) > 1024 * 1024:
        raise SystemExit("parameter proposal exceeds 1 MiB")
    # Preserve raw JSON so the authority detects duplicate and malformed keys.
    payload = data if capability else '{"action":' + json.dumps(sys.argv[2]) + ',"parameters":' + data + '}'
    request_id = uuid.uuid4().hex
    root.mkdir(exist_ok=True)
    temporary = root / (request_id + ".tmp")
    temporary.write_text(payload)
    os.replace(temporary, root / (request_id + (".capability" if capability else "") + ".request.json"))
    response = root / (request_id + ".response.json")
    seconds = max((b["max_action_seconds"] for b in json.loads(Path("/tmp/hitch-parameters.json").read_text()).get("bindings", [])), default=60) if capability else 60
    deadline = time.monotonic() + seconds + 10
    while not response.exists():
        if time.monotonic() >= deadline:
            raise SystemExit("parameter authority response unavailable; do not assume acceptance")
        time.sleep(.1)
    value = json.loads(response.read_text())
    print(json.dumps(value))
    raise SystemExit(0 if value.get("accepted") else 1)
