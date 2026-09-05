"""Task-owned simulator that continuously materializes verifier state."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from official import initialize, tools_for, call


def serve():
    row = json.loads(Path("/data/task.json").read_text())
    env, state = initialize(row)
    tools = tools_for(env)
    audit = []
    guard = threading.Lock()

    def snapshot():
        value = {
            "sealed": True,
            "task_contract_sha256": state["_task_contract_sha256"],
            "world": state["world"].model_dump(mode="json"),
            "audit": audit,
        }
        data = json.dumps(value, ensure_ascii=False).encode()
        target = Path("/evidence/snapshot.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(target)
        return len(data), hashlib.sha256(data).hexdigest()

    snapshot()

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
                    if self.path != "/call":
                        return self.reply(404, {"error": "unknown route"})
                    if request["name"] not in {t["name"] for t in tools} or not isinstance(request["arguments"], dict):
                        return self.reply(400, {"error": "invalid tool request"})
                    if "world" in request["arguments"]:
                        return self.reply(400, {"error": "world is a server-managed argument"})
                    try:
                        result = call(env, state, request["name"], request["arguments"])
                    except Exception as error:
                        result = {"tool_error": type(error).__name__, "message": str(error)}
                    audit.append({"seq": len(audit) + 1, "name": request["name"], "arguments": request["arguments"], "result": result})
                    snapshot()
                    self.reply(200, result)
            except Exception as error:
                self.reply(500, {"error": type(error).__name__, "message": str(error)})

    candidate = ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    candidate.serve_forever()


if __name__ == "__main__":
    serve()
