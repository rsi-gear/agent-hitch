import { readdir } from "node:fs/promises";
import path from "node:path";
import type { EvalId } from "../domain/index.js";
import { EvalEventSink, assertRemoteRerunQuiescent, loadEvalResumeState, readExecutionLeases, readRemoteRerunCompletion, restoreRemoteRerunSelection } from "../evals/index.js";
import type { EvalRerunResult, EvalRerunType } from "../evals/index.js";
import { HitchError, atomicWriteJSON, readJSON } from "../foundation/index.js";
import { parsePersistedSubmission } from "./rerun-submission.js";
import type { ParsedRerunInput } from "./rerun-submission.js";
import type { loadRerunSource } from "./rerun-source.js";
import type { RemoteWorkCoordinator } from "./remote-work-coordinator.js";

type Identity = { evalId: EvalId; rerunId: string; rerunType: EvalRerunType; directory: string };
type Source = Awaited<ReturnType<typeof loadRerunSource>>;

export async function recoverPersistedReruns(input: {
  rerunsRoot: string; localProvider: string; remoteWork?: RemoteWorkCoordinator;
  loadSource(evalId: EvalId, type: EvalRerunType): Promise<Source>;
  enqueue(identity: Identity, parsed: ParsedRerunInput, source: Source, resume: boolean): Promise<void>;
  fail(identity: Identity, code: string, message: string): Promise<void>;
  complete(identity: Identity, result: EvalRerunResult, sourceDigest: string): Promise<void>;
  onEvent(event: Record<string, unknown>): void;
}): Promise<void> {
  for (const evalEntry of await readdir(input.rerunsRoot, { withFileTypes: true })) {
    if (!evalEntry.isDirectory() || !/^eval_[a-f0-9]{32}$/.test(evalEntry.name)) continue;
    const evalDirectory = path.join(input.rerunsRoot, evalEntry.name), reruns = path.join(evalDirectory, "reruns");
    let entries;
    try { entries = await readdir(reruns, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^rerun_[a-f0-9]{32}$/.test(entry.name)) continue;
      const directory = path.join(reruns, entry.name), evalId = evalEntry.name as EvalId;
      const state = await readJSON<Record<string, unknown> | null>(path.join(directory, "state.json"), null);
      const submission = await readJSON<Record<string, unknown> | null>(path.join(directory, "submission.json"), null);
      if (!state || !submission || !["queued", "running", "completed"].includes(String(state.status))) continue;
      const parsed = parsePersistedSubmission(submission, evalId, entry.name);
      assertRerunStateIdentity(state, evalId, entry.name);
      const identity = { evalId, rerunId: entry.name, rerunType: parsed.rerun_type, directory };
      const cancelled = !!await readJSON(path.join(directory, "cancellation.json"), null);
      try {
        const pending = await readRemoteRerunCompletion(directory, evalId, entry.name);
        if (pending && ["running", "completed"].includes(String(state.status))) {
          if (!["candidate-restart", "verifier-only"].includes(parsed.rerun_type)) throw ambiguous();
          const source = await input.loadSource(evalId, "collect-only");
          if (source.execution.provider === input.localProvider) throw ambiguous();
          await assertRemoteRerunQuiescent(evalDirectory, source.execution.provider);
          await input.complete(identity, pending.result, pending.source_result_digest);
          continue;
        }
        if (state.status === "completed") continue;
        let source: Source;
        if (state.status === "running") {
          if (!["candidate-restart", "verifier-only"].includes(parsed.rerun_type) || !input.remoteWork) throw ambiguous();
          source = await input.loadSource(evalId, "collect-only");
          if (source.execution.provider === input.localProvider) throw ambiguous();
          const frozen = await loadEvalResumeState(evalDirectory);
          await restoreRemoteRerunSelection({ directory, evalId, rerunId: entry.name, selector: parsed.selector,
            tasks: [...new Set(frozen.executionPlan.slots.map(slot => slot.task_id))], attempts: source.request.attempts, progress: frozen.progress, rerunType: parsed.rerun_type,
            ...(parsed.verifier_runtime_id ? { verifierRuntimeId: parsed.verifier_runtime_id } : {}) });
          const sink = new EvalEventSink(directory, evalId, input.onEvent); await sink.open();
          const recovered = await input.remoteWork.recoverEvalLeases({ evalId, evalDirectory, leases: await readExecutionLeases(evalDirectory),
            cancelRequested: cancelled, emit: event => sink.emit({ ...event, rerun_id: entry.name }) }).finally(() => sink.close());
          if (recovered.status !== "resumable") throw new HitchError(recovered.message ?? "remote lease recovery is ambiguous", { code: recovered.code ?? "execution_state_ambiguous", exitCode: 12 });
          await assertRemoteRerunQuiescent(evalDirectory, source.execution.provider);
        } else if (!cancelled) source = await input.loadSource(evalId, parsed.rerun_type);
        if (cancelled) {
          await atomicWriteJSON(path.join(directory, "state.json"), { ...state, status: "cancelled", updated_at: new Date().toISOString(), completed_at: new Date().toISOString() });
          continue;
        }
        await input.enqueue(identity, parsed, source!, state.status === "running");
      } catch (error) {
        await input.fail(identity, error instanceof HitchError ? error.code : "execution_state_ambiguous",
          state.status === "running" ? "interrupted rerun could not reconcile its frozen selection or execution leases" : "queued rerun could not restore its source or provider");
      }
    }
  }
}

export function assertRerunStateIdentity(state: Record<string, unknown>, evalId: EvalId, rerunId: string): void {
  if (state.schema_version !== "1" || state.eval_id !== evalId || state.rerun_id !== rerunId
    || typeof state.status !== "string" || !["queued", "running", "completed", "failed", "cancelled"].includes(state.status)) throw new TypeError("eval rerun state identity is invalid");
}
function ambiguous(): HitchError { return new HitchError("daemon restarted while rerun execution state was ambiguous", { code: "execution_state_ambiguous", exitCode: 12 }); }
