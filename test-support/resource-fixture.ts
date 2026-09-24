import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, identity, parseResourceDataset, ResourceStore, sealResourceTask, type ResourceImageProvider, type TaskResourceLock, type ResourceDataset } from "../src/resources/index.js";
export const fixtureImageManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: hash("fixture OCI config"), size: 18 }, layers: [] });
export const fixtureImage = { kind: "oci-image" as const, manifestDigest: hash(fixtureImageManifest), platform: "linux/amd64" };
export const fixtureReference = `example.test/runtime@${fixtureImage.manifestDigest}`;
export class FixtureImageProvider implements ResourceImageProvider {
  readonly protocol = "hitch-oci-provider@1" as const;
  available = true;
  calls = 0;
  async resolve(resource: typeof fixtureImage) {
    this.calls++; if (!this.available || resource.manifestDigest !== fixtureImage.manifestDigest || resource.platform !== fixtureImage.platform) throw new Error("fixed OCI digest unavailable");
    return { imageId: hash("fixture provider image"), configDigest: hash("fixture OCI config"), manifestDigest: resource.manifestDigest, platform: resource.platform, reference: fixtureReference };
  }
  async exportArchive(_resource: typeof fixtureImage, destination: string) { await writeFile(destination, "fixture OCI archive"); }
  async validateArchive() { return { expandedBytes: 0, files: 0 }; }
  async importArchive() { this.available = true; }
}
export async function resourceFixture(directory: string, count = 3, taskIds?: string[]): Promise<{ store: ResourceStore; dataset: ResourceDataset; source: string; provider: FixtureImageProvider }> {
  const provider = new FixtureImageProvider(), store = new ResourceStore(path.join(directory, "host"), { images: provider, limits: { minFreeBytes: 0 } });
  const shared = path.join(directory, "shared"); await mkdir(path.join(shared, "empty"), { recursive: true }); await writeFile(path.join(shared, "input.txt"), "shared input\n".repeat(1000));
  const secretFile = path.join(directory, "secret"); await writeFile(secretFile, "verifier only");
  const runtime = await store.import(shared, "tree", "producer:tree"), secret = await store.import(secretFile, "blob", "producer:secret");
  const source = path.join(directory, "dataset"); await mkdir(source);
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const taskId = taskIds?.[i] ?? `task-${i}`, task = path.join(source, taskId);
    await mkdir(path.join(task, "environment/candidate"), { recursive: true }); await mkdir(path.join(task, "tests"));
    await writeFile(path.join(task, "task.toml"), 'schema_version = "1.4"\n[verifier]\nenvironment_mode = "separate"\n');
    await writeFile(path.join(task, "instruction.md"), `task ${i}`);
    await writeFile(path.join(task, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: { platform: fixtureImage.platform, build: { context: "candidate", dockerfile: "Dockerfile" } } } }));
    await writeFile(path.join(task, "environment/candidate/Dockerfile"), `FROM ${fixtureReference}\nCOPY data /data\n`);
    await writeFile(path.join(task, "tests/Dockerfile"), `FROM ${fixtureReference}\nCOPY . /tests\n`);
    const lock: TaskResourceLock = { protocol: "hitch-resource-lock@1", resources: { base: fixtureImage, shared: runtime.resource, secret: secret.resource }, requiredCapabilities: ["tree@1", "private-copy@1"], bindings: [
      { resource: "base", consumer: { role: "candidate" }, use: "environment-image", slot: "build-base" },
      { resource: "base", consumer: { role: "verifier" }, use: "environment-image", slot: "build-base" },
      { resource: "shared", consumer: { role: "candidate" }, use: "input-tree", target: "data", access: "private-copy" },
      { resource: "secret", consumer: { role: "verifier" }, use: "input-file", target: "answer.txt", access: "private-copy", executable: false },
    ] };
    await writeFile(path.join(task, "resource.lock.json"), JSON.stringify(lock)); tasks.push(await sealResourceTask(store, task, taskId, `dataset:${taskId}`));
  }
  await store.finishLease(runtime.leaseId, "ended"); await store.finishLease(secret.leaseId, "ended");
  const body = { schema_version: "2", kind: "gear-harbor-benchmark", resource_protocol: "hitch-resource-lock@1", execution: { backend: "harbor-role-context@1", resolver: "hitch-resource-resolver@1", platform: fixtureImage.platform }, required_capabilities: ["harbor-role-context@1"], benchmark: { id: "fixture", revision: "fixed" }, adapter: { id: "tree-producer", revision: "fixed", output_protocol: "gear-harbor-eval-result-v1" }, scoring: { total_score: { source_metric: "reward", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" } }, tasks };
  const dataset = parseResourceDataset({ ...body, dataset_digest: identity("hitch-resource-dataset@2", body) }); await writeFile(path.join(source, "benchmark.adapter.json"), JSON.stringify(dataset));
  return { store, dataset, source, provider };
}
