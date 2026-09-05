"""Synthetic screenshot/action canary. Does not run an OSWorld environment."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import struct
import sys
import threading
from urllib.request import Request, urlopen
import zlib

if len(sys.argv) > 1:
    with urlopen(Request("http://127.0.0.1:8766/", data=sys.stdin.buffer.read()), timeout=5) as response:
        sys.stdout.buffer.write(response.read())
    sys.exit(0)


def chunk(kind, data):
    return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))


pixels = bytearray()
for y in range(180):
    pixels.append(0)
    for x in range(320):
        color = (245, 245, 245)
        if 24 <= x < 104 and 30 <= y < 150:
            color = (230, 45, 35)
        if 190 <= x < 295 and 60 <= y < 120:
            color = (20, 65, 230)
        pixels.extend(color)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", 320, 180, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
tools = json.loads(Path("/runtime/tools.json").read_text())
state = {"seq": 0, "click_count": 0, "clicked_blue": False, "sealed": False, "audit": [], "screenshot_sha256": hashlib.sha256(png).hexdigest()}
token = secrets.token_hex(32)
responses = {}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        self.send_response(status); self.end_headers(); self.wfile.write(json.dumps(value).encode())

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ready": True})

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size < 1048576:
            return self.reply(413, {"error": "request too large"})
        value = json.loads(self.rfile.read(size))
        with lock:
            if self.server.server_port == 8765:
                if self.path != "/call" or self.headers.get("Authorization") != "Bearer " + token or state["sealed"]:
                    return self.reply(403, {"error": "closed or unauthorized"})
                name, args = value.get("name"), value.get("arguments")
                if name == "observe" and args == {}:
                    state["seq"] += 1
                    return self.reply(200, {"protocol": "hitch-tool-result@1", "content": [
                        {"type": "text", "text": json.dumps({"seq": state["seq"], "width": 320, "height": 180})},
                        {"type": "image", "mimeType": "image/png", "data": base64.b64encode(png).decode()}]})
                if name != "click" or not isinstance(args, dict) or set(args) != {"seq", "x", "y"} or any(type(v) is not int for v in args.values()):
                    return self.reply(400, {"error": "invalid action"})
                if not state["seq"] or args["seq"] != state["seq"] or state["click_count"]:
                    return self.reply(409, {"error": "stale observation or click budget exhausted"})
                if not 0 <= args["x"] < 320 or not 0 <= args["y"] < 180:
                    return self.reply(400, {"error": "pixel out of bounds"})
                state["click_count"] += 1
                state["clicked_blue"] = 190 <= args["x"] < 295 and 60 <= args["y"] < 120
                state["audit"].append(args)
                return self.reply(200, {"done": True})
            rid, phase = value["request_id"], value["phase"]
            if rid in responses:
                return self.reply(200, responses[rid])
            if phase == "prepare":
                output = {"ready": True, "session_ref": "synthetic-desktop", "candidate_input_refs": [], "tool_bindings": [{"endpoint": "http://counter:8765/", "token": token, "tools": tools}]}
            elif phase == "quiesce":
                state["sealed"] = True
                output = {"quiesced": True}
            elif phase == "snapshot":
                assert state["sealed"]
                data = json.dumps(state).encode()
                Path("/evidence").mkdir(exist_ok=True); Path("/evidence/counter.json").write_bytes(data)
                Path("/evidence/screen.png").write_bytes(png)
                output = {"artifacts": [{"path": filename, "bytes": len(content), "digest": "sha256:" + hashlib.sha256(content).hexdigest(), "source": "controller"} for filename, content in [("/evidence/counter.json", data), ("/evidence/screen.png", png)]]}
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
