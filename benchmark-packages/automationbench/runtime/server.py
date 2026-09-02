"""Isolated official simulator: candidate call route and loopback admin plane."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import sys
import threading
from urllib.request import Request, urlopen
from official import initialize, tools_for, call


def serve():
    row = json.loads(Path("/data/task.json").read_text())
    env, state = initialize(row)
    tools = tools_for(env)
    audit = []
    responses = {}
    guard = threading.Lock()
    session = {"token": None, "sealed": False, "cleaned": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"ready": True})

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 1048576:
                return self.reply(413, {"error": "request too large"})
            try:
                request = json.loads(self.rfile.read(length))
                with guard:
                    if self.server.server_port == 8766:
                        return self.admin(request)
                    if self.path != "/call":
                        return self.reply(404, {"error": "unknown route"})
                    if not session["token"] or self.headers.get("Authorization") != "Bearer " + session["token"] or session["sealed"]:
                        return self.reply(403, {"error": "tool session closed or unauthorized"})
                    if request["name"] not in {t["name"] for t in tools} or not isinstance(request["arguments"], dict):
                        return self.reply(400, {"error": "invalid tool request"})
                    if "world" in request["arguments"]:
                        return self.reply(400, {"error": "world is a server-managed argument"})
                    try:
                        result = call(env, state, request["name"], request["arguments"])
                    except Exception as error:
                        result = {"tool_error": type(error).__name__, "message": str(error)}
                    audit.append({"seq": len(audit) + 1, "name": request["name"], "arguments": request["arguments"], "result": result})
                    self.reply(200, result)
            except Exception as error:
                self.reply(500, {"error": type(error).__name__, "message": str(error)})

        def admin(self, request):
            rid = request["request_id"]
            if rid in responses:
                return self.reply(200, responses[rid])
            phase = request["phase"]
            if phase == "prepare":
                if session["sealed"] or session["cleaned"]:
                    raise ValueError("cannot restart a used session")
                session["token"] = session["token"] or secrets.token_urlsafe(32)
                output = {"ready": True, "session_ref": request["logical_trial_id"], "candidate_input_refs": [], "tool_bindings": [{"endpoint": "http://simulator:8765/", "token": session["token"], "tools": tools}]}
            elif phase == "quiesce":
                session["sealed"] = True; session["token"] = None
                output = {"quiesced": True}
            elif phase == "snapshot":
                if not session["sealed"]:
                    raise ValueError("quiesce required before snapshot")
                snapshot = {"sealed": True, "task_contract_sha256": state["_task_contract_sha256"], "world": state["world"].model_dump(mode="json"), "audit": audit}
                data = json.dumps(snapshot, ensure_ascii=False).encode()
                target = Path("/evidence/snapshot.json"); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
                output = {"artifacts": [{"path": str(target), "bytes": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest(), "source": "controller", "media_type": "application/json"}]}
            elif phase == "cleanup":
                session["token"] = None; session["sealed"] = True; session["cleaned"] = True
                output = {"cleaned": True}
            else:
                raise ValueError("unknown phase")
            response = {"schema_version": "1", "request_id": rid, "status": "ok", "output": output}
            responses[rid] = response
            self.reply(200, response)

    candidate = ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    admin = ThreadingHTTPServer(("127.0.0.1", 8766), Handler)
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    candidate.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "hook":
        data = sys.stdin.buffer.read()
        request = Request("http://127.0.0.1:8766/", data=data, headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=50) as response:
            sys.stdout.buffer.write(response.read())
    else:
        serve()
