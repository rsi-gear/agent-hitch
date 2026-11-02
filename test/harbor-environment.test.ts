import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

test("Harbor ownership environment labels every controlled Compose resource and excludes external ones", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-harbor-environment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "docker-compose.yaml"), JSON.stringify({
    services: { main: { build: "." }, database: { image: "registry.test/database:16", platform: "linux/arm64" } },
    networks: { private: {}, shared: { external: true } },
    volumes: { data: {}, shared_data: { external: true } },
  }));
  const source = path.resolve("integrations/harbor/hitch_harbor_environment.py");
  const script = String.raw`
import asyncio, importlib.util, json, pathlib, sys, types
root, source = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sys.path.insert(0, str(source.parent))
class DockerEnvironment:
    _EGRESS_CONTROL_SERVICE_NAME = "egress"
    def __init__(self, *args, environment_dir, extra_docker_compose=None, **kwargs):
        self._environment_docker_compose_path = pathlib.Path(environment_dir) / "docker-compose.yaml"
        self.extra_docker_compose_paths = [pathlib.Path(p) for p in (extra_docker_compose or [])]
        self._enable_egress_control = False
        self.task_env_config = kwargs.get("task_env_config")
    @property
    def _docker_compose_paths(self): return [pathlib.Path("base.json")]
    def _compose_env_vars(self, include_os_env=True):
        return {"HITCH_HOST_CREDENTIAL_HELPER_JSON": "host-only-helper", "SAFE_COMPOSE_VALUE": "kept"}
    async def _run_docker_compose_command(self, command, *args, **kwargs):
        self.commands = getattr(self, "commands", []) + [command]
        if getattr(self, "fail_down", False) and command[:1] == ["down"]:
            raise RuntimeError("fixture cleanup failed")
        return types.SimpleNamespace(stdout=json.dumps({"services": {"main": getattr(self, "resolved_main", {})}}))
    async def start(self, force_build):
        await self._run_docker_compose_command(["up", "--wait"])
    async def stop(self, delete):
        self.stop_requests = getattr(self, "stop_requests", []) + [delete]
harbor = types.ModuleType("harbor")
constants = types.ModuleType("harbor.constants"); constants.MAIN_SERVICE_NAME = "main"
environments = types.ModuleType("harbor.environments")
docker_package = types.ModuleType("harbor.environments.docker")
docker_module = types.ModuleType("harbor.environments.docker.docker"); docker_module.DockerEnvironment = DockerEnvironment
yaml = types.ModuleType("yaml"); yaml.safe_load = json.loads
sys.modules.update({"harbor": harbor, "harbor.constants": constants, "harbor.environments": environments, "harbor.environments.docker": docker_package, "harbor.environments.docker.docker": docker_module, "yaml": yaml})
spec = importlib.util.spec_from_file_location("hitch_harbor_environment", source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
labels = {
  "io.hitch.root-id": "a" * 24, "io.hitch.provider": "local-docker",
  "io.hitch.eval-id": "eval_" + "b" * 32, "io.hitch.work-id": "work_" + "c" * 32,
  "io.hitch.lease-id": "lease_" + "d" * 32, "io.hitch.lease-epoch": "1", "io.hitch.task-id": "task-a"
}
limits = {"database": {"cpu_millis": 500, "memory_bytes": 67108864}}
class TaskEnvironment:
    def __init__(self, docker_image): self.docker_image = docker_image
    def model_copy(self, update): return TaskEnvironment(update["docker_image"])
resolved = {
  "registry.test/database:16": "registry.test/database@sha256:" + "a" * 64,
  "registry.test/task:v1": "registry.test/task@sha256:" + "b" * 64,
}
env = module.HitchHarborDockerEnvironment(environment_dir=root, task_env_config=TaskEnvironment("registry.test/task:v1"), hitch_ownership_labels=labels, hitch_service_resource_limits=limits, hitch_resolved_images=resolved)
assert env._compose_env_vars(include_os_env=True) == {"SAFE_COMPOSE_VALUE": "kept"}
overlay = json.loads(env._hitch_ownership_compose_path.read_text())
assert set(overlay["services"]) == {"main", "database"}
assert set(overlay["networks"]) == {"default", "private"}
assert set(overlay["volumes"]) == {"data"}
for name, group in overlay.items():
    expected = {**labels, "io.hitch.environment-role": "candidate"} if name == "services" else labels
    for config in group.values(): assert config["labels"] == expected
assert overlay["services"]["database"]["cpus"] == 0.5
assert overlay["services"]["database"]["mem_limit"] == 67108864
assert overlay["services"]["database"]["image"] == resolved["registry.test/database:16"]
assert env.task_env_config.docker_image == resolved["registry.test/task:v1"]
assert "cpus" not in overlay["services"]["main"]
assert env._docker_compose_paths[-1] == env._hitch_ownership_compose_path
asyncio.run(env._run_docker_compose_command(["down", "--rmi", "local", "--volumes", "--remove-orphans"]))
assert env.commands[-1] == ["down", "--volumes", "--remove-orphans"]
asyncio.run(env._run_docker_compose_command(["down", "--rmi", "all"]))
assert env.commands[-1] == ["down", "--rmi", "all"]
plain = module.HitchHarborDockerEnvironment(environment_dir=root)
asyncio.run(plain._run_docker_compose_command(["down", "--rmi", "local"]))
assert plain.commands[-1] == ["down", "--rmi", "local"]
env.fail_down = True
try: asyncio.run(env._run_docker_compose_command(["down", "--rmi", "local", "--volumes"]))
except RuntimeError as error: assert str(error) == "fixture cleanup failed"
else: raise AssertionError("cleanup error was hidden")
env.fail_down = False
env._hitch_benchmark_platform = "linux/amd64"
benchmark_overlay_path = env._write_ownership_overlay()
benchmark_overlay = json.loads(benchmark_overlay_path.read_text())
assert benchmark_overlay["services"]["main"]["platform"] == "linux/amd64"
assert "platform" not in benchmark_overlay["services"]["database"]
(root / "docker-compose-hitch-platform.yaml").write_text(benchmark_overlay_path.read_text())
extra = root / "declared-main-platform.json"
extra.write_text(json.dumps({"services": {"main": {"platform": "linux/arm64"}}}))
env.extra_docker_compose_paths = [extra]
explicit_main = json.loads(env._write_ownership_overlay().read_text())
assert "platform" not in explicit_main["services"]["main"]
env.extra_docker_compose_paths = []
prebuilt = "sha256:" + "c" * 64
prebuilt_env = module.HitchHarborDockerEnvironment(environment_dir=root, task_env_config=TaskEnvironment(None), hitch_prebuilt_task_image=prebuilt)
prebuilt_overlay_text = prebuilt_env._hitch_ownership_compose_path.read_text()
prebuilt_overlay = json.loads(prebuilt_overlay_text.replace("!reset null", "null"))
assert prebuilt_env.task_env_config.docker_image == prebuilt
assert prebuilt_overlay["services"]["main"]["image"] == prebuilt
assert prebuilt_overlay["services"]["main"]["build"] is None
assert '"build": !reset null' in prebuilt_overlay_text
(root / "docker-compose-hitch-prebuilt.yaml").write_text(prebuilt_overlay_text)
gateway_env = module.HitchHarborDockerEnvironment(environment_dir=root, hitch_model_proxy_host_gateway=True)
gateway_overlay = json.loads(gateway_env._hitch_ownership_compose_path.read_text())
assert gateway_overlay["services"]["main"] == {"extra_hosts": ["host.docker.internal:host-gateway"], "labels": {"io.hitch.environment-role": "candidate"}}
assert gateway_overlay["services"]["database"] == {"labels": {"io.hitch.environment-role": "candidate"}}
(root / "controller/payload").mkdir(parents=True)
(root / "artifact").mkdir()
shared_paths = {"runtime_directory": str(root / "controller"), "artifact_directory": str(root / "artifact")}
shared_env = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="task__env", hitch_shared_runtime=shared_paths)
assert "volumes" not in json.loads(shared_env._hitch_ownership_compose_path.read_text())["services"]["main"]
asyncio.run(shared_env._run_docker_compose_command(["up", "--wait"]))
shared_overlay = json.loads(shared_env._hitch_ownership_compose_path.read_text())
assert len(shared_overlay["services"]["main"]["volumes"]) == 2
assert all(mount["read_only"] for mount in shared_overlay["services"]["main"]["volumes"])
assert "volumes" not in shared_overlay["services"]["database"]
verifier_env = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="task__verifier__trial", hitch_shared_runtime=shared_paths)
assert verifier_env._hitch_shared_runtime is None
assert json.loads(verifier_env._hitch_ownership_compose_path.read_text())["services"]["main"]["labels"]["io.hitch.environment-role"] == "verifier"
verifier_prebuilt = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="task__verifier__trial", task_env_config=TaskEnvironment(None), hitch_prebuilt_task_image=prebuilt)
assert verifier_prebuilt.task_env_config.docker_image is None
assert verifier_prebuilt._hitch_prebuilt_task_image is None
for trial_name in ("short", "task-" + "a" * 80, "task__verifier__name"):
    trial_paths = types.SimpleNamespace(trial_dir=root / trial_name)
    candidate = module.HitchHarborDockerEnvironment(environment_dir=root, session_id=trial_name + "__env", trial_paths=trial_paths,
        task_env_config=TaskEnvironment(None), hitch_prebuilt_task_image=prebuilt, hitch_shared_runtime=shared_paths)
    assert candidate.task_env_config.docker_image == prebuilt
    assert candidate._hitch_shared_runtime is not None
    for session in (trial_name + "__verifier__env", trial_name[:53] + "__12345678"):
        verifier = module.HitchHarborDockerEnvironment(environment_dir=root, session_id=session, trial_paths=trial_paths,
            task_env_config=TaskEnvironment("verifier-image"), hitch_prebuilt_task_image=prebuilt, hitch_shared_runtime=shared_paths)
        assert verifier.task_env_config.docker_image == "verifier-image"
        assert verifier._hitch_prebuilt_task_image is None
        assert verifier._hitch_shared_runtime is None
gpu_env = module.HitchHarborDockerEnvironment(environment_dir=root, hitch_main_gpu_count=2)
gpu_overlay_text = gpu_env._hitch_ownership_compose_path.read_text()
assert '"devices": !override [{"capabilities": ["gpu"], "count": 2}]' in gpu_overlay_text
(root / "docker-compose-hitch-gpu.yaml").write_text(gpu_overlay_text)
gpu_sidecar_env = module.HitchHarborDockerEnvironment(
    environment_dir=root,
    hitch_ownership_labels=labels,
    hitch_service_resource_limits={"database": {**limits["database"], "gpu_count": 1}},
)
gpu_sidecar_overlay_text = gpu_sidecar_env._hitch_ownership_compose_path.read_text()
assert '"devices": !override [{"capabilities": ["gpu"], "count": 1}]' in gpu_sidecar_overlay_text
try: module._validate_labels({**labels, "unexpected": "x"})
except ValueError: pass
else: raise AssertionError("unknown ownership label accepted")
for provider in ["local-docker", "remote-docker", "remote.us-1"]:
    assert module._validate_labels({**labels, "io.hitch.provider": provider})["io.hitch.provider"] == provider
for provider in ["Remote", "remote/docker", "bad provider", "a" * 129, "", None]:
    try: module._validate_labels({**labels, "io.hitch.provider": provider})
    except ValueError: pass
    else: raise AssertionError("invalid provider ownership label accepted")
remote_labels = {**labels, "io.hitch.provider": "remote-docker"}
remote_env = module.HitchHarborDockerEnvironment(environment_dir=root, hitch_ownership_labels=remote_labels)
for resources in json.loads(remote_env._hitch_ownership_compose_path.read_text()).values():
    for resource in resources.values(): assert resource["labels"]["io.hitch.provider"] == "remote-docker"
try: module.HitchHarborDockerEnvironment(environment_dir=root, hitch_ownership_labels=labels, hitch_service_resource_limits={"other": limits["database"]})
except ValueError: pass
else: raise AssertionError("unbounded sidecar accepted")
try: module._validate_resolved_images({"registry.test/database:16": "other.test/database@sha256:" + "a" * 64})
except ValueError: pass
else: raise AssertionError("cross-repository image mapping accepted")
try: module._validate_prebuilt_task_image("hitch-environment:mutable")
except ValueError: pass
else: raise AssertionError("mutable prebuilt task image accepted")
original = (root / "docker-compose.yaml").read_text()
try:
    for raw in ({"privileged": "false"}, {"privileged": "$" + "{ENABLE_PRIVILEGED:-false}", "volumes": None},
                {"extends": {"file": "template.yaml", "service": "template"}}):
        (root / "docker-compose.yaml").write_text(json.dumps({"services": {"main": raw}}))
        for resolved in ({"privileged": False, "volumes": None}, {"privileged": True},
                         {"cap_add": ["SYS_ADMIN"]}, {"volumes": [{"type": "bind", "source": "/task", "target": "/opt/hitch"}]}):
            candidate = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="task__env", hitch_shared_runtime=shared_paths)
            candidate.resolved_main = resolved
            if resolved == {"privileged": False, "volumes": None}:
                asyncio.run(candidate._run_docker_compose_command(["up", "--wait"]))
                assert candidate.commands == [["config", "--format", "json"], ["up", "--wait"]]
            else:
                try: asyncio.run(candidate.start(False))
                except ValueError: pass
                else: raise AssertionError("unsafe resolved configuration accepted")
                assert candidate.commands == [["config", "--format", "json"]]
                assert candidate.stop_requests == [False]
                assert "volumes" not in json.loads(candidate._hitch_ownership_compose_path.read_text())["services"]["main"]
            candidate._hitch_ownership_temp_dir.cleanup()
finally:
    (root / "docker-compose.yaml").write_text(original)
sales = {"services": {
    "main": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile"},
             "depends_on": {"simulator": {"condition": "service_healthy"}}},
    "simulator": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile.simulator"},
                  "healthcheck": {"test": ["CMD", "true"]}},
}}
(root / "sales-compose.yaml").write_text(json.dumps(sales))
try:
    (root / "docker-compose.yaml").write_text(json.dumps(sales))
    simulator_image = "sha256:" + "d" * 64
    prepared = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="sales__env",
        hitch_ownership_labels=labels, task_env_config=TaskEnvironment(None),
        hitch_prebuilt_task_image=prebuilt, hitch_prebuilt_service_images={"simulator": simulator_image})
    overlay_text = prepared._hitch_ownership_compose_path.read_text()
    assert overlay_text.count('"build": !reset null') == 2
    (root / "sales-overlay.yaml").write_text(overlay_text)
    verifier = module.HitchHarborDockerEnvironment(environment_dir=root, session_id="sales__verifier__env",
        task_env_config=TaskEnvironment(None), hitch_prebuilt_task_image=prebuilt,
        hitch_prebuilt_service_images={"simulator": simulator_image})
    assert verifier._hitch_prebuilt_task_image is None and verifier._hitch_prebuilt_service_images == {}
    for invalid in ({"simulator": None}, {"simulator": "mutable:tag"}, [], {"unknown": simulator_image}):
        try: module.HitchHarborDockerEnvironment(environment_dir=root, hitch_prebuilt_service_images=invalid)
        except ValueError: pass
        else: raise AssertionError("invalid service image mapping accepted")
finally:
    (root / "docker-compose.yaml").write_text(original)
`;
  const result = spawnSync("python3", ["-c", script, directory, source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (compose.status !== 0) {
    t.diagnostic("docker compose is unavailable; skipping the real merge canary");
    return;
  }
  const merged = spawnSync("docker", [
    "compose",
    "-f", path.join(directory, "docker-compose.yaml"),
    "-f", path.join(directory, "docker-compose-hitch-prebuilt.yaml"),
    "config", "--format", "json",
  ], { encoding: "utf8" });
  assert.equal(merged.status, 0, merged.stderr || merged.stdout);
  const config = JSON.parse(merged.stdout) as { services: { main: Record<string, unknown> } };
  assert.equal(config.services.main.image, `sha256:${"c".repeat(64)}`);
  assert.equal("build" in config.services.main, false, "prebuilt Compose merge retained a build stanza");
  const gpuMerged = spawnSync("docker", [
    "compose",
    "-f", path.join(directory, "docker-compose.yaml"),
    "-f", path.join(directory, "docker-compose-hitch-gpu.yaml"),
    "config", "--format", "json",
  ], { encoding: "utf8" });
  assert.equal(gpuMerged.status, 0, gpuMerged.stderr || gpuMerged.stdout);
  const gpuConfig = JSON.parse(gpuMerged.stdout) as { services: { main: { deploy?: { resources?: { reservations?: { devices?: Array<{ count?: number; capabilities?: string[] }> } } } } } };
  assert.equal(gpuConfig.services.main.deploy?.resources?.reservations?.devices?.[0]?.count, 2);
  assert.deepEqual(gpuConfig.services.main.deploy?.resources?.reservations?.devices?.[0]?.capabilities, ["gpu"]);
  const platformMerged = spawnSync("docker", [
    "compose", "-f", path.join(directory, "docker-compose.yaml"),
    "-f", path.join(directory, "docker-compose-hitch-platform.yaml"), "config", "--format", "json",
  ], { encoding: "utf8" });
  assert.equal(platformMerged.status, 0, platformMerged.stderr || platformMerged.stdout);
  const platforms = JSON.parse(platformMerged.stdout).services;
  assert.equal(platforms.main.platform, "linux/amd64");
  assert.equal(platforms.database.platform, "linux/arm64");
  const salesMerged = spawnSync("docker", ["compose", "-f", path.join(directory, "sales-compose.yaml"),
    "-f", path.join(directory, "sales-overlay.yaml"), "config", "--format", "json"], { encoding: "utf8" });
  assert.equal(salesMerged.status, 0, salesMerged.stderr || salesMerged.stdout);
  const sales = JSON.parse(salesMerged.stdout).services;
  for (const service of [sales.main, sales.simulator]) {
    assert.equal("build" in service, false);
    assert.equal(service.pull_policy, "never");
  }
  assert.equal(sales.main.image, `sha256:${"c".repeat(64)}`);
  assert.equal(sales.simulator.image, `sha256:${"d".repeat(64)}`);
  assert.equal(sales.main.depends_on.simulator.condition, "service_healthy");
  assert.deepEqual(sales.simulator.healthcheck.test, ["CMD", "true"]);
});
