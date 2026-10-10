import path from "node:path";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { readJSON } from "../foundation/index.js";
import { evalTrialKey, mergeEvalProgressTrial, replaceInvalidEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { validateEvalTrialReferences } from "./trial-reference-validation.js";
import type { ExecutePlannedHarborOptions } from "./planned-execution.js";

type PublisherOptions = Pick<ExecutePlannedHarborOptions, "root" | "evalId" | "evalDirectory" | "request" | "sink">;

export class ProgressPublisher {
  private progress: EvalProgressV1;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly failures = new Map<string, unknown>();
  private readonly options: PublisherOptions;

  constructor(progress: EvalProgressV1, options: PublisherOptions) {
    this.progress = progress;
    this.options = options;
  }

  publish(ref: EvalTrialRefV1, workId: string): Promise<void> {
    return this.enqueue(ref, workId, "settle");
  }

  replaceInvalid(ref: EvalTrialRefV1, workId: string): Promise<void> {
    return this.enqueue(ref, workId, "replace-invalid");
  }

  private enqueue(ref: EvalTrialRefV1, workId: string, mode: "settle" | "replace-invalid"): Promise<void> {
    if (this.closing) return Promise.reject(new TypeError("eval progress publisher is closed"));
    const key = evalTrialKey(ref);
    const operation = this.tail.then(async () => {
      const previous = this.progress.generation;
      const next = mode === "settle"
        ? mergeEvalProgressTrial(this.progress, ref)
        : replaceInvalidEvalProgressTrial(this.progress, ref);
      if (next.generation === previous) { this.failures.delete(key); return; }
      await validateEvalTrialReferences(this.options.root, this.options.evalId, [ref], {
        benchmarkId: this.options.request.benchmark_id,
        benchmarkRevision: this.options.request.benchmark_revision,
      });
      if (ref.run_group) this.options.sink.emit({ type: "result.group.sealed", work_id: workId, run_group_id: ref.run_group.run_group_id, trial_id: ref.trial_id, group_digest: ref.run_group.digest });
      else {
        const bundle = await readJSON<{ bundle_digest?: string }>(path.join(this.options.root, "runs", ref.run_id, "bundle.index.json"));
        this.options.sink.emit({ type: "result.bundle.sealed", work_id: workId, run_id: ref.run_id, trial_id: ref.trial_id, bundle_digest: bundle.bundle_digest });
      }
      this.progress = await writeEvalProgress(this.options.evalDirectory, next, { terminalRepair: mode === "replace-invalid" });
      this.failures.delete(key);
      this.options.sink.emit({
        type: mode === "settle" ? "eval.trial.published" : "eval.trial.replaced",
        work_id: workId,
        trial_id: ref.trial_id,
        task_id: ref.task_id,
        attempt: ref.attempt,
        run_id: ref.run_id,
        ...(ref.run_group ? { run_group_id: ref.run_group.run_group_id } : {}),
        observation_status: ref.observation_status,
        settled_trials: this.progress.trials.length,
        generation: this.progress.generation,
      });
    });
    this.tail = operation.catch(error => { this.failures.set(key, error); });
    return operation;
  }

  async settle(): Promise<void> {
    await this.tail;
    if (this.failures.size) throw this.failures.values().next().value;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.settle();
  }

  current(): EvalProgressV1 {
    return this.progress;
  }
}
