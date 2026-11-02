"""Manual real-Harbor/Compose verifier canary; never contacts a Docker daemon.

Run with Harbor 0.21.0's Python and an installed standalone Compose executable:
    python test-support/harbor_verifier_lifecycle_canary.py /tmp/verifier-canary

Task parsing, Trial construction, environment factories, session naming,
DockerEnvironment.start, verifier execution/timeout handling and regrade are
real. Only daemon I/O is replaced, including the scoring command's execution.
Compose itself resolves the generated files. No agent or model is run.
"""
import argparse
import asyncio
from contextlib import ExitStack
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))

from harbor.environments.base import ExecResult
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.task import Task
from harbor.models.trial.config import TrialConfig
from harbor.tasks.client import TaskDownloadResult
from harbor.trial.errors import VerifierTimeoutError
from harbor.trial.regrade import RegradeTrial
from harbor.trial.single_step import SingleStepTrial
import harbor.trial.trial as harbor_trial
import hitch_harbor_environment as provider
from hitch_harbor_task_resources import inspect_task

CANDIDATE = "sha256:" + "a" * 64
SIMULATOR = "sha256:" + "b" * 64
VERIFIER = "sha256:" + "c" * 64
ROLE = "io.hitch.environment-role"
OWNERSHIP = {
    "io.hitch.root-id": "a" * 24, "io.hitch.provider": "local-docker",
    "io.hitch.eval-id": "eval_" + "b" * 32, "io.hitch.work-id": "work_" + "c" * 32,
    "io.hitch.lease-id": "lease_" + "d" * 32, "io.hitch.lease-epoch": "1",
}
CANDIDATE_RESOLVED = {"registry.test/candidate:v1": "registry.test/candidate@sha256:" + "d" * 64}
VERIFIER_RESOLVED = {"registry.test/verifier:v1": "registry.test/verifier@sha256:" + "e" * 64}


class DaemonBoundary:
    def __init__(self, binary, root):
        self.binary, self.root = binary, root
        self.commands, self.configs, self.environments = [], [], []
        self.startup_mode = self.score_mode = "ok"
        self.entered = asyncio.Event()
        self.scoring_calls = 0

    def compose_config(self, environment):
        command = [self.binary, "--project-name", environment.session_id.lower().replace(".", "-"),
                   "--project-directory", str(environment.environment_dir)]
        for source in environment._docker_compose_paths:
            command += ["-f", str(source)]
        process_env = environment._compose_env_vars(include_os_env=False)
        process_env.update(DOCKER_HOST="unix:///tmp/hitch-canary-no-daemon.sock",
                           DOCKER_CONFIG=str(self.root / "empty-docker-config"), DOCKER_CONTEXT="default")
        return subprocess.run(command + ["config", "--format", "json"], env=process_env,
                              capture_output=True, text=True, check=True, timeout=15).stdout

    async def compose(self, environment, command, *args, **kwargs):
        if environment not in self.environments:
            self.environments.append(environment)
        self.commands.append({"session": environment.session_id, "command": list(command)})
        if command[:1] == ["config"]:
            return ExecResult(return_code=0, stdout=self.compose_config(environment), stderr="")
        if command[:1] == ["up"]:
            self.configs.append({
                "session": environment.session_id,
                "role": environment._hitch_environment_role,
                "context": environment.environment_dir.relative_to(self.root).as_posix(),
                "resolved_images": dict(environment._hitch_resolved_images),
                "compose": json.loads(self.compose_config(environment)),
            })
            if self.startup_mode != "ok":
                self.entered.set()
                if self.startup_mode == "error":
                    raise RuntimeError("fixture daemon startup failed")
                await asyncio.Event().wait()
        if command[:1] == ["exec"] and "/tests/test.sh" in command[-1] and not command[-1].startswith("chmod "):
            self.scoring_calls += 1
            if self.score_mode == "block":
                self.entered.set()
                await asyncio.Event().wait()
            environment.trial_paths.reward_text_path.write_text("1\n")
        return ExecResult(return_code=0, stdout="", stderr="")


def write_task(root, *, implicit=False):
    for directory in ("environment", "tests", "runtime/payload", "artifact"):
        (root / directory).mkdir(parents=True)
    verifier_mode = "[verifier.environment]\n" if implicit else 'environment_mode = "separate"\n'
    (root / "task.toml").write_text(
        'schema_version = "1.4"\n[environment]\nbuild_timeout_sec = 600\n'
        '[verifier]\ntimeout_sec = 120\n' + verifier_mode
    )
    (root / "instruction.md").write_text("No agent execution is performed.\n")
    (root / "environment/Dockerfile").write_text("FROM scratch\nLABEL role=candidate\n")
    (root / "environment/Dockerfile.simulator").write_text("FROM scratch\nLABEL role=simulator\n")
    (root / "tests/Dockerfile").write_text("FROM scratch\nLABEL role=verifier\n")
    (root / "tests/test.sh").write_text("#!/bin/sh\nexit 0\n")
    (root / "environment/docker-compose.yaml").write_text(json.dumps({"services": {
        "main": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile"}},
        "simulator": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile.simulator"}},
    }}))


def make_trial(root, name, *, regrade_source=None, verifier_resolved=None):
    config = TrialConfig.model_validate({
        "task": {"path": str(root)}, "trial_name": name, "trials_dir": str(root.parent / "trials"),
        "agent": {"name": "nop"},
        "environment": {
            "import_path": "hitch_harbor_environment:HitchHarborDockerEnvironment",
            "kwargs": {
                "hitch_ownership_labels": OWNERSHIP,
                "hitch_prebuilt_task_image": CANDIDATE,
                "hitch_prebuilt_service_images": {"simulator": SIMULATOR},
                "hitch_prebuilt_verifier_image": VERIFIER,
                "hitch_resolved_images": CANDIDATE_RESOLVED,
                "hitch_verifier_resolved_images": VERIFIER_RESOLVED if verifier_resolved is None else verifier_resolved,
                "hitch_shared_runtime": {"runtime_directory": str(root / "runtime"),
                                         "artifact_directory": str(root / "artifact")},
            },
        },
        **({"source_trial": {"type": "local", "path": str(regrade_source), "action": "regrade"}} if regrade_source else {}),
    })
    arguments = {"_task": Task(root), "_task_download_result": TaskDownloadResult(
        path=root, download_time_sec=0, cached=True,
    )}
    trial = RegradeTrial(config, _source_trial_dir=regrade_source, **arguments) if regrade_source else SingleStepTrial(config, **arguments)
    trial._init_result()
    return trial


def assert_binding(capture, role, *, verifier_resolved=VERIFIER_RESOLVED):
    services = capture["compose"]["services"]
    assert capture["role"] == role, capture
    assert all("build" not in service for service in services.values()), capture
    assert all(service.get("pull_policy") == "never" for service in services.values()), capture
    assert all(service["labels"][ROLE] == role for service in services.values()), capture
    if role == "candidate":
        assert set(services) == {"main", "simulator"}, capture
        assert services["main"]["image"] == CANDIDATE and services["simulator"]["image"] == SIMULATOR, capture
        assert capture["resolved_images"] == CANDIDATE_RESOLVED, capture
        mounts = {mount["target"]: mount for mount in services["main"].get("volumes", [])}
        assert mounts["/opt/hitch"]["read_only"] and mounts["/opt/hitch-harness-artifact"]["read_only"], capture
    else:
        assert set(services) == {"main"} and services["main"]["image"] == VERIFIER, capture
        assert capture["context"] == "tests", capture
        assert capture["resolved_images"] == verifier_resolved, capture
        assert all(mount["target"] not in {"/opt/hitch", "/opt/hitch-harness-artifact", "/logs/agent"}
                   for mount in services["main"].get("volumes", [])), capture


async def expect_error(trial, boundary, *, regrade=False):
    try:
        await (trial._run() if regrade else trial._run_verifier())
    except Exception as error:
        trial._record_exception(error)
        return {"type": type(error).__name__, "message": str(error),
                "cause": type(error.__cause__).__name__, "cause_message": str(error.__cause__),
                "scoring_calls": boundary.scoring_calls,
                "exception_info": trial.result.exception_info.model_dump(mode="json")}
    raise AssertionError("Expected a lifecycle error")


async def exercise(root, boundary):
    trials, results = [], []
    try:
        for name in ("short", "long-" + "a" * 80):
            trial = make_trial(root, name)
            trials.append(trial)
            start = len(boundary.configs)
            await trial.agent_environment.start(False)
            await trial._run_verifier()
            candidate, verifier = boundary.configs[start:]
            assert_binding(candidate, "candidate")
            assert_binding(verifier, "verifier")
            expected = trial._separate_verifier_session_id("trial")
            assert verifier["session"] == expected
            if name.startswith("long-"):
                assert len(expected) == 63 and "__verifier__" not in expected, expected
            else:
                assert expected == name + "__verifier__trial", expected
            assert trial.result.verifier_result.rewards == {"reward": 1.0}
            await trial.agent_environment.stop(True)
            results.append({"case": name, "status": "passed", "verifier_session": expected})
        trial = make_trial(root, "empty-verifier-map", verifier_resolved={})
        trials.append(trial)
        await trial._run_verifier()
        assert_binding(boundary.configs[-1], "verifier", verifier_resolved={})
        results.append({"case": "empty-verifier-map", "status": "passed"})
        source = trials[0]
        source.paths.result_path.write_text(source.result.model_dump_json())
        source.paths.artifacts_manifest_path.write_text(json.dumps([{
            "source": "/logs/artifacts", "destination": "artifacts/logs/artifacts",
            "type": "directory", "status": "empty", "service": "main",
        }]))
        regrade = make_trial(root, "regrade", regrade_source=source.paths.trial_dir)
        trials.append(regrade)
        await regrade._prepare()
        await regrade._run()
        assert_binding(boundary.configs[-1], "verifier")
        assert regrade.result.verifier_result.rewards == {"reward": 1.0}
        results.append({"case": "regrade", "status": "passed"})

        for regrade_case in (False, True):
            trial = make_trial(root, "startup-" + str(regrade_case), regrade_source=source.paths.trial_dir if regrade_case else None)
            trials.append(trial)
            trial._environment_build_timeout_sec = 0.01
            boundary.startup_mode, boundary.scoring_calls = "block", 0
            result = await expect_error(trial, boundary, regrade=regrade_case)
            assert result["type"] == "VerifierEnvironmentStartTimeoutError" and result["cause"] == "TimeoutError", result
            assert "0.01" in result["message"] and "120" not in result["message"], result
            assert result["scoring_calls"] == 0, result
            assert result["exception_info"]["exception_type"] == result["type"], result
            results.append({"case": "regrade-startup-timeout" if regrade_case else "startup-timeout", **result})

        boundary.startup_mode = "ok"
        for regrade_case in (False, True):
            trial = make_trial(root, "score-" + str(regrade_case), regrade_source=source.paths.trial_dir if regrade_case else None)
            trials.append(trial)
            trial._verifier_timeout_sec = 0.01
            boundary.score_mode, boundary.scoring_calls = "block", 0
            result = await expect_error(trial, boundary, regrade=regrade_case)
            assert result["type"] == VerifierTimeoutError.__name__ and result["scoring_calls"] == 1, result
            assert "0.01" in result["message"], result
            results.append({"case": "regrade-scoring-timeout" if regrade_case else "scoring-timeout", **result})

        boundary.startup_mode, boundary.score_mode = "error", "ok"
        boundary.scoring_calls = 0
        trial = make_trial(root, "startup-error")
        trials.append(trial)
        result = await expect_error(trial, boundary)
        assert result["type"] == "VerifierEnvironmentStartError" and result["cause"] == "RuntimeError", result
        assert result["cause_message"] == "fixture daemon startup failed" and result["scoring_calls"] == 0, result
        results.append({"case": "startup-error", **result})

        trial = make_trial(root, "cancelled")
        trials.append(trial)
        boundary.startup_mode, boundary.entered = "block", asyncio.Event()
        running = asyncio.create_task(trial._run_verifier())
        await asyncio.wait_for(boundary.entered.wait(), timeout=5)
        running.cancel()
        try:
            await running
        except asyncio.CancelledError:
            results.append({"case": "external-cancellation", "type": "CancelledError"})
        else:
            raise AssertionError("External cancellation was swallowed")
        assert not any(entry["command"][:1] == ["build"] for entry in boundary.commands), boundary.commands
        return results
    finally:
        for trial in trials:
            trial._close_logger_handler()
            boundary.environments.append(trial.agent_environment)
        for environment in boundary.environments:
            for name in ("_hitch_ownership_temp_dir", "_mounts_compose_temp_dir", "_resources_compose_temp_dir", "_env_compose_temp_dir"):
                temporary = getattr(environment, name, None)
                if temporary is not None:
                    temporary.cleanup()


def discovery_controls(root):
    config = root / "task.toml"
    original = config.read_text()
    image = 'docker_image = "registry.test/explicit:v1"\n'
    separate_image = {"source": "verifier", "service": "main", "reference": "registry.test/explicit:v1"}
    verifier_build = {"source": "verifier", "service": "main", "context": "tests", "dockerfile": "Dockerfile"}
    cases = [
        ("explicit-verifier-image", original + "[verifier.environment]\n" + image, separate_image, None),
        ("inherited-task-image", original.replace("[environment]\n", "[environment]\n" + image), separate_image, None),
        ("partial-verifier-environment", original.replace("[environment]\n", "[environment]\n" + image)
         + "[verifier.environment]\ncpus = 1\n", None, verifier_build),
        ("shared-verifier", original.replace('environment_mode = "separate"', 'environment_mode = "shared"'), None, None),
    ]
    results = []
    try:
        for name, text, expected_image, expected_build in cases:
            config.write_text(text)
            declaration = inspect_task(root)
            assert [item for item in declaration["environment_images"] if item["source"] == "verifier"] == ([expected_image] if expected_image else []), declaration
            assert [item for item in declaration["environment_builds"] if item["source"] == "verifier"] == ([expected_build] if expected_build else []), declaration
            results.append({"case": name, "status": "passed"})
    finally:
        config.write_text(original)
    return results


async def main(args):
    assert importlib.metadata.version("harbor") == "0.21.0", "This canary targets Harbor 0.21.0"
    with tempfile.TemporaryDirectory(prefix="hitch-verifier-lifecycle-") as temporary:
        root = Path(temporary).resolve()
        task = root / "task"
        write_task(task)
        discovery = inspect_task(task)
        assert {"source": "verifier", "service": "main", "context": "tests", "dockerfile": "Dockerfile"} in discovery["environment_builds"], discovery
        assert not any(item["source"] == "verifier" for item in discovery["environment_image_fallbacks"]), discovery
        write_task(root / "implicit", implicit=True)
        assert inspect_task(root / "implicit")["environment_builds"] == discovery["environment_builds"]
        inspection_results = discovery_controls(task)
        boundary = DaemonBoundary(args.compose_binary, task)
        real_run = subprocess.run

        def guarded_run(command, *positional, **kwargs):
            assert command[0] == args.compose_binary and ("config" in command or "version" in command), command
            return real_run(command, *positional, **kwargs)

        async def forbidden_subprocess(*command, **kwargs):
            raise AssertionError(f"Unexpected daemon/model subprocess: {command}")

        with ExitStack() as stack:
            async def compose(environment, command, *positional, **kwargs):
                return await boundary.compose(environment, command, *positional, **kwargs)
            stack.enter_context(patch.object(DockerEnvironment, "_run_docker_compose_command", compose))
            stack.enter_context(patch.object(DockerEnvironment, "_detect_daemon_os", return_value="linux"))
            stack.enter_context(patch.object(DockerEnvironment, "_validate_image_os", AsyncMock()))
            stack.enter_context(patch.object(DockerEnvironment, "_is_rootless_docker", AsyncMock(return_value=False)))
            stack.enter_context(patch("asyncio.create_subprocess_exec", forbidden_subprocess))
            stack.enter_context(patch("subprocess.run", guarded_run))
            results = await exercise(task, boundary)
        evidence = {
            "harbor_version": importlib.metadata.version("harbor"),
            "harbor_trial_sha256": hashlib.sha256(Path(harbor_trial.__file__).read_bytes()).hexdigest(),
            "provider_sha256": hashlib.sha256(Path(provider.__file__).read_bytes()).hexdigest(),
            "compose_version": real_run([args.compose_binary, "version"], capture_output=True, text=True, check=True).stdout.strip(),
            "limits": "Real Harbor lifecycle and Compose config; daemon/scoring I/O replaced; no agent or model run",
            "discovery": discovery, "inspection_results": inspection_results,
            "results": results, "configs": boundary.configs, "commands": boundary.commands,
        }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"Harbor verifier lifecycle: {len(results)} lifecycle and {len(inspection_results)} inheritance checks passed; {evidence['compose_version']}")
    print(f"Evidence: {args.output.resolve() / 'result.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--compose-binary", default=shutil.which("docker-compose"))
    arguments = parser.parse_args()
    if not arguments.compose_binary:
        parser.error("docker-compose was not found; pass --compose-binary")
    asyncio.run(main(arguments))
