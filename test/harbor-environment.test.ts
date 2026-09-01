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
    services: { main: { build: "." }, database: { image: "registry.test/database:16" } },
    networks: { private: {}, shared: { external: true } },
    volumes: { data: {}, shared_data: { external: true } },
  }));
  const source = path.resolve("integrations/harbor/hitch_harbor_environment.py");
  const script = String.raw`
import importlib.util, json, pathlib, sys, types
root, source = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
class DockerEnvironment:
    _EGRESS_CONTROL_SERVICE_NAME = "egress"
    def __init__(self, *args, environment_dir, extra_docker_compose=None, **kwargs):
        self._environment_docker_compose_path = pathlib.Path(environment_dir) / "docker-compose.yaml"
        self.extra_docker_compose_paths = [pathlib.Path(p) for p in (extra_docker_compose or [])]
        self._enable_egress_control = False
        self.task_env_config = kwargs.get("task_env_config")
    @property
    def _docker_compose_paths(self): return [pathlib.Path("base.json")]
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
overlay = json.loads(env._hitch_ownership_compose_path.read_text())
assert set(overlay["services"]) == {"main", "database"}
assert set(overlay["networks"]) == {"default", "private"}
assert set(overlay["volumes"]) == {"data"}
for group in overlay.values():
    for config in group.values(): assert config["labels"] == labels
assert overlay["services"]["database"]["cpus"] == 0.5
assert overlay["services"]["database"]["mem_limit"] == 67108864
assert overlay["services"]["database"]["image"] == resolved["registry.test/database:16"]
assert env.task_env_config.docker_image == resolved["registry.test/task:v1"]
assert "cpus" not in overlay["services"]["main"]
assert env._docker_compose_paths[-1] == env._hitch_ownership_compose_path
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
assert gateway_overlay["services"]["main"] == {"extra_hosts": ["host.docker.internal:host-gateway"]}
assert gateway_overlay["services"]["database"] == {}
try: module._validate_labels({**labels, "unexpected": "x"})
except ValueError: pass
else: raise AssertionError("unknown ownership label accepted")
try: module.HitchHarborDockerEnvironment(environment_dir=root, hitch_ownership_labels=labels, hitch_service_resource_limits={"other": limits["database"]})
except ValueError: pass
else: raise AssertionError("unbounded sidecar accepted")
try: module._validate_resolved_images({"registry.test/database:16": "other.test/database@sha256:" + "a" * 64})
except ValueError: pass
else: raise AssertionError("cross-repository image mapping accepted")
try: module._validate_prebuilt_task_image("hitch-environment:mutable")
except ValueError: pass
else: raise AssertionError("mutable prebuilt task image accepted")
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
});
