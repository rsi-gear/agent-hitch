"""Deterministic synthetic service; independent of all real benchmark packages."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import sys
import threading
from urllib.request import Request, urlopen

if len(sys.argv) > 1:
    with urlopen(Request("http://127.0.0.1:8766/", data=sys.stdin.buffer.read()), timeout=5) as response:
        sys.stdout.buffer.write(response.read())
    sys.exit(0)

tools = json.loads(Path("/runtime/tools.json").read_text())
state = {"count": 0, "sealed": False}
token = secrets.token_hex(32)
responses = {}
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def reply(self, status, value):
        self.send_response(status); self.end_headers(); self.wfile.write(json.dumps(value).encode())
    def do_GET(self):
        self.reply(200, {"ready": True})
    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            if self.server.server_port == 8765:
                if self.path != "/call" or self.headers.get("Authorization") != "Bearer " + token or state["sealed"]:
                    return self.reply(403, {"error": "forbidden"})
                assert value["name"] == tools[0]["name"]
                assert type(value["arguments"]["amount"]) is int
                state["count"] += value["arguments"]["amount"]
                return self.reply(200, {"count": state["count"]})
            rid, phase = value["request_id"], value["phase"]
            if rid in responses:
                return self.reply(200, responses[rid])
            if phase == "prepare":
                output = {"ready": True, "session_ref": "counter", "candidate_input_refs": [], "tool_bindings": [{"endpoint": "http://counter:8765/", "token": token, "tools": tools}]}
            elif phase == "quiesce":
                state["sealed"] = True
                output = {"quiesced": True}
            elif phase == "snapshot":
                assert state["sealed"]
                data = json.dumps(state).encode()
                Path("/evidence").mkdir(exist_ok=True); Path("/evidence/counter.json").write_bytes(data)
                output = {"artifacts": [{"path": "/evidence/counter.json", "bytes": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest(), "source": "controller"}]}
            elif phase == "cleanup":
                state["sealed"] = True
                output = {"cleaned": True}
            else:
                raise ValueError("unknown phase")
            responses[rid] = {"schema_version": "1", "request_id": rid, "status": "ok", "output": output}
            self.reply(200, responses[rid])

admin = ThreadingHTTPServer(("127.0.0.1", 8766), Handler)
threading.Thread(target=admin.serve_forever, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
