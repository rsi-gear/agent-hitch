"""Real Harbor/Docker regression: independent fixtures, no models or benchmark."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
from hitch_image_cache import ImagePreparationCache, docker


async def prepare_child(source, cache):
    result = await ImagePreparationCache(cache, dict(os.environ)).prepare({"build": {"context": source}, "platform": "linux/amd64"})
    print(json.dumps(result), flush=True)


async def main(root, image):
    from harbor.models.task.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths
    from hitch_harbor_environment import HitchHarborDockerEnvironment
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    cache = root / "cache"
    source = root / "different-app"; source.mkdir()
    (source / "value").write_text("immutable fixture")
    (source / "Dockerfile").write_text(f"FROM {image}\nCOPY value /value\nENTRYPOINT []\n")
    processes = [await asyncio.create_subprocess_exec(sys.executable, __file__, "child", str(source), str(cache), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE) for _ in range(4)]
    receipts = []
    for process in processes:
        stdout, stderr = await process.communicate()
        assert process.returncode == 0, stderr.decode()
        receipts.append(json.loads(stdout))
    assert sum(not r["cache_hit"] for r in receipts) == 1, receipts
    assert len({r["image"] for r in receipts}) == 1
    verifier_source = root / "nested" / "step" / "tests"
    shutil.copytree(source, verifier_source)
    prefix = "hitch-prep-test-" + uuid.uuid4().hex[:12]
    environments = []
    timings = {}

    def environment(context, suffix, optimized=True):
        paths = TrialPaths(root / suffix); paths.mkdir()
        instance = HitchHarborDockerEnvironment(environment_dir=context, environment_name=prefix + suffix,
            session_id=prefix + suffix, trial_paths=paths, task_env_config=EnvironmentConfig(cpus=1, memory_mb=512),
            mounts=[], hitch_image_cache_dir=str(cache), hitch_managed_keepalive=optimized)
        environments.append(instance)
        return instance

    try:
        candidate = environment(source, "__env")
        verifier = environment(verifier_source, "__verifier__step")
        await asyncio.gather(candidate.start(False), verifier.start(False))
        ids = []
        for env in (candidate, verifier):
            assert env._hitch_preparation.receipts[0]["cache_hit"], env._hitch_preparation.receipts
            identity = (await env._run_docker_compose_command(["ps", "--quiet", "main"])).stdout.strip()
            ids.append(identity)
            observed = json.loads(await docker(["inspect", "--format", "{{json .}}", identity], env=dict(os.environ)))
            assert observed["Image"] == receipts[0]["image"]
            assert all(str(cache) not in mount.get("Source", "") for mount in observed["Mounts"])
            assert "trap" in observed["Config"]["Cmd"][-1]
        assert ids[0] != ids[1]
        assert (await candidate.exec("printf candidate > /value")).return_code == 0
        assert (await verifier.exec("cat /value")).stdout == "immutable fixture"
        assert (await verifier.exec("printf '0' > /tmp/reward; test $(cat /tmp/reward) = 0")).return_code == 0
        started = time.monotonic()
        await asyncio.gather(candidate.stop(True), verifier.stop(True))
        environments.remove(candidate); environments.remove(verifier)
        timings["managed_two_stop_seconds"] = time.monotonic() - started
        assert timings["managed_two_stop_seconds"] < 7, timings
        # A prebuilt image with a Dockerfile fallback must keep its precedence:
        # Compose up would use the existing image, not rebuild the changed file.
        fallback = root / "prebuilt-fallback"; shutil.copytree(source, fallback)
        (fallback / "value").write_text("must not replace prebuilt image")
        (fallback / "docker-compose.yaml").write_text(json.dumps({"services": {"main": {"build": {"context": "."}}}}))
        paths = TrialPaths(root / "prebuilt-logs"); paths.mkdir()
        prebuilt = HitchHarborDockerEnvironment(environment_dir=fallback, environment_name=prefix + "prebuilt",
            session_id=prefix + "__prebuilt", trial_paths=paths,
            task_env_config=EnvironmentConfig(docker_image=receipts[0]["image"], cpus=1, memory_mb=512),
            mounts=[], hitch_image_cache_dir=str(cache), hitch_managed_keepalive=True)
        environments.append(prebuilt)
        await prebuilt.start(False)
        assert prebuilt._use_prebuilt
        assert (await prebuilt.exec("cat /value")).stdout == "immutable fixture"
        assert not prebuilt._hitch_preparation.images
        await prebuilt.stop(False); environments.remove(prebuilt)
        # Candidate image/runtime kwargs must not reach independent verifiers,
        # including a step named 'env' and a truncated session without a marker.
        distinct = root / "verifier-only"; shutil.copytree(source, distinct)
        (distinct / "value").write_text("verifier-only fixture")
        (root / "runtime/payload").mkdir(parents=True)
        (root / "artifact").mkdir()
        for suffix in ("__verifier__env", "__12345678"):
            paths = TrialPaths(root / prefix); paths.mkdir()
            isolated = HitchHarborDockerEnvironment(environment_dir=distinct, environment_name=prefix,
                session_id=prefix + suffix, trial_paths=paths,
                task_env_config=EnvironmentConfig(cpus=1, memory_mb=512), mounts=[],
                hitch_prebuilt_task_image=receipts[0]["image"], hitch_image_cache_dir=str(cache), hitch_managed_keepalive=True,
                hitch_shared_runtime={"runtime_directory": str(root / "runtime"), "artifact_directory": str(root / "artifact")})
            environments.append(isolated)
            assert isolated._hitch_prebuilt_task_image is None
            assert isolated._hitch_shared_runtime is None
            await isolated.start(False)
            assert (await isolated.exec("cat /value")).stdout == "verifier-only fixture"
            assert (await isolated.exec("test ! -e /opt/hitch && test ! -e /opt/hitch-harness-artifact")).return_code == 0
            await isolated.stop(True); environments.remove(isolated)
        # Verify a real cache eviction triggers one rebuild and new record.
        raw_record = cache / f"image-{receipts[0]['cache_key']}.json"
        record = json.loads(raw_record.read_text())
        await docker(["image", "rm", record["tag"]], env=dict(os.environ))
        assert not (await ImagePreparationCache(cache, dict(os.environ)).prepare({"build": {"context": str(source)}, "platform": "linux/amd64"}))["cache_hit"]
        # Explicit task commands remain intact even with the optimization enabled.
        custom = root / "custom"; shutil.copytree(source, custom)
        (custom / "docker-compose.yaml").write_text(json.dumps({"services": {"main": {"command": ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"]}}}))
        customized = environment(custom, "__custom")
        await customized.start(False)
        assert not any(event["event"] == "managed-keepalive" for event in customized._hitch_preparation.receipts)
        await customized.stop(True)
        environments.remove(customized)
        (root / "result.json").write_text(json.dumps({"cross_process": receipts, "timings": timings, "isolation": True, "custom_command_preserved": True}, indent=2))
        print("image preparation: cross-process build once, warm roles, nested verifier isolation, eviction and graceful stop OK", flush=True)
    finally:
        for env in environments:
            try: await env.stop(True)
            except Exception: pass
        for record in cache.glob("image-*.json"):
            await docker(["image", "rm", json.loads(record.read_text())["tag"]], env=dict(os.environ), check=False)


if __name__ == "__main__":
    if sys.argv[1] == "child": asyncio.run(prepare_child(*sys.argv[2:]))
    else: asyncio.run(main(*sys.argv[1:]))
