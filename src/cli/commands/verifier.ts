import { invalidInput } from "../../foundation/index.js";
import { repairVerifierDiagnostics } from "../../evals/index.js";
import { loadVerifierDiagnosticPage, loadVerifierEvidence, MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES } from "../../runs/index.js";
import type { Sha256, VerifierArtifactExcerptV1 } from "../../domain/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

const ARTIFACT_NAMES = new Set(["ctrf.json", "test-stdout.txt", "test-stderr.txt", "stdout.txt", "stderr.txt"]);

export async function verifierCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "artifact") return verifierArtifactCommand(args, root);
  if (action === "repair") return verifierRepairCommand(args, root);
  if (action !== "inspect") throw invalidInput("verifier requires inspect, artifact, or repair");
  const json = takeFlag(args, "--json");
  const runId = args.shift();
  if (!runId || !/^run_[a-f0-9]{32}$/.test(runId)) {
    throw invalidInput("verifier inspect requires a valid run ID");
  }
  assertNoArgs(args);
  const evidence = await loadVerifierEvidence(root, runId);
  if (json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${runId}: verifier ${evidence.verifier.status}\n`);
  if (evidence.observation) {
    const reward = evidence.observation.reward === undefined ? "" : `, reward ${evidence.observation.reward}`;
    process.stdout.write(`  observation: ${evidence.observation.status}${reward}\n`);
  }
  const diagnostics = evidence.verifier.diagnostics;
  if (diagnostics) {
    const artifacts = [
      ...(diagnostics.ctrf ? [diagnostics.ctrf] : []),
      ...(diagnostics.stdout ?? []),
      ...(diagnostics.stderr ?? []),
    ];
    process.stdout.write(`  diagnostics: ${artifacts.map((artifact) => artifact.name).join(", ") || "structured only"}\n`);
  }
  for (const issue of evidence.verifier.issues ?? []) process.stdout.write(`  issue: ${issue}\n`);
}

async function verifierRepairCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const source = takeOption(args, "--source");
  const runId = args.shift();
  if (!runId || !/^run_[a-f0-9]{32}$/.test(runId)) {
    throw invalidInput("verifier repair requires a valid run ID");
  }
  assertNoArgs(args);
  const result = await repairVerifierDiagnostics({ root, runId, ...(source === undefined ? {} : { source }) });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${runId}: verifier diagnostics ${result.status.replace("_", " ")}\n`);
}

async function verifierArtifactCommand(args: string[], root: string): Promise<void> {
  const json = takeFlag(args, "--json");
  const offsetValue = takeOption(args, "--offset");
  const limitValue = takeOption(args, "--limit");
  const expectedSha256 = takeOption(args, "--sha256");
  const runId = args.shift();
  const name = args.shift();
  if (!runId || !/^run_[a-f0-9]{32}$/.test(runId) || !name || !ARTIFACT_NAMES.has(name)) {
    throw invalidInput("verifier artifact requires a valid run ID and artifact name");
  }
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  const maxBytes = limitValue === undefined ? MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES : Number(limitValue);
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidInput("--offset must be a non-negative integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES) {
    throw invalidInput(`--limit must be an integer from 4 to ${MAX_VERIFIER_DIAGNOSTIC_PAGE_BYTES}`);
  }
  if (expectedSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/.test(expectedSha256)) {
    throw invalidInput("--sha256 must be a SHA-256 digest");
  }
  assertNoArgs(args);
  const page = await loadVerifierDiagnosticPage(root, runId, name as VerifierArtifactExcerptV1["name"], {
    offset,
    maxBytes,
    ...(expectedSha256 ? { expectedSha256: expectedSha256 as Sha256 } : {}),
  });
  if (json) process.stdout.write(`${JSON.stringify(page, null, 2)}\n`);
  else process.stdout.write(page.page.text);
}
