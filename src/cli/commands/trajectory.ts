import path from "node:path";
import { HitchError, SCHEMA_VERSION, invalidInput, statePaths } from "../../foundation/index.js";
import {
  DEFAULT_ANALYSIS_MAX_BYTES,
  DEFAULT_EVENTS_LIMIT,
  DEFAULT_EVENTS_MAX_BYTES,
  loadCanonicalTrajectorySource,
  loadTrajectoryRef,
  pageTrajectoryEvents,
  projectTrajectoryAnalysis,
  readTrajectory,
  serializeBoundedJson,
} from "../../trajectories/index.js";
import type { CanonicalTrajectorySource, TrajectoryEventsFilter } from "../../trajectories/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function trajectoryCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "inspect") return inspectTrajectory(args, root);
  if (action === "project") return projectTrajectory(args, root);
  if (action === "events") return eventsTrajectory(args, root);
  throw invalidInput("trajectory requires inspect, project, or events");
}

async function inspectTrajectory(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const runId = args.shift();
  if (!runId) throw invalidInput("trajectory inspect requires a run ID");
  assertNoArgs(args);
  const runDirectory = path.join(statePaths(root).runs, runId);
  const ref = await loadTrajectoryRef(runDirectory);
  if (!ref) {
    throw new HitchError(`run ${runId} has no canonical trajectory`, { code: "trajectory_not_found", exitCode: 3 });
  }
  const { header, events } = await readTrajectory(ref.path);
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, run_id: runId, ref, header, events })}\n`);
    return;
  }
  process.stdout.write(`${runId}: ${ref.fidelity} trajectory (${events.length} events)\n`);
  process.stdout.write(`  session: ${ref.session_id}\n`);
  process.stdout.write(`  path: ${ref.path}\n`);
  const assistantMessages = events.filter((event) => event.type === "assistant/message");
  const toolResults = events.filter((event) => event.type === "tool/result");
  process.stdout.write(`  assistant messages: ${assistantMessages.length}, tool results: ${toolResults.length}\n`);
}

async function projectTrajectory(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const profile = takeOption(args, "--profile") ?? "analysis-v1";
  const maxBytes = integerOption(takeOption(args, "--max-bytes"), DEFAULT_ANALYSIS_MAX_BYTES, "--max-bytes", 1);
  const runId = args.shift();
  if (!runId) throw invalidInput("trajectory project requires a run ID");
  if (profile !== "analysis-v1") throw invalidInput("trajectory project --profile must be analysis-v1");
  assertNoArgs(args);
  const source = await requireSource(root, runId);
  const result = await projectTrajectoryAnalysis(source, { maxBytes });
  if (json) {
    process.stdout.write(serializeBoundedJson(result, maxBytes));
    return;
  }
  process.stdout.write(`${runId}: bounded trajectory analysis\n`);
  process.stdout.write(`  source: ${result.source.event_count} events, ${result.source.canonical_bytes} bytes\n`);
  process.stdout.write(`  surface: ${result.surface.current_node_seqs.length} current nodes\n`);
  process.stdout.write(`  diagnostic: ${result.events.length} events, ${result.chunk_summaries.length} chunk summaries\n`);
}

async function eventsTrajectory(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const typesValue = takeOption(args, "--types");
  const seqStartValue = takeOption(args, "--seq-start");
  const seqEndValue = takeOption(args, "--seq-end");
  const field = takeOption(args, "--field");
  const canonicalSha256Value = takeOption(args, "--canonical-sha256");
  const cursor = takeOption(args, "--cursor");
  const limit = integerOption(takeOption(args, "--limit"), DEFAULT_EVENTS_LIMIT, "--limit", 1);
  const maxBytes = integerOption(takeOption(args, "--max-bytes"), DEFAULT_EVENTS_MAX_BYTES, "--max-bytes", 1);
  const runId = args.shift();
  if (!runId) throw invalidInput("trajectory events requires a run ID");
  assertNoArgs(args);
  const hasFilter = typesValue !== undefined || seqStartValue !== undefined || seqEndValue !== undefined || field !== undefined;
  const filter: TrajectoryEventsFilter | undefined = hasFilter ? {
    ...(typesValue === undefined ? {} : { types: typesValue.split(",") }),
    ...(seqStartValue === undefined ? {} : { seq_start: integerOption(seqStartValue, 0, "--seq-start") }),
    ...(seqEndValue === undefined ? {} : { seq_end: integerOption(seqEndValue, 0, "--seq-end") }),
    ...(field === undefined ? {} : { field }),
  } : undefined;
  if (canonicalSha256Value !== undefined && !/^sha256:[a-f0-9]{64}$/.test(canonicalSha256Value)) {
    throw invalidInput("--canonical-sha256 must be a sha256 digest");
  }
  const source = await requireSource(root, runId);
  const result = await pageTrajectoryEvents(source, {
    limit,
    maxBytes,
    ...(filter === undefined ? {} : { filter }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(canonicalSha256Value === undefined ? {} : { canonicalSha256: canonicalSha256Value as `sha256:${string}` }),
  });
  if (json) {
    process.stdout.write(serializeBoundedJson(result, maxBytes, "trajectory_events_page_overflow"));
    return;
  }
  process.stdout.write(`${runId}: ${result.events.length}/${result.total_matches} matching trajectory events${result.eof ? " (end)" : ""}\n`);
  for (const event of result.events) {
    const row = event as { seq?: number; type?: string };
    process.stdout.write(`  ${row.seq ?? "?"}  ${row.type ?? "unknown"}\n`);
  }
  if (result.next_cursor) process.stdout.write(`  next cursor: ${result.next_cursor}\n`);
}

async function requireSource(root: string, runId: string): Promise<CanonicalTrajectorySource> {
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw invalidInput("trajectory requires a valid run ID");
  const runDirectory = path.join(statePaths(root).runs, runId);
  const source = await loadCanonicalTrajectorySource(runDirectory, runId);
  if (!source) {
    throw new HitchError(`run ${runId} has no canonical trajectory`, { code: "trajectory_not_found", exitCode: 3 });
  }
  return source;
}

function integerOption(value: string | undefined, fallback: number, name: string, minimum = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw invalidInput(`${name} must be ${minimum === 0 ? "a non-negative" : "a positive"} safe integer`);
  }
  return parsed;
}
