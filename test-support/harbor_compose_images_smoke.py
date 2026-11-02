"""Discover the public main + simulator topology without Harbor or Docker."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest

config = ModuleType("harbor.models.task.config")


class TaskConfig:
    fixture = None

    @staticmethod
    def model_validate(value):
        if TaskConfig.fixture is not None:
            return TaskConfig.fixture
        environment = SimpleNamespace(cpus=1, memory_mb=128, docker_image=None,
                                      os=SimpleNamespace(value="linux"), network_mode=None)
        return SimpleNamespace(environment=environment, agent=SimpleNamespace(network_mode=None),
                               verifier=SimpleNamespace(environment_mode=None, environment=None, network_mode=None))


config.TaskConfig = TaskConfig
config.VerifierEnvironmentMode = SimpleNamespace(SEPARATE="separate")
sys.modules["harbor.models.task.config"] = config
modes = ModuleType("harbor.models.task.verifier_mode")
# These fixtures isolate Hitch's discovery boundary. The manual lifecycle
# canary separately exercises the installed Harbor 0.21 resolver itself.
modes.resolve_task_verifier_mode = lambda task: task.verifier.environment_mode or ("separate" if task.verifier.environment else "shared")
modes.resolve_step_verifier_mode = lambda task, step: step.verifier.environment_mode or modes.resolve_task_verifier_mode(task)
modes.resolve_effective_verifier_env_config = lambda task, step: (step.verifier.environment if step and step.verifier.environment else task.verifier.environment or copy.deepcopy(task.environment)) if (modes.resolve_step_verifier_mode(task, step) if step else modes.resolve_task_verifier_mode(task)) == "separate" else None
sys.modules["harbor.models.task.verifier_mode"] = modes
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
from hitch_harbor_task_resources import inspect_task


class ComposeImageDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.environment = self.root / "environment"
        self.environment.mkdir()
        (self.root / "task.toml").write_text('schema_version = "1.4"\n')
        for name in ("Dockerfile", "Dockerfile.simulator"):
            (self.environment / name).write_text("FROM scratch\n")
        self.document = {"services": {
            "main": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile"},
                     "depends_on": {"simulator": {"condition": "service_healthy"}}},
            "simulator": {"platform": "linux/amd64", "build": {"context": ".", "dockerfile": "Dockerfile.simulator"},
                          "healthcheck": {"test": ["CMD", "true"]}},
        }}

    def tearDown(self):
        self.temporary.cleanup()

    def inspect(self, document):
        compose = self.environment / "docker-compose.yaml"
        original = json.dumps(document)
        compose.write_text(original)
        result = inspect_task(self.root)
        self.assertEqual(compose.read_text(), original)
        return result

    def test_plain_simulator_is_prepared_beside_legacy_main(self):
        result = self.inspect(self.document)
        self.assertEqual(result["environment_image_fallbacks"], [])
        self.assertEqual(result["environment_builds"], [
            {"source": "compose", "service": "simulator", "context": "environment", "dockerfile": "Dockerfile.simulator", "platform": "linux/amd64"},
            {"source": "task", "service": "main", "context": "environment", "dockerfile": "Dockerfile"},
        ])

    def test_context_and_dockerfile_paths_cannot_escape_or_use_symlinks(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "Dockerfile").write_text("FROM scratch\n")
        (self.environment / "linked").symlink_to(outside, target_is_directory=True)
        for build in ({"context": "../outside"}, {"context": str(outside)}, {"context": "linked"},
                      {"context": ".", "dockerfile": "../outside/Dockerfile"},
                      {"context": ".", "dockerfile": "./Dockerfile"},
                      {"context": "${CONTEXT}", "dockerfile": "Dockerfile"}):
            with self.subTest(build=build):
                document = copy.deepcopy(self.document)
                document["services"]["simulator"]["build"] = build
                self.assert_fallback(document)

    def assert_fallback(self, document):
        result = self.inspect(document)
        self.assertEqual([build for build in result["environment_builds"] if build["source"] == "compose"], [])
        self.assertEqual(result["environment_builds"], [])
        self.assertIn({"source": "compose", "service": "simulator", "code": "backend-build"}, result["environment_image_fallbacks"])

    def test_unsupported_builds_and_alias_consumers_keep_original_compose_path(self):
        variants = [
            {"build": {"context": ".", "args": {"MODE": "release"}}},
            {"build": {"context": ".", "target": "production"}},
            {"build": {"context": ".", "additional_contexts": {"main": "service:main"}}},
            {"image": "shared:latest"}, {"pull_policy": "build"},
            {"platform": None}, {"platform": "${PLATFORM}"},
        ]
        for changes in variants:
            with self.subTest(changes=changes):
                document = copy.deepcopy(self.document)
                document["services"]["simulator"].update(changes)
                self.assert_fallback(document)
        for consumer in ({"image": "some-project-simulator"},
                         {"volumes": [{"type": "image", "source": "some-project-simulator", "target": "/input"}]}):
            with self.subTest(consumer=consumer):
                document = copy.deepcopy(self.document)
                document["services"]["consumer"] = consumer
                self.assert_fallback(document)


class VerifierImageDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        for directory in ("environment", "tests"):
            (self.root / directory).mkdir()
            (self.root / directory / "Dockerfile").write_text(f"FROM scratch\n# {directory}\n")
        (self.root / "task.toml").write_text('schema_version = "1.4"\n')
        environment = SimpleNamespace(cpus=1, memory_mb=128, docker_image=None,
                                      os=SimpleNamespace(value="linux"), network_mode=None)
        self.config = SimpleNamespace(environment=environment, agent=SimpleNamespace(network_mode=None), steps=None,
                                      verifier=SimpleNamespace(environment_mode="separate", environment=None, network_mode=None))
        TaskConfig.fixture = self.config

    def tearDown(self):
        TaskConfig.fixture = None
        self.temporary.cleanup()

    def verifier_entries(self, kind):
        return [entry for entry in inspect_task(self.root)[kind] if entry["source"] == "verifier"]

    def test_separate_context_is_tests_without_reusing_candidate_recipe(self):
        self.assertEqual(self.verifier_entries("environment_builds"), [
            {"source": "verifier", "service": "main", "context": "tests", "dockerfile": "Dockerfile"}])
        self.assertEqual(self.verifier_entries("environment_image_fallbacks"), [])

    def test_effective_image_precedes_tests_dockerfile_and_shared_declares_no_role(self):
        self.config.environment.docker_image = "registry.test/candidate:v1"
        self.assertEqual(self.verifier_entries("environment_images"), [
            {"source": "verifier", "service": "main", "reference": "registry.test/candidate:v1"}])
        self.config.verifier.environment = copy.deepcopy(self.config.environment)
        self.config.verifier.environment.docker_image = "registry.test/verifier:v2"
        self.assertEqual(self.verifier_entries("environment_images")[0]["reference"], "registry.test/verifier:v2")
        self.config.verifier.environment.docker_image = None
        self.assertEqual(self.verifier_entries("environment_builds")[0]["context"], "tests")
        self.config.verifier.environment = None
        self.config.verifier.environment_mode = None
        self.assertEqual(self.verifier_entries("environment_images"), [])
        self.assertEqual(self.verifier_entries("environment_builds"), [])

    def test_missing_dockerfile_dynamic_image_and_authored_compose_are_explicit_fallbacks(self):
        tests = self.root / "tests"
        (tests / "Dockerfile").unlink()
        self.assertEqual(self.verifier_entries("environment_image_fallbacks")[0]["code"], "backend-build")
        self.config.environment.docker_image = "${VERIFIER_IMAGE}"
        self.assertEqual(self.verifier_entries("environment_image_fallbacks")[0]["code"], "dynamic-image")
        self.config.environment.docker_image = None
        (tests / "Dockerfile").write_text("FROM scratch\n")
        (tests / "docker-compose.yaml").write_text('services: {main: {build: {context: other, args: {MODE: custom}}}}')
        self.assertEqual(self.verifier_entries("environment_builds"), [])
        self.assertEqual(self.verifier_entries("environment_image_fallbacks")[0]["code"], "backend-build")

    def test_linked_verifier_context_and_dockerfile_are_not_followed(self):
        tests = self.root / "tests"
        dockerfile = tests / "Dockerfile"
        dockerfile.unlink()
        dockerfile.symlink_to(self.root / "environment/Dockerfile")
        self.assertEqual(self.verifier_entries("environment_builds"), [])
        self.assertEqual(self.verifier_entries("environment_image_fallbacks")[0]["code"], "backend-build")
        dockerfile.unlink()
        tests.rmdir()
        tests.symlink_to(self.root / "environment", target_is_directory=True)
        self.assertEqual(self.verifier_entries("environment_builds"), [])
        self.assertEqual(self.verifier_entries("environment_image_fallbacks")[0]["code"], "backend-build")

    def test_step_specific_contexts_do_not_receive_one_top_level_verifier_image(self):
        self.config.steps = [SimpleNamespace(name="custom", verifier=SimpleNamespace(environment_mode="separate", environment=None))]
        (self.root / "steps/custom/tests").mkdir(parents=True)
        (self.root / "steps/custom/tests/Dockerfile").write_text("FROM scratch\n# different step\n")
        self.assertEqual(self.verifier_entries("environment_builds"), [])
        self.assertEqual(self.verifier_entries("environment_images"), [])
        self.assertEqual(self.verifier_entries("environment_image_fallbacks"), [{"source": "verifier", "service": "main", "code": "backend-build"}])


if __name__ == "__main__":
    unittest.main()
