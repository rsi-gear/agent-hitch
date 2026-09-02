"""Generic benchmark package hooks, tool binding and metric normalization.

Runs in the trusted Harbor worker. Package business code is never imported here.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
from pathlib import Path
import shlex
import tempfile
import uuid


def descriptor(environment_dir):
    path = Path(environment_dir).parent / ".hitch-benchmark.json"
    return json.loads(path.read_text()) if path.is_file() else None


class BenchmarkSession:
    def __init__(self, env, config):
        self.env, self.config = env, config
        self.responses = {}
        self.started = False
        self.stopped = False
        self.failure = None
        self.journal = env.trial_paths.trial_dir / "benchmark-lifecycle.json"

    async def phase(self, phase):
        if phase in self.responses:
            return self.responses[phase]
        hook = self.config["task"]["lifecycle"][phase]
        labels = self.env._hitch_ownership_labels
        request = {
            "schema_version": "1",
            "request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, self.env.session_id + ":" + phase)),
            "phase": phase, "task_id": self.config["task_id"],
            "logical_trial_id": self.env.session_id, "execution_index": 0,
            "lease_id": labels.get("io.hitch.lease-id", self.env.session_id),
            "epoch": int(labels.get("io.hitch.lease-epoch", "1")),
            "profile_digest": self.config["profile_digest"], "input_refs": [],
        }
        # Harbor's exec API accepts shell text. Quote each argv and stdin byte;
        # no task text is interpolated as shell syntax.
        command = "printf %s " + shlex.quote(json.dumps(request)) + " | " + shlex.join(hook["argv"])
        try:
            result = await self.env.service_exec(command, service=hook["target"].split(":", 1)[1], timeout_sec=math.ceil(hook["timeout_ms"] / 1000))
            if result.return_code != 0:
                raise RuntimeError(f"hook {phase} exited {result.return_code}: {result.stderr}")
            if len(result.stdout or "") > 1024 * 1024:
                raise RuntimeError("oversized hook response")
            response = json.loads(result.stdout)
            if set(response) != {"schema_version", "request_id", "status", "output"}:
                raise RuntimeError(f"invalid hook response fields: {phase}")
            if response.get("schema_version") != "1" or response.get("request_id") != request["request_id"] or response.get("status") != "ok":
                raise RuntimeError(f"invalid/failed hook response: {phase}")
            output = response["output"]
            required = {"prepare": "ready", "quiesce": "quiesced", "cleanup": "cleaned"}.get(phase)
            if required and output.get(required) is not True:
                raise RuntimeError(f"hook {phase} did not confirm {required}")
            if phase == "snapshot":
                paths = self.config["task"]["submission"]["paths"]
                artifacts = output.get("artifacts", [])
                if not isinstance(artifacts, list) or any(type(a.get("bytes")) is not int or a["bytes"] < 0 for a in artifacts):
                    raise RuntimeError("invalid snapshot size metadata")
                if sorted(a.get("path", "") for a in artifacts) != sorted(paths):
                    raise RuntimeError("snapshot artifact membership mismatch")
                size = sum(a["bytes"] for a in artifacts)
                if size > self.config["task"]["submission"]["max_bytes"] or size < 1:
                    raise RuntimeError("snapshot size outside package limit")
            self.responses[phase] = response
            self.write_journal()
            return response
        except BaseException as error:
            self.failure = {"phase": phase, "error": type(error).__name__}
            self.write_journal()
            raise

    def write_journal(self):
        # Never persist tool tokens or opaque management handles.
        phases = {p: {"request_id": r["request_id"], "status": r["status"]} for p, r in self.responses.items()}
        self.journal.parent.mkdir(parents=True, exist_ok=True)
        self.journal.write_text(json.dumps({"schema_version": "1", "phases": phases, "failure": self.failure}, indent=2))

    async def prepare(self):
        self.started = True
        response = await self.phase("prepare")
        bindings = response["output"]["tool_bindings"]
        expected = self.config["task"]["driver"]["config"]
        if len(bindings) != 1 or bindings[0]["endpoint"] != expected["endpoint"] or bindings[0]["tools"] != self.config["tools"]:
            raise RuntimeError("prepared tool binding differs from locked definition")
        binding = bindings[0]
        if not isinstance(binding.get("token"), str) or len(binding["token"]) < 32:
            raise RuntimeError("missing per-trial tool authorization")
        with tempfile.TemporaryDirectory(prefix="hitch-binding-") as temp:
            file = Path(temp) / "binding.json"
            file.write_text(json.dumps(binding)); file.chmod(0o600)
            await self.env.upload_file(file, "/tmp/hitch-tool-binding.json")
        await self.env.upload_file(Path(__file__).with_name("hitch_tool_client.mjs"), "/tmp/hitch-tools.mjs")

    async def snapshot(self):
        if self.stopped:
            return
        async def collect():
            await self.phase("quiesce")
            await self.phase("snapshot")
        budget = self.config["profile"]["budget"]["collection_timeout_ms"]
        await asyncio.wait_for(collect(), budget / 1000)
        self.stopped = True

    async def cleanup(self):
        if self.started:
            await self.phase("cleanup")


def candidate_instruction(instruction, environment):
    config = descriptor(environment.environment_dir)
    if config is None:
        return instruction, None
    return instruction + "\n\nTools are available through the locked tool-server bridge. Run `node /tmp/hitch-tools.mjs list` to read tool descriptions and JSON schemas. Invoke a tool using `node /tmp/hitch-tools.mjs TOOL_NAME 'JSON_ARGUMENTS'` (or pass - and JSON via stdin). Complete the requested workflow with these simulated service tools.\n", int(config["agent_timeout_sec"] * 1000)


def normalize_rewards(verifier, result):
    config = descriptor(verifier.task.paths.environment_dir)
    if config is None:
        return result
    journal = json.loads((verifier.trial_paths.trial_dir / "benchmark-lifecycle.json").read_text())
    if journal["failure"] or not {"prepare", "quiesce", "snapshot"} <= journal["phases"].keys():
        raise RuntimeError("benchmark lifecycle did not produce a valid snapshot")
    directory = verifier.trial_paths.verifier_dir
    if (directory / "reward.txt").exists():
        raise RuntimeError("standard packages require only reward.json")
    # Read the original JSON before Harbor/Pydantic numeric coercion: bools and
    # numeric strings must not become valid binary scores via the result model.
    raw = json.loads((directory / "reward.json").read_text())
    if not isinstance(raw, dict):
        raise RuntimeError("invalid grader metric object")
    mapped = {}
    for name, metric in config["metrics"].items():
        field = config["task"]["grading"]["metric_map"][name]
        if field not in raw:
            raise RuntimeError(f"metric_missing: {field}")
        value = raw[field]
        if type(value) not in (float, int) or not math.isfinite(value) or not metric["range"][0] <= value <= metric["range"][1] or (metric["type"] == "binary" and value not in (0, 1)):
            raise RuntimeError(f"metric_invalid: {field}")
        mapped[name] = value
    (directory / "benchmark-rewards.json").write_text(json.dumps({"raw": raw, "metrics": mapped, "primary_metric": config["primary_metric"], "source_task_id": config["task"]["source_task_id"], "task_digest": config["task_digest"]}, indent=2))
    return result.model_copy(update={"rewards": {**raw, "reward": mapped[config["primary_metric"]]}})
