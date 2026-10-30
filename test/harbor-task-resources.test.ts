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
verifier_mode = types.ModuleType("harbor.models.task.verifier_mode")
verifier_mode.resolve_task_verifier_mode = lambda cfg: cfg.verifier.environment_mode
verifier_mode.resolve_effective_verifier_env_config = lambda cfg, step: cfg.verifier.environment
yaml = types.ModuleType("yaml"); yaml.safe_load = json.loads
tomllib = types.ModuleType("tomllib"); tomllib.load = lambda handle: {"name": "resource-task"}
sys.modules.update({"harbor": harbor, "harbor.models": models, "harbor.models.task": task, "harbor.models.task.config": config, "harbor.models.task.verifier_mode": verifier_mode, "yaml": yaml, "tomllib": tomllib})
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
  assert.deepEqual(declaration.verifier_compose_services, [{ name: "main", replicas: 1 }]);
  assert.deepEqual(declaration.lifecycle, {
    contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate",
    verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [] },
  });
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
// topology checks and extension parser run in Python without requiring Harbor
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
  await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: {}, simulator: {} } }));
  assert.deepEqual(inspect(base), { main_egress: true, verifier_egress: false });
});

test("native single-step lifecycle resolves shared and implied separate modes with exact artifact dependencies", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-lifecycle-inspector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "environment"));
  await writeFile(path.join(directory, "task.toml"), "");
  await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: {}, simulator: { cpus: 1, mem_limit: "1GiB" } } }));
  const artifacts = [{ source: "/evidence/snapshot.json", service: "simulator" }];
  const declaration = { schema_version: "1", verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [{ service: "simulator", path: "/evidence/snapshot.json" }] } };
  await writeFile(path.join(directory, "hitch.resources.json"), JSON.stringify(declaration));
  const config = { environment: { cpus: 1, memory_mb: 2048 }, verifier: { environment: { cpus: 1, memory_mb: 2048 } }, artifacts };
  const result = inspectFixture(directory, config);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseHarborTaskResourceDeclaration(JSON.parse(result.stdout));
  assert.equal(parsed.verifier.separate, true);
  assert.deepEqual(parsed.lifecycle?.verifier_dependencies, declaration.verifier_dependencies);
  assert.deepEqual(parsed.compose_services, [{ name: "main", replicas: 1 }, { name: "simulator", replicas: 1, cpu_millis: 1000, memory_bytes: 1024 ** 3 }]);
  // v5 moves build inputs under per-role directories; lifecycle is independent
  // of those paths and of AutomationBench's domain metadata.
  await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: {
    main: { build: { context: "candidate", dockerfile: "Dockerfile" } },
    simulator: { build: { context: "services/simulator", dockerfile: "Dockerfile" }, cpus: 1, mem_limit: "1GiB" },
  } }));
  for (const domain of ["marketing", "finance", "unseen-domain"]) {
    const result = inspectFixture(directory, { ...config, metadata: { domain } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseHarborTaskResourceDeclaration(JSON.parse(result.stdout)).lifecycle, parsed.lifecycle);
  }
  await rm(path.join(directory, "hitch.resources.json"));
  const shared = inspectFixture(directory, { environment: { cpus: 1 }, artifacts });
  assert.equal(shared.status, 0, shared.stderr);
  const sharedParsed = parseHarborTaskResourceDeclaration(JSON.parse(shared.stdout));
  assert.equal(sharedParsed.verifier.separate, false);
  assert.equal(sharedParsed.lifecycle?.verifier_mode, "shared");
  assert.deepEqual(sharedParsed.verifier_compose_services, []);
  const inherited = inspectFixture(directory, { environment: { cpus: 3, memory_mb: 1024 }, verifier: { environment_mode: "separate" } });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.deepEqual(parseHarborTaskResourceDeclaration(JSON.parse(inherited.stdout)).verifier.environment, { cpu_millis: 3000, memory_bytes: 1024 ** 3 });
});

test("inspector rejects omitted or unbounded runtime topology before certifying lifecycle", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-topology-inspector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "environment"));
  await mkdir(path.join(directory, "tests"));
  await writeFile(path.join(directory, "task.toml"), "");
  for (const [config, message] of [
    [{ steps: [{ name: "one" }, { name: "two" }] }, /multi_step_resource_topology_unsupported/],
    [{ environment: { class_path: "custom.Provider" } }, /custom_environment_topology_unsupported/],
    [{ artifacts: [{ source: "/evidence/state", service: "missing" }] }, /verifier_artifact_service_missing/],
    [{ artifacts: ["/evidence/*.json"] }, /artifact source must be a fixed path/],
    [{ artifacts: ["relative/state.json"] }, /artifact source must be a fixed path/],
    [{ environment: { gpus: 1 } }, /native_gpu_resource_topology_unsupported/],
  ] as const) {
    const result = inspectFixture(directory, config);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  for (const service of [{ deploy: { replicas: "${COUNT}" } }, { deploy: { mode: "global" } }, { provider: { type: "dynamic" } }, { deploy: "${DEPLOY}" }, { scale: 1, deploy: { replicas: 2 } }, { restart: "always" }, { deploy: { restart_policy: {} } }, { deploy: { restart_policy: { condition: "on-failure" } } }]) {
    await writeFile(path.join(directory, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: {}, database: service } }));
    const result = inspectFixture(directory, {});
    assert.notEqual(result.status, 0, JSON.stringify(service));
  }
  await rm(path.join(directory, "environment/docker-compose.yaml"));
  await writeFile(path.join(directory, "tests/docker-compose.yaml"), JSON.stringify({ services: { main: {}, database: { mem_limit: "1GiB" } } }));
  const verifier = inspectFixture(directory, { verifier: { environment_mode: "separate" } });
  assert.notEqual(verifier.status, 0);
  assert.match(verifier.stderr, /verifier_compose_topology_unsupported/);
});

test("lifecycle extensions cannot conceal live dependencies or change native artifacts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-dependency-inspector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "task.toml"), "");
  const config = { verifier: { environment_mode: "separate" }, artifacts: ["/state.json"] };
  const artifacts = [{ service: "main", path: "/state.json" }];
  for (const [dependency, message] of [
    [{ inputs: "live-services", live_services: ["main"], artifacts }, /verifier_live_dependency_unsupported/],
    [{ inputs: "artifacts-only", live_services: ["main"], artifacts }, /verifier_dependency_conflict/],
    [{ inputs: "artifacts-only", live_services: [], artifacts: [] }, /verifier_artifact_dependency_mismatch/],
    [{ inputs: "artifacts-only", live_services: [], artifacts: [...artifacts, ...artifacts] }, /verifier_artifact_dependency_mismatch/],
  ] as const) {
    await writeFile(path.join(directory, "hitch.resources.json"), JSON.stringify({ schema_version: "1", verifier_dependencies: dependency }));
    const result = inspectFixture(directory, config);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  await writeFile(path.join(directory, "hitch.resources.json"), '{"schema_version":"1","schema_version":"1","verifier_dependencies":{}}');
  assert.match(inspectFixture(directory, config).stderr, /duplicate field/);
});

test("strict lifecycle parser rejects incomplete topology and contradictory dependencies while accepting legacy declarations", () => {
  const legacy = { schema_version: "1", task: {}, verifier: { separate: true }, compose_services: [{ name: "main", replicas: 1 }], provider_sidecars: { main_egress: false, verifier_egress: false }, environment_images: [], environment_image_fallbacks: [], environment_builds: [] };
  assert.equal(parseHarborTaskResourceDeclaration(legacy).lifecycle, undefined);
  const lifecycle = { contract: "harbor-native-docker-single-step-v1", capability: "phase-exclusive-teardown-v1", verifier_mode: "separate", verifier_dependencies: { inputs: "artifacts-only", live_services: [], artifacts: [] } };
  assert.throws(() => parseHarborTaskResourceDeclaration({ ...legacy, lifecycle }), /complete native/);
  const declaration = { ...legacy, lifecycle, verifier_compose_services: [{ name: "main", replicas: 1 }] };
  assert.deepEqual(parseHarborTaskResourceDeclaration(declaration).lifecycle, lifecycle);
  assert.throws(() => parseHarborTaskResourceDeclaration({ ...declaration, verifier_compose_services: [{ name: "main", replicas: 1 }, { name: "db", replicas: 1 }] }), /complete native/);
  assert.throws(() => parseHarborTaskResourceDeclaration({ ...declaration, lifecycle: { ...lifecycle, verifier_mode: "shared" } }), /contract is invalid/);
  assert.throws(() => parseHarborTaskResourceDeclaration({ ...declaration, lifecycle: { ...lifecycle, verifier_dependencies: { inputs: "artifacts-only", live_services: ["main"], artifacts: [] } } }), /dependencies conflict/);
});
