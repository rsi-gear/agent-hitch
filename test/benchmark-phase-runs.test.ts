import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { validateRunContext } from "../src/domain/index.js";
import { ensureDir, readJSON } from "../src/foundation/index.js";
import {
  compareRuns, copySealedPhaseRunBundle, deriveTrainingDataCandidate, executeRun, inspectBenchmarkPhaseGroup, loadRunRecord, newRunId,
  projectRunRecord, queryRuns, readBenchmarkPhaseGroup, sealBenchmarkPhaseGroup, verifyResultBundleIndex,
} from "../src/runs/index.js";
import { forceRemove } from "../test-support/helpers.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const evalId = `eval_${"1".repeat(32)}`;
const groupId = `run_group_${"2".repeat(32)}`;
const context = {
  kind: "benchmark_phase" as const, benchmark_id: "synthetic-phases", benchmark_revision: digest,
  task_id: "two-conversations", task_digest: digest, verifier_identity: digest, run_group_id: groupId, phase_index: 1,
};

test("benchmark phase identity is distinct from a scored task and rejects invalid membership", () => {
  assert.deepEqual(validateRunContext(context), context);
  for (const changed of [{ phase_index: 0 }, { phase_index: 1.5 }, { phase_index: true }, { run_group_id: "../group" }, { benchmark_revision: "latest" }]) {
    assert.throws(() => validateRunContext({ ...context, ...changed }));
  }
  assert.throws(() => validateRunContext({ ...context, kind: "benchmark_task" }), /unknown field/);
});

test("fresh phase executions seal separately and form an immutable unscored evidence group", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hitch-phase-runs-"));
  t.after(() => forceRemove(directory));
  const project = await ensureDir(path.join(directory, "project"));
  const root = await ensureDir(path.join(directory, "state"));
  const executable = path.join(directory, "synthetic-codex");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 9.9.9\\n'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => prompt += c);
process.stdin.on('end', () => {
  const index = process.argv.indexOf('--synthetic-session');
  const session = index < 0 ? require('node:crypto').randomUUID() : process.argv[index + 1];
  const seenPrevious = fs.existsSync('candidate-memory.txt');
  fs.writeFileSync('candidate-memory.txt', prompt);
  process.stdout.write(JSON.stringify({type:'thread.started', thread_id:session}) + '\\n');
  process.stdout.write(JSON.stringify({type:'item.completed', item:{id:'answer', type:'agent_message', text:JSON.stringify({prompt, seenPrevious})}}) + '\\n');
  process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:1, output_tokens:1}}) + '\\n');
});
`, { mode: 0o755 });
  const previous = process.env.HITCH_CODEX_PATH;
  process.env.HITCH_CODEX_PATH = executable;
  t.after(() => { if (previous === undefined) delete process.env.HITCH_CODEX_PATH; else process.env.HITCH_CODEX_PATH = previous; });
  const parent = { kind: "eval", eval_id: evalId, trial_id: "synthetic-trial", attempt: 1 };
  async function phase(index: number, group = groupId, agentArgs: string[] = []) {
    const runId = newRunId();
    const result = await executeRun({ runId, root, runsRoot: path.join(root, "runs"), request: {
      agent: "codex", model: "synthetic-model", cwd: project, workspace_mode: "copy", prompt: `phase ${index}`,
      timeout_ms: 5000, agent_args: agentArgs, context: { ...context, run_group_id: group, phase_index: index }, parent,
    } });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(JSON.parse(String(result.output)), { prompt: `phase ${index}`, seenPrevious: false });
    const loaded = await loadRunRecord(path.join(root, "runs", runId));
    assert.equal(loaded.record.context.kind, "benchmark_phase");
    assert.equal(loaded.record.observation, undefined);
    assert.equal(loaded.record_status, "valid");
    assert.equal(loaded.trajectory_status, "valid");
    assert.deepEqual(loaded.issues, []);
    await verifyResultBundleIndex(path.join(root, "runs", runId));
    return runId;
  }
  const ids = [await phase(1), await phase(2)];
  const sourceDirectory = path.join(root, "runs", ids[0]!);
  const destinationDirectory = path.join(directory, "exported-phase");
  const expected = { run_id: ids[0]!, context, parent };
  const originalIndexBytes = await readFile(path.join(sourceDirectory, "bundle.index.json"));
  const exported = await copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory, expected });
  assert.deepEqual(exported, await verifyResultBundleIndex(sourceDirectory));
  assert.deepEqual(await readFile(path.join(destinationDirectory, "bundle.index.json")), originalIndexBytes);
  for (const file of exported.files) {
    assert.deepEqual(await readFile(path.join(destinationDirectory, file.path)), await readFile(path.join(sourceDirectory, file.path)));
  }
  assert.equal((await loadRunRecord(destinationDirectory)).record_status, "valid");
  await assert.rejects(copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory, expected }), /EEXIST/);
  await assert.rejects(copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory: path.join(directory, "wrong-phase"), expected: { ...expected, context: { ...context, phase_index: 2 } } }), /prepared identity/);
  await assert.rejects(copySealedPhaseRunBundle({ sourceDirectory, destinationDirectory: path.join(sourceDirectory, "nested"), expected }), /disjoint/);
  const group = await inspectBenchmarkPhaseGroup({ root, runIds: ids });
  assert.equal(group.scope, "candidate-evidence-only");
  assert.deepEqual(group.phases.map(p => p.phase_index), [1, 2]);
  assert.notEqual(group.phases[0]!.provider_session_id, group.phases[1]!.provider_session_id);
  assert.ok(!("observation" in group) && !("reward" in group));
  const reference = await sealBenchmarkPhaseGroup({ root, runIds: ids });
  assert.deepEqual(await sealBenchmarkPhaseGroup({ root, runIds: ids }), reference);
  assert.deepEqual((await readBenchmarkPhaseGroup({ root, evalId, reference })).phases, group.phases);
  await assert.rejects(sealBenchmarkPhaseGroup({ root, runIds: ids.slice(0, 1) }), /already sealed/);
  await assert.rejects(inspectBenchmarkPhaseGroup({ root, runIds: [ids[1]!, ids[0]!] }), /non-contiguous/);
  await assert.rejects(inspectBenchmarkPhaseGroup({ root, runIds: [ids[0]!, ids[0]!] }), /membership/);
  const queried = await queryRuns({ root, query: { context_kind: "benchmark_phase", benchmark_id: context.benchmark_id, eval_id: evalId } });
  assert.equal(queried.length, 2);
  const compared = await compareRuns({ root, dimension: "model", query: { benchmark_id: context.benchmark_id } });
  assert.equal(compared.groups.length, 0);
  assert.equal(compared.excluded.length, 2);
  await assert.rejects(deriveTrainingDataCandidate({ root, runId: ids[0]! }), /require a benchmark task run/);
  const manifest = await readJSON<Record<string, unknown>>(path.join(root, "runs", ids[0]!, "manifest.json"));
  assert.throws(() => projectRunRecord({ ...manifest, observation: { status: "valid", reward: 1, verifier_result_ref: "fake.json" } }), /standalone observation/);
  assert.throws(() => projectRunRecord({ ...manifest, parent: undefined }), /eval parent/);
  const reused = [await phase(1, `run_group_${"3".repeat(32)}`, ["--synthetic-session", "reused"]), await phase(2, `run_group_${"3".repeat(32)}`, ["--synthetic-session", "reused"])];
  await assert.rejects(inspectBenchmarkPhaseGroup({ root, runIds: reused }), /session identity is missing or reused/);
  const source = path.join(root, "runs", ids[1]!, "result.json");
  await writeFile(source, (await readFile(source, "utf8")) + " ");
  await assert.rejects(readBenchmarkPhaseGroup({ root, evalId, reference }), /integrity/);
});
