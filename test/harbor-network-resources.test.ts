import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseHarborTaskResourceDeclaration } from "../src/backends/index.js";

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
