import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvironmentImageUseV1, Sha256 } from "../src/domain/index.js";
import { atomicWriteJSON, beginEvalEnvironmentImagePlanning, hitchRootId, sha256JSON, statePaths, withEnvironmentImageReferenceLock, writeEvalEnvironmentImageReferences } from "../src/foundation/index.js";
import { ENVIRONMENT_IMAGE_LABELS, EnvironmentImageService, gcEnvironmentImages, loadEnvironmentImageManifest, pinEnvironmentImage, unpinEnvironmentImage } from "../src/images/index.js";
import type { EnvironmentImageBuilder } from "../src/images/index.js";

test("environment image GC retains active eval, sealed bundle, and operator-pin references and deletes only double-fenced builds", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-image-gc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dockerImages = new Map<string, { config: Sha256; cacheKey: Sha256; owned: boolean }>();
  const removed: string[] = [];
  const builder: EnvironmentImageBuilder = {
    id: "gc-test-builder",
    probe: async () => false,
    build: async (input) => {
      const config = sha256JSON({ config: input.cacheKey });
      const manifest = sha256JSON({ manifest: input.cacheKey });
      dockerImages.set(input.outputReference, { config, cacheKey: input.cacheKey, owned: true });
      return { reference: input.outputReference, manifest_digest: manifest, config_digest: config, platform: input.platform };
    },
  };
  const service = new EnvironmentImageService({ root, builder });
  const built = [];
  for (const name of ["active", "sealed", "pinned", "unused", "foreign-label"]) {
    const context = path.join(root, "contexts", name);
    await mkdir(context, { recursive: true });
    await writeFile(path.join(context, "Dockerfile"), "FROM scratch\nCOPY payload /payload\n");
    await writeFile(path.join(context, "payload"), `${name}\n`);
    built.push((await service.build({
      benchmarkId: "gc", benchmarkRevision: "1", taskId: name,
      contextDirectory: context, platform: "linux/amd64",
    })).manifest);
  }
  const [active, sealed, pinned, unused, foreign] = built;
  assert.ok(active && sealed && pinned && unused && foreign);
  const foreignImage = dockerImages.get(foreign.output.reference);
  assert.ok(foreignImage);
  foreignImage.owned = false;

  const evalId = `eval_${"a".repeat(32)}`;
  const evalDirectory = path.join(statePaths(root).evals, evalId);
  await mkdir(evalDirectory, { recursive: true });
  await atomicWriteJSON(path.join(evalDirectory, "control.json"), { schema_version: "1", eval_id: evalId, state: "running" });
  await writeEvalEnvironmentImageReferences(evalDirectory, evalId, [imageUse(active)]);

  const runDirectory = path.join(statePaths(root).runs, "run_sealed");
  await mkdir(runDirectory, { recursive: true });
  const bundleIdentity = {
    schema_version: "1", run_id: "run_sealed", sealed: true,
    environment: { images: [{ image_id: sealed.image_id }] },
  };
  await atomicWriteJSON(path.join(runDirectory, "manifest.json"), { schema_version: "1", run_id: "run_sealed", sealed: true });
  await atomicWriteJSON(path.join(runDirectory, "bundle.index.json"), {
    ...bundleIdentity, bundle_digest: sha256JSON(bundleIdentity), created_at: new Date().toISOString(),
  });
  await pinEnvironmentImage(root, pinned.image_id, "operator retention test");

  const run = async (args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "image" && args[1] === "inspect") {
      const image = dockerImages.get(args.at(-1) as string);
      if (!image) throw new Error("image unavailable");
      return { stdout: JSON.stringify({
        Id: image.config,
        Config: { Labels: {
          [ENVIRONMENT_IMAGE_LABELS.rootId]: image.owned ? hitchRootId(root) : "f".repeat(24),
          [ENVIRONMENT_IMAGE_LABELS.cacheKey]: image.cacheKey,
        } },
      }) };
    }
    if (args[0] === "image" && args[1] === "rm") {
      removed.push(args[2] as string);
      dockerImages.delete(args[2] as string);
      return { stdout: "deleted\n" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  };

  const dry = await gcEnvironmentImages({ root, dryRun: true, minimumAgeMs: 0, run });
  assert.equal(dry.scanned, 5);
  assert.deepEqual(new Map(dry.retained.map((entry) => [entry.image_id, entry.reasons])), new Map([
    [active.image_id, ["active-eval"]],
    [sealed.image_id, ["sealed-bundle"]],
    [pinned.image_id, ["operator-pin"]],
  ]));
  assert.deepEqual(dry.eligible.map((entry) => entry.image_id), [unused.image_id]);
  assert.deepEqual(dry.skipped, [{ image_id: foreign.image_id, code: "ownership-label-mismatch" }]);
  assert.deepEqual(removed, []);

  const applied = await gcEnvironmentImages({ root, dryRun: false, minimumAgeMs: 0, run });
  assert.deepEqual(applied.removed.map((entry) => entry.image_id), [unused.image_id]);
  assert.deepEqual(removed, [unused.output.reference]);
  await assert.rejects(loadEnvironmentImageManifest(root, unused.image_id), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal((await readFile(path.join(evalDirectory, "environment-image-refs.json"), "utf8")).includes(active.image_id), true);

  await unpinEnvironmentImage(root, pinned.image_id);
  await atomicWriteJSON(path.join(evalDirectory, "control.json"), { schema_version: "1", eval_id: evalId, state: "succeeded" });
  const second = await gcEnvironmentImages({ root, dryRun: false, minimumAgeMs: 0, run });
  assert.deepEqual(second.removed.map((entry) => entry.image_id).sort(), [active.image_id, pinned.image_id].sort());
  assert.deepEqual(second.retained, [{ image_id: sealed.image_id, reasons: ["sealed-bundle"] }]);

  const incompleteEval = `eval_${"b".repeat(32)}`;
  const incompleteDirectory = path.join(statePaths(root).evals, incompleteEval);
  await mkdir(incompleteDirectory, { recursive: true });
  await atomicWriteJSON(path.join(incompleteDirectory, "request.json"), { schema_version: "1" });
  await withEnvironmentImageReferenceLock(root, () => beginEvalEnvironmentImagePlanning(incompleteDirectory, incompleteEval));
  await assert.rejects(
    gcEnvironmentImages({ root, dryRun: false, minimumAgeMs: 0, run }),
    (error: unknown) => (error as { code?: string }).code === "environment_image_gc_reference_scan_failed",
  );
  assert.equal(dockerImages.has(foreign.output.reference), true, "failed reference scan must not reach Docker removal");
});

function imageUse(manifest: Awaited<ReturnType<EnvironmentImageService["build"]>>["manifest"]): EnvironmentImageUseV1 {
  return {
    task_ids: [manifest.source.task_id as string],
    image_id: manifest.image_id,
    requested_reference: manifest.output.reference,
    reference: `${manifest.output.reference}@${manifest.output.manifest_digest}`,
    manifest_digest: manifest.output.manifest_digest,
    platform: manifest.platform,
    resolution: "prebuilt",
    cache_hit: false,
  };
}
