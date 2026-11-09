import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { atomicWriteJSON, HitchError, sha256Bytes } from "../foundation/index.js";
import { configuredResourceStore } from "../resources/index.js";
import { sealRunOutputArtifacts } from "../runs/index.js";
import { verifiedTrialManifest, verifiedTaskToml, type TrialBenchmarkBinding, type VerifiedTrialBenchmark } from "./benchmark-verification.js";
import { verifyBenchmarkTaskSnapshot } from "./benchmark-adapter-manifest.js";

/** Snapshot declared task outputs before the immutable run bundle is published. */
export async function captureTrialOutputArtifacts(input: {
  root: string; runDirectory: string; runId: string; evalId: string; taskId: string; attempt: number;
  trialDirectory: string; harnessCommit?: string; provider?: string;
  verifiedTrialBenchmark?: VerifiedTrialBenchmark; verifiedTrialBinding?: TrialBenchmarkBinding; signal?: AbortSignal;
}): Promise<void> {
  await rm(path.join(input.runDirectory, "output-artifacts"), { recursive: true, force: true });
  await rm(path.join(input.runDirectory, "output-artifacts-status.json"), { force: true });
  try {
    if (!input.harnessCommit || !input.verifiedTrialBenchmark || !input.verifiedTrialBinding
      || input.provider && input.provider !== "local-docker") throw unavailable();
    const manifest = await verifiedTrialManifest(input.verifiedTrialBenchmark, input.verifiedTrialBinding);
    const task = manifest?.tasks.find(t => t.task_id === input.taskId);
    if (!manifest || !task) throw unavailable();
    let bytes: Buffer;
    if (manifest.schema_version === "3") {
      const resourceTask = manifest.tasks.find(t => t.task_id === input.taskId)!;
      const { store } = await configuredResourceStore(input.root);
      const tree = await store.objects.readTree(resourceTask.sourceTree.manifestDigest);
      const entry = tree.entries.find(e => e.path === "task.toml");
      if (!entry || entry.kind !== "file" || entry.size > 1024 * 1024) throw unavailable();
      await store.objects.verify(entry.digest, entry.size);
      bytes = await readFile(store.objects.objectPath(entry.digest));
      if (sha256Bytes(bytes) !== entry.digest) throw unavailable();
    } else {
      const snapshot = verifiedTaskToml(input.verifiedTrialBenchmark, input.verifiedTrialBinding)
        ?? (await verifyBenchmarkTaskSnapshot(await realpath(input.verifiedTrialBinding.request.dataset), task)).taskToml;
      if (!snapshot || snapshot.length > 1024 * 1024) throw unavailable();
      bytes = snapshot;
    }
    const declaration = parseToml(bytes.toString("utf8"));
    const raw = declaration.artifacts;
    if (!Array.isArray(raw) || raw.length === 0) throw unavailable();
    const selected = raw.map(value => {
      const entry = typeof value === "string" ? { source: value } : value as { source?: unknown; destination?: unknown; service?: unknown };
      if (!entry || typeof entry.source !== "string" || !entry.source.startsWith("/") || entry.source.startsWith("//")
        || entry.service != null && entry.service !== "main") throw unavailable();
      const source = entry.source.slice(1);
      if (!source || source.split("/").some(s => !s || s === "." || s === "..")) throw unavailable();
      return typeof entry.destination === "string" && entry.destination ? entry.destination : source;
    });
    await sealRunOutputArtifacts({ runDirectory: input.runDirectory,
      sourceDirectory: path.join(input.trialDirectory, "artifacts"), paths: selected,
      identity: { run_id: input.runId, eval_id: input.evalId, task_id: input.taskId, attempt: input.attempt,
        harness_commit: input.harnessCommit, task_digest: task.task_digest }, ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    await rm(path.join(input.runDirectory, "output-artifacts"), { recursive: true, force: true });
    const code = error instanceof HitchError && error.code.startsWith("output_artifacts_") ? error.code : "output_artifacts_corrupt";
    await atomicWriteJSON(path.join(input.runDirectory, "output-artifacts-status.json"), {
      schema_version: "1", status: "unavailable", code,
    });
  }
}
function unavailable(): HitchError {
  return new HitchError("declared run output artifacts are unsupported for this execution", { code: "output_artifacts_unavailable", exitCode: 3 });
}
