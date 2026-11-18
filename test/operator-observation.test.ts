import assert from "node:assert/strict";
import test from "node:test";
import { operatorDockerObservation } from "../src/resources/operator-observation.js";

const expected = { runId: "run_123", evalId: "eval_123", trialId: "Trial_123", planDigest: "sha256:" + "a".repeat(64) };
function proof() {
  return {
    protocol: "hitch-operator-docker-event-recovery@1", ...expected,
    rawEventsSha256: "b".repeat(64),
    events: ["candidate", "verifier"].flatMap((role, index) =>
      ["create", "start", "die", "destroy"].map((action, time) => ({
        action, time: 1000 + time, role, consumer: { role }, planDigest: expected.planDigest,
        name: "trial_123__" + role, containerId: String(index + 1).repeat(64),
        imageConfigDigest: "sha256:" + String(index + 3).repeat(64), service: role,
      }))),
  };
}

test("operator recovery returns only bound container observations, without invented usage", () => {
  const observed = operatorDockerObservation(proof(), expected);
  assert.equal(observed.length, 2);
  for (const [index, value] of observed.entries()) {
    assert.equal(value.role, index === 0 ? "candidate" : "verifier");
    assert.equal(value.first_observed_at, new Date(1000 * 1000).toISOString());
    assert.equal(value.last_observed_at, new Date(1003 * 1000).toISOString());
    assert.deepEqual(Object.keys(value).sort(), ["container_id", "name", "role", "service", "image_config_digest", "first_observed_at", "last_observed_at"].sort());
  }
});

test("operator recovery rejects cross-run identities and malformed evidence fingerprints", () => {
  for (const field of ["runId", "evalId", "trialId", "rawEventsSha256"] as const) {
    assert.throws(() => operatorDockerObservation({ ...proof(), [field]: "different" }, expected), /identity mismatch/);
  }
});

test("operator recovery requires both roles, matching plans, and complete ordered lifecycles", () => {
  const missing = proof(); missing.events = missing.events.filter(e => !(e.role === "candidate" && e.action === "destroy"));
  assert.throws(() => operatorDockerObservation(missing, expected), /complete container lifecycle/);
  const duplicate = proof(); duplicate.events.push({ ...duplicate.events.find(e => e.action === "start")! });
  assert.throws(() => operatorDockerObservation(duplicate, expected), /one candidate and one verifier/);
  const wrongPlan = proof(); wrongPlan.events.find(e => e.action === "start")!.planDigest = "wrong";
  assert.throws(() => operatorDockerObservation(wrongPlan, expected), /container binding mismatch/);
  const wrongImage = proof(); wrongImage.events.find(e => e.action === "destroy")!.imageConfigDigest = "sha256:" + "f".repeat(64);
  assert.throws(() => operatorDockerObservation(wrongImage, expected), /complete container lifecycle/);
  const reversed = proof(); reversed.events.find(e => e.action === "create")!.time = 2000;
  assert.throws(() => operatorDockerObservation(reversed, expected), /complete container lifecycle/);
});
