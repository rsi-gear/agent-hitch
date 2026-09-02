import type { EvalEnvironmentImageBuilder, EvalEnvironmentImageResolver, RunEvalOptions } from "../evals/index.js";
import { BuildSlotAdmission } from "./build-admission.js";
import { localEnvironmentImageBuild, localEnvironmentImageManifestLoader, localRegistryImageResolution } from "./eval-image-resolution.js";
import type { ResourceLedger } from "./resources.js";

export class EvalImageServices {
  private readonly buildAdmission: BuildSlotAdmission | undefined;
  private readonly resolver: EvalEnvironmentImageResolver;
  private readonly builder: EvalEnvironmentImageBuilder | undefined;
  private readonly root: string;

  constructor(input: {
    root: string;
    provider: string;
    resources: ResourceLedger;
    resolver?: EvalEnvironmentImageResolver;
    builder?: EvalEnvironmentImageBuilder;
    onEvent?: (event: Record<string, unknown>) => void;
  }) {
    this.root = input.root;
    this.resolver = input.resolver ?? localRegistryImageResolution(input.root);
    if (input.builder) this.builder = input.builder;
    else if (input.provider === "local-docker" && input.resources.canEverFit({ cpu_millis: 0, memory_bytes: 0, container_slots: 0, build_slots: 1 })) {
      const admission = new BuildSlotAdmission(input.resources);
      this.buildAdmission = admission;
      this.builder = localEnvironmentImageBuild(input.root, (signal) => admission.acquire(signal), undefined, input.onEvent);
    }
  }

  runOptions(): Pick<RunEvalOptions, "environmentImageResolver" | "environmentImageManifestLoader"> & Partial<Pick<RunEvalOptions, "environmentImageBuilder">> {
    return {
      environmentImageResolver: this.resolver,
      environmentImageManifestLoader: localEnvironmentImageManifestLoader(this.root),
      ...(this.builder ? { environmentImageBuilder: this.builder } : {}),
    };
  }

  close(): void {
    this.buildAdmission?.close();
  }
}
