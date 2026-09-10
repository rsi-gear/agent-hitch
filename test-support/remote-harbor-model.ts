import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJSON } from "../src/foundation/index.js";
import { benchmarkTaskDigest, benchmarkVerifierIdentity } from "../src/runs/index.js";
import { TrajectoryProjector, TrajectoryWriter, canonicalTrajectoryFileRef, trajectoryRefV2 } from "../src/trajectories/index.js";

export async function writeResourceInspector(root: string): Promise<string> {
  const executable = path.join(root, "fake-resource-inspector");
  const declaration = {
    schema_version: "1", task: {}, verifier: { separate: false }, compose_services: [{ name: "main", replicas: 1 }],
    provider_sidecars: { main_egress: false, verifier_egress: false },
    environment_images: [], environment_image_fallbacks: [], environment_builds: [],
  };
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(declaration))});\n`, { mode: 0o755 });
  return executable;
}

export async function writeEmptyDocker(root: string): Promise<string> {
  const executable = path.join(root, "fake-empty-docker");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "info") process.stdout.write(JSON.stringify({ID: "fixture-docker-engine"}));
if (args[0] === "version") process.stdout.write("27.4.0\\n");
if (["container", "network", "volume"].includes(args[0]) && args[1] === "ls") process.stdout.write("");
process.exit(0);
`, { mode: 0o755 });
  return executable;
}

export async function writeCaptureHarbor(root: string, invalidFirst = false, captureSource = false,
  interruption?: { reached: string; resume: string }): Promise<string> {
  const executable = path.join(root, "fake-capture-harbor");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("harbor 0.21.0\\n"); process.exit(0); }
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
const counter = ${JSON.stringify(path.join(root, "capture-harbor-count"))};
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
fs.writeFileSync(counter, String(count));
(async () => {
  const capture = config.agents[0].kwargs.model_capture;
  if (!capture || capture.topology !== "in-sandbox" || capture.required !== true) process.exit(3);
  if ((capture.training_external || capture.managed_inference) && process.env.OPENAI_API_KEY) process.exit(8);
  const evalId = config.agents[0].kwargs.eval_id;
  const bundle = path.join(${JSON.stringify(path.join(root, "capture-bundles"))}, evalId);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  const runId = manifest.run_id;
  const local = (value) => value.replace("host.docker.internal", "127.0.0.1").replace("{run_id}", runId);
  const health = await fetch(local(capture.health_url_template));
  if (!health.ok) process.exit(4);
  if (capture.training_external) {
    const output = require("node:child_process").execFileSync(process.execPath, [${JSON.stringify(path.resolve("integrations/training-tool/cli.js"))}, "--model", "training/" + capture.training_external.binding_id], {
      input: "Run two tools, then finish.", encoding: "utf8", env: {...process.env, HITCH_HARBOR_INTERNAL: "1", HITCH_TRAINING_EXTERNAL: "1",
        HITCH_TRAINING_RUN_ID: runId, HITCH_TRAINING_BINDING: JSON.stringify(capture.training_external), OPENAI_API_KEY: "hitch-training-external",
        OPENAI_BASE_URL: local(capture.base_url_template).replace("{provider}", "openai")},
    });
    const events = output.trim().split("\\n").map(line => JSON.parse(line));
    if (events.filter(e => e.type === "tool.started").length !== 2 || events.filter(e => e.type === "provider.response").some(e => !e.receipt_id)) process.exit(7);
  } else {
  const response = await fetch(local(capture.base_url_template).replace("{provider}", "openai") + "/responses", {
    method: "POST", headers: {authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({model:"remote-requested",input:"credential=" + process.env.OPENAI_API_KEY}),
  });
  if (!response.ok) process.exit(5);
  await response.text();
  const interruption = ${JSON.stringify(interruption ?? null)};
  if (interruption) {
    fs.writeFileSync(interruption.reached, JSON.stringify({runId, pid: process.pid}));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(interruption.resume)) {
      if (Date.now() >= deadline) throw new Error("controller interruption did not resume");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const continued = await fetch(local(capture.base_url_template).replace("{provider}", "openai") + "/responses", {
      method: "POST", headers: {authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json"},
      body: JSON.stringify({model:"remote-requested",input:"Continue the original candidate."}),
    });
    if (!continued.ok) throw new Error("resumed model returned HTTP " + continued.status + ": " + await continued.text());
    await continued.text();
  }
  }
  const output = path.join(config.jobs_dir, config.job_name);
  const trialId = "one__random-" + count;
  const trialDirectory = path.join(output, trialId);
  fs.mkdirSync(path.join(trialDirectory, "agent"), {recursive:true});
  fs.writeFileSync(path.join(trialDirectory, "lock.json"), JSON.stringify({task:{name:"one"}}));
  fs.cpSync(bundle, path.join(trialDirectory, "agent", "hitch-run-bundle"), {recursive:true});
  if (${captureSource}) {
    fs.mkdirSync(path.join(trialDirectory, "artifacts"));
    fs.writeFileSync(path.join(trialDirectory, "artifacts", "patch.diff"), "original candidate patch\\n");
    fs.writeFileSync(path.join(trialDirectory, "benchmark-lifecycle.json"), JSON.stringify({schema_version:"1", failure:null, phases:{snapshot:{original:true}}}));
    fs.writeFileSync(path.join(trialDirectory, "config.json"), JSON.stringify({task:{path:path.join(config.datasets[0].path,"one")},agent:config.agents[0],environment:config.environment,verifier:config.verifier}));
  }
  fs.writeFileSync(path.join(trialDirectory, "result.json"), JSON.stringify({task_name:"one",trial_name:trialId,
    ...(${captureSource} ? {id:"original-trial-uuid",config:{task:{path:path.join(config.datasets[0].path,"one")},agent:config.agents[0],environment:config.environment,verifier:config.verifier},agent_result:{metadata:{hitch_run_id:runId,controller_runtime_id:config.agents[0].kwargs.controller_runtime_id}}} : {}),
    ...(${invalidFirst} && count === 1 ? {} : {verifier_result:{rewards:{reward:1}}})}));
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({n_total_trials:1,stats:{n_completed_trials:1,n_errored_trials:0,n_cancelled_trials:0}}));
  process.stdout.write("Results written\\n");
})().catch((error) => { process.stderr.write(String(error)); process.exit(6); });
`;
  await writeFile(executable, source, { mode: 0o755 });
  return executable;
}

export async function writeExportedBundle(options: {
  bundle: string; runId: string; evalId: string; trialId: string; taskId: string; benchmarkId: string; benchmarkRevision: string;
  managed?: { inference_id: string; model_id: string; model_node: import("../src/domain/index.js").ModelNodeBindingV2 };
  training?: import("../src/domain/index.js").TrainingProxyIdentityV1;
  harnessRef?: string;
}): Promise<void> {
  await mkdir(options.bundle, { recursive: true });
  const projector = new TrajectoryProjector({ runId: options.runId, cwd: "/app", prompt: "complete", model: "openai/remote", fidelity: "normalized" });
  projector.feed({ type: "message.completed", text: "done" });
  const projected = projector.finalize("succeeded");
  const writer = await TrajectoryWriter.open({ runDirectory: options.bundle, cwd: "/app", sessionId: projected.header.id, fidelity: "normalized", header: projected.header });
  for (const event of projected.events) writer.append(event);
  const trajectory = await writer.close();
  await atomicWriteJSON(path.join(options.bundle, "trajectory.ref.json"), trajectoryRefV2({
    runId: options.runId, fidelity: "normalized", files: [await canonicalTrajectoryFileRef(options.bundle, trajectory)],
  }));
  await atomicWriteJSON(path.join(options.bundle, "request.json"), { cwd: "/app" });
  await atomicWriteJSON(path.join(options.bundle, "resolution.json"), { schema_version: "1" });
  await atomicWriteJSON(path.join(options.bundle, "result.json"), { schema_version: "1", run_id: options.runId, status: "succeeded", exit_code: 0 });
  await writeFile(path.join(options.bundle, "events.jsonl"), `${JSON.stringify(options.training
    ? { type: "provider.event", provider_type: "training.terminated", native: { termination: "terminated" } }
    : { type: "run.completed" })}\n`);
  const now = new Date().toISOString();
  await atomicWriteJSON(path.join(options.bundle, "manifest.json"), {
    schema_version: "1", run_id: options.runId,
    context: {
      kind: "benchmark_task", benchmark_id: options.benchmarkId, benchmark_revision: options.benchmarkRevision, task_id: options.taskId,
      task_digest: benchmarkTaskDigest(options.benchmarkId, options.benchmarkRevision, options.taskId),
      verifier_identity: benchmarkVerifierIdentity(options.benchmarkId, options.benchmarkRevision),
    },
    parent: { kind: "eval", eval_id: options.evalId, trial_id: options.trialId, attempt: 1 },
    status: "succeeded", harness: { harness_id: options.training ? "training-tool" : "codex", requested_ref: options.harnessRef ?? "codex@version:1.2.3", revision_identity: `sha256:${"a".repeat(64)}` },
    ...(options.training ? { training_external: options.training } : {}),
    model: options.managed ? { provider: "local", requested_id: "local/test", effective_id: options.managed.model_id,
      inference_id: options.managed.inference_id, model_node: options.managed.model_node, identity_resolved: true }
      : { provider: "openai", requested_id: options.training ? `training/${options.training.binding_id}` : "openai/remote", effective_id: "openai/remote", identity_resolved: false },
    protocol: { timeout_ms: 0, workspace_mode: "shared" }, request_ref: "request.json", resolution_ref: "resolution.json",
    result_ref: "result.json", trajectory_ref: "trajectory.ref.json", created_at: now, completed_at: now, sealed: false,
  });
  await atomicWriteJSON(path.join(options.bundle, "bundle.complete.json"), {
    schema_version: "1", run_id: options.runId, eval_id: options.evalId, trial_id: options.trialId, completed_at: now,
  });
}
