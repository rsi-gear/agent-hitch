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
