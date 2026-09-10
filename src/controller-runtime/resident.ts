import type { ControllerRuntimeObservationV2, ResidentRuntimeObservationV2 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { observeControllerRuntime } from "./observation.js";

export class ResidentRuntimeObserver {
  private startup: ControllerRuntimeObservationV2 | undefined;
  constructor(private readonly read = observeControllerRuntime) {}

  async initialize(): Promise<void> {
    if (this.startup) throw new Error("resident runtime startup snapshot is already captured");
    this.startup = structuredClone(await this.read());
  }

  async observe(): Promise<ResidentRuntimeObservationV2> {
    if (!this.startup) throw new Error("resident runtime startup snapshot is unavailable");
    const current = await this.read();
    return { schema_version: "2", startup: structuredClone(this.startup), current,
      unchanged: sha256JSON(this.startup) === sha256JSON(current) };
  }
}
