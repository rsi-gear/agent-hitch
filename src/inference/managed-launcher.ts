import type { InferenceServiceRecordV1 } from "../domain/index.js";
import { loadModelNodeClient } from "./node-registry.js";
import { ProcessSGLangLauncher } from "./process-sglang.js";
import { DockerSGLangLauncher } from "./sglang.js";
import type { SGLangAttachInput, SGLangLauncher, SGLangLaunchInput } from "./sglang.js";
import { readInferenceGenerationRelease } from "./generation-recovery.js";

/** Dispatch by the frozen model location; the Harbor provider is independent. */
export class ManagedSGLangLauncher implements SGLangLauncher {
  constructor(private readonly docker: SGLangLauncher = new DockerSGLangLauncher()) {}
  async start(input: SGLangLaunchInput) {
    if (!input.lock.model_node) return this.docker.start(input);
    return new ProcessSGLangLauncher(await loadModelNodeClient(input.root, input.lock.model_node)).start(input);
  }
  async attach(input: SGLangAttachInput) {
    if (!input.lock.model_node || await readInferenceGenerationRelease(input.root, input.record)) {
      throw new TypeError("only an unreleased model-node process supports attachment");
    }
    return new ProcessSGLangLauncher(await loadModelNodeClient(input.root, input.lock.model_node)).attach(input);
  }
  async stopOrphan(root: string, record: InferenceServiceRecordV1): Promise<"stopped" | "missing" | "ambiguous"> {
    if (!record.model_node) return this.docker.stopOrphan?.(root, record) ?? "ambiguous";
    try {
      if (await readInferenceGenerationRelease(root, record)) return "stopped";
      return await new ProcessSGLangLauncher(await loadModelNodeClient(root, record.model_node)).stopOrphan(root, record);
    }
    catch { return "ambiguous"; }
  }
}
