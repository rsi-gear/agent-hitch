import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runtime = path.join(process.cwd(), "benchmark-packages", "automationbench", "runtime");
const assertions = [
  { type: "hubspot_ticket_exists", passed: true, excluded: false, params: { title: "hidden expected value" } },
  { type: "gmail_message_sent_to", passed: true, excluded: false, params: { to: "hidden@example.test" } },
  { type: "gmail_message_is_read", passed: false, excluded: false, params: { id: "hidden" } },
  { type: "optional_check", passed: false, excluded: true, params: { value: "hidden" } },
];

test("AutomationBench assertions map deterministically to sanitized process components", () => {
  const result = run(2 / 3);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(evidence, {
    schema_version: "1",
    metric: "partial_credit",
    score: 2 / 3,
    detail_status: "components",
    passed: 2,
    total: 3,
    excluded: 1,
    components: [
      { id: "assertion-0001", category: "hubspot_ticket_exists", code: "hubspot_ticket_exists", status: "passed", weight: 1 },
      { id: "assertion-0002", category: "gmail_message_sent_to", code: "gmail_message_sent_to", status: "passed", weight: 1 },
      { id: "assertion-0003", category: "gmail_message_is_read", code: "gmail_message_is_read", status: "failed", weight: 1 },
      { id: "assertion-0004", category: "optional_check", code: "optional_check", status: "excluded", weight: 1 },
    ],
  });
  assert.doesNotMatch(result.stdout, /hidden/);

  const inconsistent = run(0.5);
  assert.notEqual(inconsistent.status, 0);
  assert.match(inconsistent.stderr, /partial_credit differs from assertion aggregation/);
});

function run(score: number): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("python3", ["-c", [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from score_contract import process_evidence",
    "print(json.dumps(process_evidence(json.loads(sys.argv[2]), float(sys.argv[3]))))",
  ].join(";"), runtime, JSON.stringify(assertions), String(score)], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}
