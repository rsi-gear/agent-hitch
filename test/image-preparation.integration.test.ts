import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../src/foundation/index.js";
import { forceRemove } from "../test-support/helpers.js";

test("real BuildKit input selection preserves native filesystems and shares literal COPY inputs", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-build-input-selection-"));
  t.after(() => forceRemove(directory));
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/build_input_selection_docker.py", directory], { timeoutMs: 230_000 });
  assert.match(result.stdout, /native filesystem parity, literal reuse, changed inputs and ignore precedence OK/);
  t.diagnostic(result.stdout.trim());
});

test("real Docker image preparation shares immutable images and preserves verifier isolation", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-image-preparation-"));
  t.after(() => forceRemove(directory));
  const image = process.env.HITCH_IMAGE_PREPARATION_TEST_IMAGE;
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/image_preparation_docker.py", directory, image!], { timeoutMs: 230_000 });
  assert.match(result.stdout, /nested verifier isolation, eviction and graceful stop OK/);
  t.diagnostic(result.stdout.trim());
});

for (const group of ["explicit", "main", "worker"]) test(`real Compose preserves shared build tags (${group})`, {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 120_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-compose-image-reuse-"));
  t.after(() => forceRemove(directory));
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/compose_image_reuse_docker.py", directory, `--group=${group}`], { timeoutMs: 110_000 });
  assert.match(result.stdout, /requested collision cases and native controls OK/);
  t.diagnostic(result.stdout.trim());
});

test("real Compose image mounts consume the current build through cold and stale tags", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-compose-image-mounts-"));
  t.after(() => forceRemove(directory));
  const image = process.env.HITCH_IMAGE_PREPARATION_TEST_IMAGE;
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/compose_image_reuse_docker.py", directory, image!], { timeoutMs: 230_000 });
  assert.match(result.stdout, /native, cold, stale and aliased data images OK/);
  t.diagnostic(result.stdout.trim());
});

test("real Compose resolves task privileges and inherited mounts before sharing installations", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-shared-configuration-"));
  t.after(() => forceRemove(directory));
  const image = process.env.HITCH_IMAGE_PREPARATION_TEST_IMAGE;
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/shared_configuration_docker.py", directory, image!], { timeoutMs: 230_000 });
  assert.match(result.stdout, /resolved false values, inherited settings, unsafe privileges and mounts OK/);
  assert.match(result.stdout, /direct, readonly and transitive sidecar sharing refused before startup OK/);
  assert.match(result.stdout, /privileged and SYS_ADMIN refused, unrelated capability allowed OK/);
  t.diagnostic(result.stdout.trim());
});

test("real Compose preserves native image selection and registry refresh after cached builds", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-compose-pull-policy-"));
  t.after(() => forceRemove(directory));
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/compose_pull_policy_docker.py", directory], { timeoutMs: 230_000 });
  assert.match(result.stdout, /native, cold and repeated image selection, registry refresh and build-cache reuse OK/);
  t.diagnostic(result.stdout.trim());
});

test("real Compose build defaults and ignored unreadable inputs preserve native behavior", {
  skip: process.env.HITCH_IMAGE_PREPARATION_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-compose-build-inputs-"));
  t.after(() => forceRemove(directory));
  const image = process.env.HITCH_IMAGE_PREPARATION_TEST_IMAGE;
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/);
  const result = await runCommand(process.env.HITCH_HARBOR_TEST_PYTHON || "python3",
    ["test-support/compose_build_inputs_docker.py", directory, image!], { timeoutMs: 230_000 });
  assert.match(result.stdout, /dotenv platforms, warm identity, native conflicts and ignored input fallback OK/);
  assert.match(result.stdout, /native hardlinks and Git-derived labels preserved by fallback OK/);
  assert.match(result.stdout, /explicit and dotenv selection, mismatch refusal and probe isolation OK/);
  assert.match(result.stdout, /native build args and labels preserved by fallback OK/);
  assert.match(result.stdout, /native context and Dockerfile selected despite dollar siblings OK/);
  t.diagnostic(result.stdout.trim());
});
