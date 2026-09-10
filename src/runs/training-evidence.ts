import { readFile } from "node:fs/promises";
import path from "node:path";
import { invalidInput, readJSON, statePaths } from "../foundation/index.js";
import { loadRunRecord } from "./records.js";

export async function loadTrainingEvidence(root: string, runId: string): Promise<Record<string, unknown>> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw invalidInput("training evidence requires a canonical run ID");
  const directory = path.join(statePaths(root).runs, runId);
  const loaded = await loadRunRecord(directory, { verifyTrajectory: true });
  if (loaded.record_status === "corrupt" || loaded.trajectory_status === "corrupt") throw invalidInput("training run evidence failed integrity verification");
  const manifest = await readJSON<Record<string, unknown>>(path.join(directory, "manifest.json"));
  const result = await readJSON<Record<string, unknown>>(path.join(directory, "result.json"));
  if (!manifest.training_external || !["succeeded", "failed", "timed_out", "cancelled"].includes(String(manifest.status))) throw invalidInput("run has no sealed training evidence");
  const events = (await readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const endings = events.filter(event => event.type === "provider.event" && event.provider_type === "training.terminated").map(event => (event.native as Record<string, unknown>)?.termination);
  const termination = result.status === "cancelled" ? "aborted" : result.status === "timed_out" ? "truncated"
    : endings.length === 1 && ["terminated", "truncated"].includes(String(endings[0])) ? endings[0] : "infra-error";
  return { schema_version: "1", run_id: runId, training_external: manifest.training_external, termination, result };
}
