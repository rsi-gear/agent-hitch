"""Exercise an installed Compose binary against a local, isolated fake Engine.

No Docker daemon is contacted. The fake Engine rejects image enumeration with
the reported containerd message-size failure, while allowing project cleanup.
Run manually with Python 3.11+ and Docker Compose on PATH; no Harbor is needed.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit


PROJECT = "hitch-compose-cleanup-canary"
IMAGE_ERROR = (
    "rpc error: code = ResourceExhausted desc = grpc: received message larger "
    "than max (16777217 vs. 16777216)"
)
OWNERSHIP = {
    "io.hitch.root-id": "a" * 24,
    "io.hitch.provider": "local-docker",
    "io.hitch.eval-id": "eval_" + "b" * 32,
    "io.hitch.work-id": "work_" + "c" * 32,
    "io.hitch.lease-id": "lease_" + "d" * 32,
    "io.hitch.lease-epoch": "1",
}


class FakeEngine:
    def __init__(self):
        self.requests = []
        self.containers = {"a" * 64: "main", "b" * 64: "orphan"}
        self.network = PROJECT + "_default"
        self.volume = PROJECT + "_data"
        self.network_present = True
        self.volume_present = True
        self.lock = threading.Lock()

    def labels(self, kind, value):
        return {**OWNERSHIP, "com.docker.compose.project": PROJECT,
                "com.docker.compose." + kind: value}

    def container(self, identifier, service):
        return {
            "Id": identifier, "Names": [f"/{PROJECT}-{service}-1"],
            "Image": PROJECT + "-main", "ImageID": "sha256:" + "c" * 64,
            "State": "running", "Status": "Up 1 minute",
            "Labels": {**self.labels("service", service),
                       "com.docker.compose.config-hash": "fixture",
                       "com.docker.compose.container-number": "1",
                       "com.docker.compose.oneoff": "False"},
            "NetworkSettings": {"Networks": {self.network: {"NetworkID": "d" * 64}}},
            "Mounts": [{"Type": "volume", "Name": self.volume, "Destination": "/data"}],
        }

    def network_info(self):
        return {"Id": "d" * 64, "Name": self.network, "Driver": "bridge",
                "Scope": "local", "Labels": self.labels("network", "default"), "Containers": {}}

    def volume_info(self):
        return {"Name": self.volume, "Driver": "local", "Scope": "local",
                "Labels": self.labels("volume", "data"), "Mountpoint": "/fake/data"}

    def handle(self, method, target):
        url = urlsplit(target)
        path = re.sub(r"^/v[0-9.]+(?=/)", "", url.path)
        self.requests.append({"method": method, "path": path, "query": parse_qs(url.query)})
        if path == "/_ping":
            return 200, b"OK"
        if path == "/version":
            return 200, {"ApiVersion": "1.47", "MinAPIVersion": "1.24",
                         "Version": "fake-engine", "Os": "linux", "Arch": "amd64"}
        if path == "/containers/json" and method == "GET":
            return 200, [self.container(identifier, service)
                         for identifier, service in self.containers.items()]
        if path == "/networks" and method == "GET":
            return 200, [self.network_info()] if self.network_present else []
        if path.startswith("/networks/"):
            if method == "GET":
                return 200, self.network_info()
            if method == "DELETE":
                self.network_present = False
                return 204, None
        if path == "/volumes" and method == "GET":
            return 200, {"Volumes": [self.volume_info()] if self.volume_present else [], "Warnings": []}
        if path == "/volumes/" + self.volume:
            if method == "GET":
                return 200, self.volume_info()
            if method == "DELETE":
                self.volume_present = False
                return 204, None
        if path == "/images/json" and method == "GET":
            return 500, {"message": IMAGE_ERROR}
        match = re.fullmatch(r"/containers/([a-f0-9]+)(/stop|/json)?", path)
        if match and match[1] in self.containers:
            identifier, operation = match.groups()
            if method == "POST" and operation == "/stop":
                return 204, None
            if method == "DELETE" and operation is None:
                del self.containers[identifier]
                return 204, None
            if method == "GET" and operation == "/json":
                info = self.container(identifier, self.containers[identifier])
                return 200, {**info, "Name": info["Names"][0],
                             "Config": {"Labels": info["Labels"], "Image": info["Image"]},
                             "State": {"Running": True, "Status": "running"}}
        return 501, {"message": f"Unimplemented fake Engine request: {method} {path}"}


def handler_for(engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def respond(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with engine.lock:
                status, response = engine.handle(self.command, self.path)
                engine.requests[-1]["status"] = status
            body = response if isinstance(response, bytes) else (
                json.dumps(response).encode() if response is not None else b""
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("API-Version", "1.47")
            self.send_header("OSType", "linux")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        do_HEAD = respond
        do_GET = respond
        do_POST = respond
        do_DELETE = respond
    return Handler


def run_case(binary, compose_file, config_dir, remove_images):
    engine = FakeEngine()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(engine))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = dict(os.environ)
    for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION"):
        environment.pop(key, None)
    # Both endpoint and config are pinned so no personal context or daemon can
    # become the target. Each arm gets a fresh fake project with the same labels.
    environment.update(DOCKER_HOST=f"tcp://127.0.0.1:{server.server_port}",
                       DOCKER_CONFIG=str(config_dir), COMPOSE_ANSI="never")
    command = [binary, "-f", str(compose_file), "-p", PROJECT,
               "down", "--volumes", "--remove-orphans"]
    if remove_images:
        command += ["--rmi", "local"]
    try:
        result = subprocess.run(command, env=environment, cwd=compose_file.parent,
                                capture_output=True, text=True, timeout=30)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    return {
        "remove_images": remove_images, "command": command,
        "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
        "requests": engine.requests,
        "remaining": {"containers": list(engine.containers),
                      "network": engine.network_present, "volume": engine.volume_present},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory for the result.json evidence")
    parser.add_argument("--compose-binary", default=shutil.which("docker-compose"))
    args = parser.parse_args()
    if not args.compose_binary:
        parser.error("docker-compose was not found; pass --compose-binary")
    args.output.mkdir(parents=True, exist_ok=True)
    version = subprocess.run([args.compose_binary, "version"], capture_output=True,
                             text=True, check=True, timeout=10).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="hitch-compose-engine-") as temporary:
        root = Path(temporary)
        config_dir = root / "docker-config"
        config_dir.mkdir()
        compose_file = root / "compose.json"
        compose_file.write_text(json.dumps({
            "services": {"main": {"build": {"context": "."}, "labels": OWNERSHIP,
                                   "volumes": ["data:/data"]}},
            "networks": {"default": {"labels": OWNERSHIP}},
            "volumes": {"data": {"labels": OWNERSHIP}},
        }))
        cases = [run_case(args.compose_binary, compose_file, config_dir, remove_images)
                 for remove_images in (True, False)]
    evidence = {"compose_version": version, "engine": "local fake HTTP Engine; no daemon",
                "image_enumeration_error": IMAGE_ERROR, "cases": cases}
    (args.output / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    baseline, fixed = cases
    assert baseline["returncode"] != 0 and IMAGE_ERROR in baseline["stderr"], baseline
    assert baseline["remaining"] == {"containers": [], "network": True, "volume": True}, baseline
    assert any(request["path"] == "/images/json" for request in baseline["requests"]), baseline
    assert all(request["status"] < 400 or request["path"] == "/images/json"
               for request in baseline["requests"]), baseline
    assert fixed["returncode"] == 0, fixed
    assert not any(request["path"].startswith("/images/") for request in fixed["requests"]), fixed
    assert all(request["status"] < 400 for request in fixed["requests"]), fixed
    assert fixed["remaining"] == {"containers": [], "network": False, "volume": False}, fixed
    print(f"{version}: --rmi local reproduces image-list failure; without --rmi project cleanup succeeds")
    print(f"Evidence: {args.output.resolve() / 'result.json'}")


if __name__ == "__main__":
    main()
