import { EvalScheduler, ResourceLedger } from "../src/control-plane/index.js";
import { runEval } from "../src/evals/index.js";

const [root, harborExecutable, npmExecutable, dataset, harnessRef = "pi@version:1.2.3", captureMode] = process.argv.slice(2);
if (!root || !harborExecutable || !npmExecutable || !dataset) throw new Error("recovery scheduler fixture arguments are missing");

const trial = { cpu_millis: 1_000, memory_bytes: 1024 * 1024 * 1024, container_slots: 1, build_slots: 0 };
const scheduler = new EvalScheduler({
  root,
  resources: new ResourceLedger({ ...trial, build_slots: 1 }),
  trialResources: trial,
  executor: (options) => runEval({
    ...options,
    harborExecutable,
    env: { ...process.env, HITCH_NPM_PATH: npmExecutable },
    trialBundleGraceMs: 0,
  }),
});
await scheduler.initialize();
const request = {
  dataset,
  harness_ref: harnessRef,
  attempts: 1,
  max_concurrent: 1,
  infrastructure_retries: 0,
};
const evalId = await scheduler.submit(captureMode === "proxy" ? {
  request,
  execution: {
    provider: "local-docker",
    max_parallelism: 1,
    resources: { default_trial: trial },
    build: { mode: "backend" },
    model_capture: { mode: "proxy", required: true },
  },
} : request);
process.stdout.write(`${JSON.stringify({ eval_id: evalId })}\n`);
setInterval(() => {}, 10_000);
