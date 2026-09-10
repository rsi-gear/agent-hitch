import type { ExecutionObservationSourceV2 } from "../domain/index.js";
import { observeHarborEnvironment } from "../backends/index.js";
import type { HarborObservationOptions } from "../backends/index.js";
import { ResidentRuntimeObserver } from "../controller-runtime/index.js";
import { HitchError } from "../foundation/index.js";

/** Share the same executable selections and environment as the resident executor. */
export class LocalExecutionObserver implements ExecutionObservationSourceV2 {
  private readonly runtime = new ResidentRuntimeObserver();
  private observing = false;
  constructor(private readonly options: HarborObservationOptions) {}
  async initialize(): Promise<void> { await this.runtime.initialize(); }
  async observeRuntime(): ReturnType<ExecutionObservationSourceV2["observeRuntime"]> { return this.runtime.observe(); }
  async observe(signal?: AbortSignal): ReturnType<ExecutionObservationSourceV2["observe"]> {
    if (this.observing) throw new HitchError("execution environment observation is already running; retry", { code: "execution_observation_busy", exitCode: 12 });
    this.observing = true;
    try {
      signal?.throwIfAborted();
      const before = await this.runtime.observe();
      const environment = await observeHarborEnvironment({ ...this.options, ...(signal ? { signal } : {}) });
      const runtime = await this.runtime.observe();
      signal?.throwIfAborted();
      runtime.unchanged &&= before.unchanged;
      return { runtime, environment };
    } finally { this.observing = false; }
  }
}
