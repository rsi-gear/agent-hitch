import { readFile } from "node:fs/promises";
import path from "node:path";
import { invalidInput } from "../foundation/index.js";
import type { BenchmarkAdapterManifestV1 } from "./benchmark-adapter-manifest.js";

interface CandidateRequirements {
  driver: { kind: string };
  requirements: readonly string[];
}

export function assertBenchmarkCandidate(tasks: readonly CandidateRequirements[], harnessId: string, agentArgs: readonly string[]): void {
  if (tasks.some(task => task.driver.kind === "model-call") && (harnessId !== "model-call" || agentArgs.length)) {
    throw invalidInput("no-tools tasks require the trusted model-call harness without agent overrides");
  }
  if (tasks.some(task => task.driver.kind !== "model-call" && task.requirements.includes("native-image-input")) && harnessId !== "codex") {
    throw invalidInput("native-image agent tasks currently require the Codex image-capable harness");
  }
}

/** The verified task trees contain the Package v1 requirements after export. */
export async function assertStandardBenchmarkCandidate(
  dataset: string,
  manifest: BenchmarkAdapterManifestV1,
  harnessId: string,
  agentArgs: readonly string[],
): Promise<void> {
  const tasks: CandidateRequirements[] = [];
  for (const { task_id } of manifest.tasks) {
    let descriptor;
    try {
      descriptor = JSON.parse(await readFile(path.join(dataset, task_id, ".hitch-benchmark.json"), "utf8"));
    } catch (error) {
      // Direct Harbor adapters need not use the Package v1 execution bridge.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const task = descriptor?.task;
    if (descriptor?.schema_version !== "1" || descriptor.task_id !== task_id
      || !["model-call", "terminal", "tool-server"].includes(task?.driver?.kind)
      || !Array.isArray(task?.requirements) || task.requirements.some((item: unknown) => typeof item !== "string")) {
      throw invalidInput(`invalid compiled candidate requirements: ${task_id}`);
    }
    tasks.push(task);
  }
  assertBenchmarkCandidate(tasks, harnessId, agentArgs);
}
