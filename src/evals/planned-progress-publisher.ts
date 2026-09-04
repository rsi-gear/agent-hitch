import path from "node:path";
import type { EvalProgressV1, EvalTrialRefV1 } from "../domain/index.js";
import { readJSON } from "../foundation/index.js";
import { mergeEvalProgressTrial, writeEvalProgress } from "./progress.js";
import { validateEvalTrialReferences } from "./trial-reference-validation.js";
import type { ExecutePlannedHarborOptions } from "./planned-execution.js";

export class ProgressPublisher {
  private progress: EvalProgressV1;
  private tail: Promise<void> = Promise.resolve();
  private readonly options: ExecutePlannedHarborOptions;

  constructor(progress: EvalProgressV1, options: ExecutePlannedHarborOptions) {
    this.progress = progress;
    this.options = options;
  }

  publish(ref: EvalTrialRefV1, workId: string): Promise<void> {
    const operation = this.tail.then(async () => {
      const previous = this.progress.generation;
      const next = mergeEvalProgressTrial(this.progress, ref);
      if (next.generation === previous) return;
      await validateEvalTrialReferences(this.options.root, this.options.evalId, [ref], {
        benchmarkId: this.options.request.benchmark_id,
        benchmarkRevision: this.options.request.benchmark_revision,
      });
      if (ref.run_group) this.options.sink.emit({ type: "result.group.sealed", work_id: workId, run_group_id: ref.run_group.run_group_id, trial_id: ref.trial_id, group_digest: ref.run_group.digest });
      else {
        const bundle = await readJSON<{ bundle_digest?: string }>(path.join(this.options.root, "runs", ref.run_id, "bundle.index.json"));
        this.options.sink.emit({ type: "result.bundle.sealed", work_id: workId, run_id: ref.run_id, trial_id: ref.trial_id, bundle_digest: bundle.bundle_digest });
      }
      this.progress = next;
      await writeEvalProgress(this.options.evalDirectory, this.progress);
      this.options.sink.emit({
        type: "eval.trial.published",
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
    this.tail = operation.catch(() => {});
    return operation;
  }

  async settle(): Promise<void> {
    await this.tail;
  }

  current(): EvalProgressV1 {
    return this.progress;
  }
}
