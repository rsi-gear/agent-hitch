import path from "node:path";
import type { RemoteWorkOfferV1 } from "../domain/index.js";

export function remoteBackendResult(offered: RemoteWorkOfferV1, terminal: RemoteWorkOfferV1, trial: Record<string, unknown> | null, backendDirectory: string | null, version: string | null = null,
  verifier?: import("../domain/index.js").RemoteVerifierOutcomeV2) {
  const directory = backendDirectory ?? path.join("remote", offered.work.work_id);
  const succeeded = terminal.terminal?.status === "succeeded" && trial !== null;
  return {
    backend: {
      name: "harbor", executable: `remote-worker:${offered.worker_id}`, version,
      identity: `${offered.lease.provider}:${offered.worker_id}:${offered.generation}`,
      config_path: path.join(directory, verifier ? "assessment.json" : "remote-offer.json"), result_path: succeeded ? path.join(directory, verifier ? "evidence/trial.json" : "remote-result.json") : null,
      stdout_path: path.join(directory, verifier ? "evidence/verifier/test-stdout.txt" : "remote.stdout.log"), stderr_path: path.join(directory, verifier ? "evidence/verifier/test-stderr.txt" : "remote.stderr.log"),
      process_exit_code: verifier ? verifier.backend.process_exit_code : succeeded ? 0 : 1, signal: (verifier?.backend.signal ?? null) as NodeJS.Signals | null,
      job_directory: path.join(directory, verifier ? "evidence" : "job"),
    },
    rawResult: trial ? { trial_results: [trial] } : null,
    summary: trial ? { n_trials: 1, remote_worker: offered.worker_id } : null,
  };
}
