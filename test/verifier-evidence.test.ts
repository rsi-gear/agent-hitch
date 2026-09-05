import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunObservationV1 } from "../src/domain/index.js";
import { validateVerifierEvidence } from "../src/domain/index.js";
import { captureVerifierDiagnostics, persistTrialVerifierDiagnostics } from "../src/evals/index.js";
import { atomicWriteJSON, ensureDir, sha256Bytes } from "../src/foundation/index.js";
import { loadVerifierEvidence, writeResultBundleIndex } from "../src/runs/index.js";
import { forceRemove } from "../test-support/helpers.js";

const executable = fileURLToPath(new URL("../bin/hitch.js", import.meta.url));
const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const evalId = `eval_${"e".repeat(32)}`;
const trialId = "task-one__1";

test("verifier evidence returns reward zero, structured result, bounded diagnostics, and redactions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-evidence-"));
  t.after(() => forceRemove(root));
  const runId = `run_${"1".repeat(32)}`;
  const runDirectory = await writeRun(root, runId, {
    status: "valid",
    reward: 0,
    verifier_result_ref: "verifier/result.json",
  });
  const secret = "verifier-secret-value-123456";
  await atomicWriteJSON(path.join(runDirectory, "verifier", "result.json"), {
    rewards: { reward: 0 },
    token: secret,
    artifact_path: path.join(root, "harbor", "job", "result.json"),
    windows_path: "C:/Users/alice/work/result.json",
    windows_extended_path: "\\\\?\\C:\\Users\\alice\\work\\result.json",
    unc_path: "\\\\server\\share\\work\\result.json",
    special: JSON.parse('{"__proto__":{"marker":"kept"},"C:/Users/alice/work":"key-path"}'),
  });
  const trialDirectory = await ensureDir(path.join(root, "source-trial"));
  const verifierDirectory = await ensureDir(path.join(trialDirectory, "verifier"));
  await atomicWriteJSON(path.join(verifierDirectory, "ctrf.json"), {
    results: { summary: { tests: 1, failed: 1 }, tests: [{ name: "fails", status: "failed", path: path.join(root, "workspace", "test.ts") }] },
  });
  await writeFile(
    path.join(verifierDirectory, "test-stdout.txt"),
    `head\nAuthorization: Bearer abcdefghijklmnop\n${secret}\n${path.join(root, "workspace", "test.ts")}\nC:/Users/alice/work/test.ts\n\\\\server\\share\\test.ts\n${"x".repeat(2_000)}\ntail\n`,
  );
  await writeFile(path.join(verifierDirectory, "test-stderr.txt"), "assertion failed\n");
  const captured = await captureVerifierDiagnostics(trialDirectory, runDirectory, {
    maxArtifactBytes: 1024,
    credentialValues: [secret],
  });
  assert.ok(captured);
  assert.equal(captured.artifacts.length, 3);
  assert.equal(captured.artifacts.find((artifact) => artifact.name === "test-stdout.txt")?.truncated, true);
  assert.ok(captured.redactions.some((rule) => rule.rule_id === "known-credential-value-v1"));
  await writeEvalRecord(root, runId);
  await writeResultBundleIndex(runDirectory);

  const evidence = await loadVerifierEvidence(root, runId, { env: { TEST_VERIFIER_SECRET: secret } });
  assert.equal(evidence.verifier.status, "complete");
  assert.equal(evidence.observation?.reward, 0);
  assert.deepEqual(evidence.verifier.result, {
    rewards: { reward: 0 }, token: "[REDACTED]", artifact_path: "[path]",
    windows_path: "[path]", windows_extended_path: "[path]", unc_path: "[path]",
    special: JSON.parse('{"__proto__":{"marker":"kept"},"[path]":"key-path"}'),
  });
  assert.equal(Object.getPrototypeOf((evidence.verifier.result as { special: object }).special), Object.prototype);
  assert.match(evidence.verifier.result_sha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(evidence.verifier.diagnostics?.ctrf?.json, {
    results: { summary: { tests: 1, failed: 1 }, tests: [{ name: "fails", status: "failed", path: "[path]" }] },
  });
  assert.deepEqual(evidence.verifier.diagnostics?.stdout?.map((artifact) => artifact.name), ["test-stdout.txt"]);
  assert.deepEqual(evidence.verifier.diagnostics?.stderr?.map((artifact) => artifact.name), ["test-stderr.txt"]);
  const stdout = evidence.verifier.diagnostics?.stdout?.[0];
  assert.equal(stdout?.truncated, true);
  assert.match(stdout?.text ?? "", /head/);
  assert.match(stdout?.text ?? "", /tail/);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(evidence.redactions?.some((rule) => rule.rule_id === "known-credential-value-v1"));
  assert.ok(evidence.redactions?.some((rule) => rule.rule_id === "absolute-path-v1"));
  assert.equal(stdout?.sha256, sha256Bytes(Buffer.from(stdout?.text ?? "", "utf8")));
  assert.deepEqual(validateVerifierEvidence(evidence), evidence);
  assert.equal((await stat(path.join(runDirectory, "verifier", "test-stdout.txt"))).mode & 0o777, 0o600);
  const tighter = await loadVerifierEvidence(root, runId, { env: { TEST_VERIFIER_SECRET: secret }, maxArtifactBytes: 96 });
  assert.equal(tighter.verifier.status, "complete");
  const tighterText = tighter.verifier.diagnostics?.stdout?.[0]?.text ?? "";
  assert.ok(Buffer.byteLength(tighterText) <= 96, `${Buffer.byteLength(tighterText)} bytes: ${JSON.stringify(tighterText)}`);

  const cli = spawnSync(process.execPath, [executable, "--root", root, "verifier", "inspect", runId, "--json"], {
    encoding: "utf8",
    env: { ...process.env, TEST_VERIFIER_SECRET: secret },
  });
  assert.equal(cli.status, 0, cli.stderr || undefined);
  assert.deepEqual(validateVerifierEvidence(JSON.parse(cli.stdout)), evidence);
});

test("verifier evidence distinguishes result-only, missing, corrupt, and legacy diagnostics", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-status-"));
  t.after(() => forceRemove(root));

  const resultOnlyId = `run_${"2".repeat(32)}`;
  const resultOnly = await writeRun(root, resultOnlyId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  const retiredSecret = "retired-secret-no-longer-in-the-environment";
  await atomicWriteJSON(path.join(resultOnly, "verifier", "result.json"), {
    rewards: { reward: 1 },
    api_key: retiredSecret,
    nested: {
      password: retiredSecret,
      authorization: retiredSecret,
      entries: [{ clientSecret: retiredSecret }],
    },
  });
  await atomicWriteJSON(path.join(resultOnly, "verifier", "infrastructure-error.json"), { code: "transient", path: path.join(root, "harbor", "job") });
  const resultOnlyEvidence = await loadVerifierEvidence(root, resultOnlyId, { env: {} });
  assert.equal(resultOnlyEvidence.verifier.status, "result_only");
  assert.deepEqual(resultOnlyEvidence.verifier.result, {
    rewards: { reward: 1 },
    api_key: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      authorization: "[REDACTED]",
      entries: [{ clientSecret: "[REDACTED]" }],
    },
  });
  assert.doesNotMatch(JSON.stringify(resultOnlyEvidence), new RegExp(retiredSecret));
  assert.ok(resultOnlyEvidence.redactions?.some((entry) => entry.rule_id === "sensitive-field-v1" && entry.count === 4));
  assert.deepEqual(resultOnlyEvidence.verifier.diagnostics?.infrastructure_error, { code: "transient", path: "[path]" });
  assert.deepEqual(validateVerifierEvidence(resultOnlyEvidence), resultOnlyEvidence);

  const missingId = `run_${"3".repeat(32)}`;
  const missing = await writeRun(root, missingId, { status: "invalid", invalid_reason: "verifier_result_missing" });
  await atomicWriteJSON(path.join(missing, "verifier", "infrastructure-error.json"), {
    schema_version: "1", code: "verifier_infrastructure_failure", signals: ["network_unreachable"], source_files: [],
  });
  const missingEvidence = await loadVerifierEvidence(root, missingId);
  assert.equal(missingEvidence.verifier.status, "missing");
  assert.equal((missingEvidence.verifier.diagnostics?.infrastructure_error as { code?: string })?.code, "verifier_infrastructure_failure");

  const corruptId = `run_${"4".repeat(32)}`;
  const corrupt = await writeRun(root, corruptId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  const outside = path.join(root, "outside-result.json");
  await atomicWriteJSON(outside, { rewards: { reward: 1 } });
  await ensureDir(path.join(corrupt, "verifier"));
  await symlink(outside, path.join(corrupt, "verifier", "result.json"));
  const corruptEvidence = await loadVerifierEvidence(root, corruptId);
  assert.equal(corruptEvidence.verifier.status, "corrupt");
  assert.ok(corruptEvidence.verifier.issues?.some((issue) => issue.includes("verifier result is corrupt")));

  const legacyId = `run_${"5".repeat(32)}`;
  const legacy = await writeRun(root, legacyId, {
    status: "valid", reward: 0, verifier_result_ref: "verifier/result.json",
  });
  await atomicWriteJSON(path.join(legacy, "verifier", "result.json"), { rewards: { reward: 0 } });
  await atomicWriteJSON(path.join(legacy, "verifier", "ctrf.json"), { results: { tests: [] } });
  await writeFile(path.join(legacy, "verifier", "stdout.txt"), "legacy verifier output\n", { mode: 0o600 });
  const legacyEvidence = await loadVerifierEvidence(root, legacyId);
  assert.equal(legacyEvidence.verifier.status, "complete");
  assert.deepEqual(legacyEvidence.verifier.diagnostics?.ctrf?.json, { results: { tests: [] } });
  assert.equal(legacyEvidence.verifier.diagnostics?.stdout?.[0]?.text, "legacy verifier output\n");

  const largeLegacyId = `run_${"9".repeat(32)}`;
  const largeLegacy = await writeRun(root, largeLegacyId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  await atomicWriteJSON(path.join(largeLegacy, "verifier", "result.json"), { rewards: { reward: 1 } });
  await writeFile(path.join(largeLegacy, "verifier", "stdout.txt"), `head\n${"x".repeat(1024 * 1024)}\ntail\n`, { mode: 0o600 });
  const largeLegacyEvidence = await loadVerifierEvidence(root, largeLegacyId);
  assert.equal(largeLegacyEvidence.verifier.status, "complete");
  assert.equal(largeLegacyEvidence.verifier.diagnostics?.stdout?.[0]?.truncated, true);

  const oversizedLegacyId = `run_${"b".repeat(32)}`;
  const oversizedLegacy = await writeRun(root, oversizedLegacyId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  await atomicWriteJSON(path.join(oversizedLegacy, "verifier", "result.json"), { rewards: { reward: 1 } });
  await writeFile(path.join(oversizedLegacy, "verifier", "stdout.txt"), Buffer.alloc(16 * 1024 * 1024 + 1, 120), { mode: 0o600 });
  assert.equal((await loadVerifierEvidence(root, oversizedLegacyId)).verifier.status, "result_only");
});

test("structured verifier channels preserve total-only availability and validate process plus feedback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-scores-"));
  t.after(() => forceRemove(root));
  const runId = `run_${"c".repeat(32)}`;
  const runDirectory = await writeRun(root, runId, {
    status: "valid", reward: 0, verifier_result_ref: "verifier/result.json",
  });
  const result = { rewards: { reward: 0, total_score: 0, process_score: 0.5 } };
  await atomicWriteJSON(path.join(runDirectory, "verifier", "result.json"), result);
  const trialDirectory = await ensureDir(path.join(root, "score-trial"));
  const verifierDirectory = await ensureDir(path.join(trialDirectory, "verifier"));
  await atomicWriteJSON(path.join(verifierDirectory, "process.json"), {
    schema_version: "1",
    metric: "partial_credit",
    score: 0.5,
    detail_status: "components",
    passed: 1,
    total: 2,
    excluded: 1,
    components: [
      { id: "assertion-001", category: "email.sent", code: "email.sent", status: "passed", weight: 1 },
      { id: "assertion-002", category: "email.body", code: "email.body", status: "failed", weight: 1 },
      { id: "assertion-003", category: "email.optional", code: "email.optional", status: "excluded", weight: 1 },
    ],
  });
  await atomicWriteJSON(path.join(verifierDirectory, "feedback.json"), {
    schema_version: "1",
    items: [{ code: "email.body.missing", severity: "warning", message: "Required content was not found.", component_ids: ["assertion-002"] }],
  });
  const captured = await persistTrialVerifierDiagnostics({ trialDirectory, runDirectory, verifierResult: result });
  assert.deepEqual(captured.scores, { total_score: 0, process_score: 0.5, normalization: "standard" });
  assert.equal(captured.process?.components?.length, 3);
  assert.equal(captured.feedback?.items.length, 1);
  await writeEvalRecord(root, runId);
  await writeResultBundleIndex(runDirectory);
  const evidence = await loadVerifierEvidence(root, runId);
  assert.equal(evidence.verifier.status, "result_only");
  assert.deepEqual(evidence.verifier.scores, captured.scores);
  assert.equal(evidence.verifier.process?.score, 0.5);
  assert.equal(evidence.verifier.feedback?.items[0]?.component_ids?.[0], "assertion-002");
  assert.match(evidence.verifier.structured_artifacts?.process?.sha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(validateVerifierEvidence(evidence), evidence);

  const totalOnlyId = `run_${"d".repeat(32)}`;
  const totalOnly = await writeRun(root, totalOnlyId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  }, { eval_id: `eval_${"d".repeat(32)}`, trial_id: "terminal-bench__1", attempt: 1 });
  await atomicWriteJSON(path.join(totalOnly, "verifier", "result.json"), { rewards: { reward: 1 } });
  const totalOnlyEvidence = await loadVerifierEvidence(root, totalOnlyId);
  assert.deepEqual(totalOnlyEvidence.verifier.scores, { total_score: 1, normalization: "legacy-reward" });
  assert.equal(totalOnlyEvidence.verifier.process, undefined);
  assert.equal(totalOnlyEvidence.verifier.feedback, undefined);

  await atomicWriteJSON(path.join(verifierDirectory, "process.json"), {
    schema_version: "1", metric: "partial_credit", score: 1, detail_status: "aggregate-only",
  });
  await unlink(path.join(verifierDirectory, "feedback.json"));
  const invalid = await persistTrialVerifierDiagnostics({
    trialDirectory,
    runDirectory: await ensureDir(path.join(root, "invalid-score-run")),
    verifierResult: result,
  });
  assert.match(invalid.issue ?? "", /differs from process_score/);
});

test("structured verifier artifacts are redacted before persistence and stay safe after credentials expire", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-score-redaction-"));
  t.after(() => forceRemove(root));
  const runId = `run_${"e".repeat(32)}`;
  const runDirectory = await writeRun(root, runId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  const result = { rewards: { reward: 1, total_score: 1, process_score: 1 } };
  await atomicWriteJSON(path.join(runDirectory, "verifier", "result.json"), result);
  const trialDirectory = await ensureDir(path.join(root, "score-trial"));
  const secret = "fixture-opaque-credential-b14826c9";
  const retiredSecret = "retired-credential-not-in-current-environment";
  await atomicWriteJSON(path.join(trialDirectory, "verifier", "process.json"), {
    schema_version: "1", metric: "partial_credit", score: 1, detail_status: "components",
    passed: 1, total: 1, excluded: 0,
    components: [{
      id: "assertion-001", category: "validation", status: "passed", weight: 1,
      public_details: {
        observed: `Upstream echoed ${secret}`,
        nested: [{ api_key: retiredSecret }],
        [secret]: "credential in a JSON key",
        path: path.join(root, "private", "test.ts"),
      },
    }],
  });
  await atomicWriteJSON(path.join(trialDirectory, "verifier", "feedback.json"), {
    schema_version: "1",
    items: [{ code: "validation", severity: "warning", message: `Upstream echoed ${secret}`, component_ids: ["assertion-001"] }],
  });
  const captured = await persistTrialVerifierDiagnostics({
    trialDirectory, runDirectory, verifierResult: result,
    passEnv: ["TEST_VERIFIER_SECRET"], env: { TEST_VERIFIER_SECRET: secret },
  });
  assert.equal(captured.issue, undefined);
  assert.deepEqual(captured.process?.components?.[0]?.public_details, {
    observed: "Upstream echoed [REDACTED]",
    nested: [{ api_key: "[REDACTED]" }],
    "[REDACTED]": "[REDACTED]",
    path: "[path]",
  });
  assert.equal(captured.feedback?.items[0]?.message, "Upstream echoed [REDACTED]");
  for (const name of ["process", "feedback"] as const) {
    const bytes = await readFile(path.join(runDirectory, "verifier", `${name}.json`));
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes(retiredSecret), false);
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), captured[name]);
    assert.deepEqual(captured.structured_artifacts?.[name], {
      ref: `verifier/${name}.json`, bytes: bytes.length, sha256: sha256Bytes(bytes),
    });
  }
  await writeEvalRecord(root, runId);
  await writeResultBundleIndex(runDirectory);
  const evidence = await loadVerifierEvidence(root, runId, { env: {} });
  assert.deepEqual(evidence.verifier.process, captured.process);
  assert.deepEqual(evidence.verifier.feedback, captured.feedback);
  assert.deepEqual(evidence.verifier.structured_artifacts, captured.structured_artifacts);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.equal(JSON.stringify(evidence).includes(retiredSecret), false);
  assert.deepEqual(validateVerifierEvidence(evidence), evidence);
});

test("structured verifier redaction rejects invalid identifiers before writing either artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-score-sensitive-id-"));
  t.after(() => forceRemove(root));
  const secret = "fixture-opaque-credential-b14826c9";
  const result = { rewards: { reward: 1, total_score: 1, process_score: 1 } };
  for (const sensitiveField of ["process", "feedback"] as const) {
    const trialDirectory = await ensureDir(path.join(root, sensitiveField, "trial"));
    const runDirectory = await ensureDir(path.join(root, sensitiveField, "run"));
    await atomicWriteJSON(path.join(trialDirectory, "verifier", "process.json"), {
      schema_version: "1", metric: sensitiveField === "process" ? secret : "partial_credit",
      score: 1, detail_status: "aggregate-only",
    });
    await atomicWriteJSON(path.join(trialDirectory, "verifier", "feedback.json"), {
      schema_version: "1",
      items: [{ code: sensitiveField === "feedback" ? secret : "validation", severity: "warning", message: "Validation detail." }],
    });
    const captured = await persistTrialVerifierDiagnostics({
      trialDirectory, runDirectory, verifierResult: result,
      passEnv: ["TEST_VERIFIER_SECRET"], env: { TEST_VERIFIER_SECRET: secret },
    });
    assert.match(captured.issue ?? "", sensitiveField === "process" ? /process metric is invalid/ : /feedback item 0 code is invalid/);
    assert.equal(JSON.stringify(captured).includes(secret), false);
    assert.equal(captured.structured_artifacts, undefined);
    for (const name of ["process", "feedback"]) {
      await assert.rejects(stat(path.join(runDirectory, "verifier", `${name}.json`)), { code: "ENOENT" });
    }
  }
});

test("verifier evidence fails closed on eval identity mismatch and unsafe diagnostic sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-verifier-identity-"));
  t.after(() => forceRemove(root));
  const runId = `run_${"6".repeat(32)}`;
  const runDirectory = await writeRun(root, runId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  });
  await atomicWriteJSON(path.join(runDirectory, "verifier", "result.json"), { rewards: { reward: 1 } });
  await writeEvalRecord(root, `run_${"7".repeat(32)}`);
  const evidence = await loadVerifierEvidence(root, runId);
  assert.equal(evidence.verifier.status, "corrupt");
  assert.ok(evidence.verifier.issues?.includes("eval trial identity mismatch"));

  const traversalRunId = `run_${"a".repeat(32)}`;
  const traversalRun = await writeRun(root, traversalRunId, {
    status: "valid", reward: 1, verifier_result_ref: "verifier/result.json",
  }, { eval_id: "../../outside", trial_id: trialId, attempt: 1 });
  await atomicWriteJSON(path.join(traversalRun, "verifier", "result.json"), { rewards: { reward: 1 } });
  const traversalEvidence = await loadVerifierEvidence(root, traversalRunId);
  assert.equal(traversalEvidence.verifier.status, "corrupt");
  assert.equal(traversalEvidence.parent, undefined);
  assert.ok(traversalEvidence.verifier.issues?.includes("eval parent identity is invalid"));

  const trialDirectory = await ensureDir(path.join(root, "unsafe-trial"));
  const verifierDirectory = await ensureDir(path.join(trialDirectory, "verifier"));
  const outside = path.join(root, "outside-log.txt");
  await writeFile(outside, "do not import\n");
  await symlink(outside, path.join(verifierDirectory, "stdout.txt"));
  await assert.rejects(
    captureVerifierDiagnostics(trialDirectory, runDirectory),
    /unsafe verifier artifact/,
  );

  const symlinkParentTrial = await ensureDir(path.join(root, "symlink-parent-trial"));
  const realVerifier = await ensureDir(path.join(symlinkParentTrial, "real-verifier"));
  await writeFile(path.join(realVerifier, "stdout.txt"), "must not import\n");
  await symlink(realVerifier, path.join(symlinkParentTrial, "verifier"));
  await assert.rejects(captureVerifierDiagnostics(symlinkParentTrial, runDirectory), /unsafe verifier artifact/);
  await unlink(path.join(symlinkParentTrial, "verifier"));

  const controller = new AbortController();
  controller.abort(new Error("cancelled verifier capture"));
  await assert.rejects(
    captureVerifierDiagnostics(trialDirectory, runDirectory, { signal: controller.signal }),
    /cancelled verifier capture/,
  );

  const cancelledTrial = await ensureDir(path.join(root, "cancelled-trial", "verifier"));
  await atomicWriteJSON(path.join(cancelledTrial, "infrastructure-retry-history.json"), {
    schema_version: "1", code: "verifier_infrastructure_retry_history", candidate_rerun: false, attempts: [],
  });
  const cancelledRun = await ensureDir(path.join(root, "cancelled-run"));
  await assert.rejects(persistTrialVerifierDiagnostics({
    trialDirectory: path.dirname(cancelledTrial), runDirectory: cancelledRun, signal: controller.signal,
  }), /cancelled verifier capture/);
  await assert.rejects(stat(path.join(cancelledRun, "verifier", "infrastructure-retry-history.json")), { code: "ENOENT" });

  const permissionTrial = await ensureDir(path.join(root, "permission-trial", "verifier"));
  await writeFile(path.join(permissionTrial, "stdout.txt"), "safe output\n");
  await ensureDir(path.join(runDirectory, "verifier"));
  await writeFile(path.join(runDirectory, "verifier", "stdout.txt"), "old output\n", { mode: 0o644 });
  await captureVerifierDiagnostics(path.dirname(permissionTrial), runDirectory);
  assert.equal((await stat(path.join(runDirectory, "verifier", "stdout.txt"))).mode & 0o777, 0o600);
});

test("verifier evidence validator rejects path traversal and inconsistent status", () => {
  assert.throws(() => validateVerifierEvidence({
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: `run_${"8".repeat(32)}`,
    observation: { status: "valid", reward: 1, verifier_result_ref: "../secret.json" },
    verifier: { status: "result_only", result: {}, result_sha256: digestA },
  }), /normalized relative path/);
  assert.throws(() => validateVerifierEvidence({
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: `run_${"8".repeat(32)}`,
    verifier: { status: "complete", result: {}, result_sha256: digestA },
  }), /requires CTRF/);
  assert.throws(() => validateVerifierEvidence({
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: `run_${"8".repeat(32)}`,
    parent: { eval_id: "../../outside", trial_id: "trial", attempt: 1 },
    verifier: { status: "missing" },
  }), /parent eval_id is invalid/);
  assert.throws(() => validateVerifierEvidence({
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: `run_${"8".repeat(32)}`,
    verifier: {
      status: "complete",
      result: {},
      result_sha256: digestA,
      diagnostics: { infrastructure_error: { code: "transient" } },
    },
  }), /requires CTRF/);
  assert.throws(() => validateVerifierEvidence({
    schema_version: "1",
    kind: "verifier-evidence",
    run_id: `run_${"8".repeat(32)}`,
    verifier: {
      status: "result_only", result: {}, result_sha256: digestA,
      diagnostics: { stdout: [{ name: "stdout.txt", media_type: "text/plain", bytes: 0, sha256: digestA, truncated: false, text: "" }] },
    },
  }), /result_only verifier evidence must not include/);
});

async function writeRun(
  root: string,
  runId: string,
  observation: RunObservationV1,
  parent = { eval_id: evalId, trial_id: trialId, attempt: 1 },
): Promise<string> {
  const directory = await ensureDir(path.join(root, "runs", runId));
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(directory, "request.json"), { credential_names: ["TEST_VERIFIER_SECRET"] });
  await atomicWriteJSON(path.join(directory, "resolution.json"), {});
  await atomicWriteJSON(path.join(directory, "result.json"), { run_id: runId, status: "succeeded" });
  await atomicWriteJSON(path.join(directory, "manifest.json"), {
    schema_version: "1",
    run_id: runId,
    context: {
      kind: "benchmark_task",
      benchmark_id: "benchmark",
      benchmark_revision: "revision-1",
      task_id: "task-one",
      task_digest: digestA,
      verifier_identity: digestB,
    },
    parent: { kind: "eval", ...parent },
    status: "succeeded",
    harness: { harness_id: "codex", requested_ref: "codex@version:1.0.0", revision_identity: digestA },
    model: { requested_id: "model", effective_id: "model", identity_resolved: false },
    protocol: { timeout_ms: 1_000, workspace_mode: "shared" },
    observation,
    request_ref: "request.json",
    resolution_ref: "resolution.json",
    result_ref: "result.json",
    created_at: now,
    completed_at: now,
    sealed: true,
  });
  return directory;
}

async function writeEvalRecord(root: string, runId: string): Promise<void> {
  const directory = await ensureDir(path.join(root, "evals", evalId));
  await atomicWriteJSON(path.join(directory, "result.json"), {
    schema_version: "1",
    eval_id: evalId,
    trials: [{ trial_id: trialId, run_id: runId, task_id: "task-one", attempt: 1 }],
  });
}
