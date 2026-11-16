import { access } from "node:fs/promises";
import path from "node:path";
import { supportsHarborAttemptIsolation } from "../backends/index.js";
import { configuredResourceStore, readResourceInput, resourceDescriptorDirectory } from "../resources/index.js";

/** Resolve the same immutable descriptor inputs used by local task planning. */
export async function supportsLocalTaskIsolation(input: {
  root: string;
  dataset: string;
  taskIds: readonly string[];
  runtimeDirectory: string;
  harborExecutable?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<boolean> {
  const resource = await readResourceInput(input.dataset);
  const store = resource ? (await configuredResourceStore(input.root)).store : undefined;
  const single = await access(path.join(input.dataset, "task.toml")).then(() => true, () => false);
  const taskDirectories = await Promise.all(input.taskIds.map(async taskId => {
    if (!resource) return single ? input.dataset : path.join(input.dataset, taskId);
    const task = resource.tasks.find(entry => entry.task_id === taskId);
    if (!task) throw new TypeError("resource isolation task selection mismatch");
    return resourceDescriptorDirectory(store!, task);
  }));
  return supportsHarborAttemptIsolation({
    root: input.root, taskDirectories, runtimeDirectory: input.runtimeDirectory,
    env: input.env,
    ...(input.harborExecutable ? { harborExecutable: input.harborExecutable } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
