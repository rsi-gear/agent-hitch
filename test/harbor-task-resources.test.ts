import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectHarborTaskResources, parseHarborTaskResourceDeclaration } from "../src/backends/index.js";

test("Harbor task inspector validates task semantics and extracts Compose hard limits", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-task-resources-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "environment"));
  await writeFile(path.join(directory, "task.toml"), 'name = "resource-task"\n');
  await writeFile(path.join(directory, "environment", "docker-compose.yaml"), JSON.stringify({
    services: {
      main: {
        image: "registry.test/main:latest", platform: "linux/arm64", cpus: "1.5", mem_limit: "256MiB",
        deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"], count: 2 }] } } },
      },
      database: { image: "registry.test/database:16", deploy: { replicas: 2, resources: { limits: { cpus: "0.5", memory: "64MiB" } } } },
    },
  }));
  const source = path.resolve("integrations", "harbor", "hitch_harbor_task_resources.py");
  const script = String.raw`
import importlib.util, json, pathlib, sys, types
root, source = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
class Separate: pass
class VerifierEnvironmentMode: SEPARATE = Separate()
def environment(cpus, memory, image):
    return types.SimpleNamespace(cpus=cpus, memory_mb=memory, docker_image=image, os=types.SimpleNamespace(value="linux"), network_mode=types.SimpleNamespace(value="none"))
class TaskConfig:
    @staticmethod
    def model_validate(value):
        assert value["name"] == "resource-task"
        return types.SimpleNamespace(
            environment=environment(2, 512, "registry.test/task:v1"), agent=types.SimpleNamespace(network_mode=None),
            verifier=types.SimpleNamespace(environment_mode=VerifierEnvironmentMode.SEPARATE, environment=environment(1, 256, "registry.test/verifier:v1"), network_mode=None),
        )
harbor = types.ModuleType("harbor")
models = types.ModuleType("harbor.models")
task = types.ModuleType("harbor.models.task")
config = types.ModuleType("harbor.models.task.config")
config.TaskConfig, config.VerifierEnvironmentMode = TaskConfig, VerifierEnvironmentMode
modes = types.ModuleType("harbor.models.task.verifier_mode")
modes.resolve_task_verifier_mode = lambda task: VerifierEnvironmentMode.SEPARATE
modes.resolve_effective_verifier_env_config = lambda task, step: task.verifier.environment
modes.resolve_step_verifier_mode = lambda task, step: VerifierEnvironmentMode.SEPARATE
sys.modules["harbor.models.task.verifier_mode"] = modes
yaml = types.ModuleType("yaml"); yaml.safe_load = json.loads
tomllib = types.ModuleType("tomllib"); tomllib.load = lambda handle: {"name": "resource-task"}
sys.modules.update({"harbor": harbor, "harbor.models": models, "harbor.models.task": task, "harbor.models.task.config": config, "yaml": yaml, "tomllib": tomllib})
spec = importlib.util.spec_from_file_location("hitch_harbor_task_resources", source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(json.dumps(module.inspect_task(root)))
`;
  const result = spawnSync("python3", ["-c", script, directory, source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const declaration = parseHarborTaskResourceDeclaration(JSON.parse(result.stdout));
  assert.equal(declaration.runtime_platform, "linux/arm64");
  assert.deepEqual(declaration.task, { cpu_millis: 2_000, memory_bytes: 512 * 1024 * 1024 });
  assert.deepEqual(declaration.verifier, { separate: true, environment: { cpu_millis: 1_000, memory_bytes: 256 * 1024 * 1024 } });
  assert.deepEqual(declaration.compose_services, [
    { name: "database", replicas: 2, cpu_millis: 500, memory_bytes: 64 * 1024 * 1024 },
    { name: "main", replicas: 1, cpu_millis: 1_500, memory_bytes: 256 * 1024 * 1024, gpu_count: 2 },
  ]);
  assert.deepEqual(declaration.provider_sidecars, { main_egress: true, verifier_egress: true });
  assert.deepEqual(declaration.environment_images, [
    { source: "compose", service: "database", reference: "registry.test/database:16" },
    { source: "compose", service: "main", reference: "registry.test/main:latest" },
    { source: "task", service: "main", reference: "registry.test/task:v1" },
    { source: "verifier", service: "main", reference: "registry.test/verifier:v1" },
  ]);
  assert.deepEqual(declaration.environment_image_fallbacks, []);
  assert.deepEqual(declaration.environment_builds, []);
});

test("task resource declaration parser rejects unknown evidence", () => {
  assert.throws(() => parseHarborTaskResourceDeclaration({
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [], surprise: true,
  }), /fields are invalid/);
});

test("Harbor discovers bounded independent Compose sidecar builds before trial startup", () => {
  const result = spawnSync("python3", ["test-support/harbor_compose_images_smoke.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const pathFlavor of ["native", "windows"]) test(`Compose subdirectory build contexts cross the inspector/parser boundary with ${pathFlavor} paths`, () => {
  const script = String.raw`
import importlib.util, json, sys
from pathlib import Path, PureWindowsPath
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("compose_smoke", "test-support/harbor_compose_images_smoke.py")
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
fixture = smoke.ComposeImageDiscoveryTests()
fixture.setUp()
try:
    context = fixture.environment / "nested" / "simulator"
    context.mkdir(parents=True)
    (context / "Dockerfile.simulator").write_text("FROM scratch\n")
    fixture.document["services"]["simulator"]["build"]["context"] = "./nested/simulator"
    with patch.object(sys.modules["hitch_harbor_task_resources"], "Path", PureWindowsPath if sys.argv[1] == "windows" else Path):
        print(json.dumps(fixture.inspect(fixture.document)))
finally:
    fixture.tearDown()
`;
  const result = spawnSync("python3", ["-c", script, pathFlavor], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const declaration = parseHarborTaskResourceDeclaration(JSON.parse(result.stdout));
  const sidecar = declaration.environment_builds[0]!;
  assert.deepEqual(sidecar, { source: "compose", service: "simulator", context: "environment/nested/simulator", dockerfile: "Dockerfile.simulator", platform: "linux/amd64" });
  assert.throws(() => parseHarborTaskResourceDeclaration({ ...declaration,
    environment_builds: [{ ...sidecar, context: sidecar.context.replaceAll("/", "\\") }],
  }), /environment build 0 is invalid/);
});

test("task resource declaration accepts only the supported main Dockerfile build", () => {
  const declaration = parseHarborTaskResourceDeclaration({
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [],
    environment_builds: [{ source: "task", service: "main", context: "environment", dockerfile: "Dockerfile" }],
  });
  assert.deepEqual(declaration.environment_builds, [{ source: "task", service: "main", context: "environment", dockerfile: "Dockerfile" }]);
  assert.throws(() => parseHarborTaskResourceDeclaration({
    ...declaration,
    environment_builds: [{ source: "compose", service: "database", context: "..", dockerfile: "Otherfile" }],
  }), /environment build 0 is invalid/);
});

test("Harbor task inspection preserves a virtualenv Python symlink", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-task-venv-python-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = path.join(directory, "task");
  const bin = path.join(directory, "bin");
  await mkdir(task);
  await mkdir(bin);
  await writeFile(path.join(task, "task.toml"), 'schema_version = "1.4"\n');
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, '#!/usr/bin/env node\nif (process.argv.includes("--version")) process.stdout.write("harbor 0.21.0\\n");\n', { mode: 0o755 });
  const interpreter = path.join(directory, "fake-python-target");
  const declaration = {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [],
  };
  await writeFile(interpreter, `#!/usr/bin/env node
if (!process.argv[1].endsWith("/bin/python")) process.exit(9);
process.stdout.write(${JSON.stringify(JSON.stringify(declaration))});
`, { mode: 0o755 });
  await symlink(interpreter, path.join(bin, "python"));
  const inspected = await inspectHarborTaskResources({ root: directory, taskDirectory: task, harborExecutable: harbor });
  assert.deepEqual(inspected, declaration);
});

// Stub only Harbor's data model and native mode resolver. The real inspector,
// network topology checks run in Python without requiring Harbor
// or PyYAML to be installed on every unit-test machine.
const INSPECT_FIXTURE = String.raw`
import importlib.util, json, pathlib, sys, types
root, source = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
raw = json.loads(sys.argv[3])
class VerifierEnvironmentMode:
    SEPARATE = "separate"
    SHARED = "shared"
def environment(value):
    return types.SimpleNamespace(cpus=value.get("cpus"), memory_mb=value.get("memory_mb"), gpus=value.get("gpus"), docker_image=value.get("docker_image"), os=types.SimpleNamespace(value=value.get("os", "linux")), network_mode=types.SimpleNamespace(value=value.get("network_mode", "public")))
def phase_mode(value):
    return types.SimpleNamespace(value=value["network_mode"]) if "network_mode" in value else None
class TaskConfig:
    @staticmethod
    def model_validate(value):
        verifier = value.get("verifier", {})
        artifacts = [entry if isinstance(entry, str) else types.SimpleNamespace(source=entry["source"], service=entry.get("service")) for entry in value.get("artifacts", [])]
        return types.SimpleNamespace(environment=environment(value.get("environment", {})), steps=value.get("steps"), artifacts=artifacts,
            agent=types.SimpleNamespace(network_mode=phase_mode(value.get("agent", {}))), verifier=types.SimpleNamespace(
                environment_mode=verifier.get("environment_mode"), environment=environment(verifier["environment"]) if "environment" in verifier else None,
                network_mode=phase_mode(verifier), collect=[types.SimpleNamespace(service=entry["service"]) for entry in verifier.get("collect", [])]))
config = types.ModuleType("harbor.models.task.config")
config.TaskConfig, config.VerifierEnvironmentMode = TaskConfig, VerifierEnvironmentMode
mode = types.ModuleType("harbor.models.task.verifier_mode")
mode.resolve_task_verifier_mode = lambda cfg: cfg.verifier.environment_mode or ("separate" if cfg.verifier.environment is not None else "shared")
mode.resolve_step_verifier_mode = lambda cfg, step: mode.resolve_task_verifier_mode(cfg)
mode.resolve_effective_verifier_env_config = lambda cfg, step: (cfg.verifier.environment or cfg.environment) if mode.resolve_task_verifier_mode(cfg) == "separate" else None
yaml = types.ModuleType("yaml"); yaml.safe_load = json.loads
tomllib = types.ModuleType("tomllib"); tomllib.load = lambda handle: raw
sys.modules.update({"harbor.models.task.config": config, "harbor.models.task.verifier_mode": mode, "yaml": yaml, "tomllib": tomllib})
spec = importlib.util.spec_from_file_location("hitch_harbor_task_resources", source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(json.dumps(module.inspect_task(root)))
`;

function inspectFixture(directory: string, config: Record<string, unknown>) {
  return spawnSync("python3", ["-c", INSPECT_FIXTURE, directory, path.resolve("integrations/harbor/hitch_harbor_task_resources.py"), JSON.stringify(config)], { encoding: "utf8" });
}

test("inspector matches static no-network egress topology independently for agent and verifier", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-network-inspector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "environment"));
  await writeFile(path.join(directory, "task.toml"), "");
  const base = { environment: { network_mode: "no-network" }, verifier: { environment_mode: "separate" } };
  const inspect = (config: Record<string, unknown>) => {
    const result = inspectFixture(directory, config); assert.equal(result.status, 0, result.stderr);
    return parseHarborTaskResourceDeclaration(JSON.parse(result.stdout)).provider_sidecars;
  };
  assert.deepEqual(inspect(base), { main_egress: false, verifier_egress: false });
  assert.deepEqual(inspect({ ...base, agent: { network_mode: "public" } }), { main_egress: true, verifier_egress: false });
  assert.deepEqual(inspect({ ...base, verifier: { ...base.verifier, network_mode: "public" } }), { main_egress: false, verifier_egress: true });
  assert.deepEqual(inspect({ environment: { network_mode: "public" }, agent: { network_mode: "no-network" } }), { main_egress: true, verifier_egress: false });
  assert.deepEqual(inspect({ environment: base.environment }), { main_egress: false, verifier_egress: false });
  assert.deepEqual(inspect({ environment: base.environment, verifier: { network_mode: "public" } }), { main_egress: true, verifier_egress: false });
  await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: { tmpfs: ["/run:size=134217728,mode=755"], init: true } } }));
  assert.deepEqual(inspect(base), { main_egress: false, verifier_egress: false });
  for (const setting of [{ network_mode: "host" }, { volumes: ["/:/host"] }, { ports: ["8080:80"] }]) {
    await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: setting } }));
    assert.deepEqual(inspect(base), { main_egress: true, verifier_egress: false });
  }
  await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: {}, simulator: {} } }));
  assert.deepEqual(inspect(base), { main_egress: true, verifier_egress: false });
});

