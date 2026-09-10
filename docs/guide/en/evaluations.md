# Run your first evaluation

An evaluation measures a model and harness configuration on a set of tasks and publishes the resulting Hitch runs, scores, and evidence. Hitch accepts Harbor-compatible task definitions, including custom benchmark packages with their own tools, lifecycle hooks, and grading rules. Harbor is the current execution backend.

## Choose what to evaluate

- [x] **Compare models:** keep the harness, tasks, and evaluation settings fixed; change `--model`.
- [x] **Compare harnesses:** keep the model and tasks fixed; change `--harness` or its revision.
- [x] **Evaluate without tools:** use the trusted `model-call` driver for compatible no-tools tasks. This path makes a model request without an agent tool loop; see [benchmark packages](../../benchmark-packages.md) for requirements in current `dev`.

Keep task inputs and budgets consistent, and record model settings alongside the harness version. Begin with the one-task Docker example below before selecting a full benchmark.

## Check the environment

You need Python 3.12 or later, Docker with a running daemon, network access for package/image downloads, and model credentials usable inside a container.

```bash
hitch eval setup harbor
hitch eval doctor
```

Setup installs Hitch's pinned Harbor into an isolated environment under `~/.hitch/tools/`. It neither installs nor starts Docker. Doctor is read-only; fix its Python, Harbor, and Docker errors before continuing. If Python discovery chooses an older version, pass `--python /absolute/path/to/python3.12` to setup and doctor.

Local interactive login does not automatically make credentials available to Docker. For this Codex example, supply your OpenAI API key through the `CODEX_API_KEY` environment variable using your usual secret manager or shell setup. The command explicitly forwards its name with `--pass-env CODEX_API_KEY`. Codex's non-interactive process reads that variable; merely configuring `OPENAI_API_KEY` for another tool does not replace this step. See [Codex automation authentication](https://developers.openai.com/codex/noninteractive). Put values in the environment, not in a prompt or a checked-in file.

If you started a daemon in [Quick Start](quickstart.md), use `hitch eval run --daemon` in the example below. Direct evaluations are rejected while a daemon owns the same root. The daemon must have `CODEX_API_KEY` in its own environment: if it was started before you configured the key, finish or cancel its active work, then stop it and restart from the configured shell with the same resource settings. See [daemon setup](daemon.md#start-one-coordinator).

For managed models, follow the [local SGLang evaluation](model-inference.md#run-managed-sglang-locally) or [remote model node](model-inference.md#use-a-managed-remote-model-node) instructions. For external services, see [container access](model-inference.md#reach-the-model-from-a-docker-evaluation).

## Run one example task

From an agent-hitch source checkout containing this guide, use `docs/guide/examples` as the dataset. Its single `hello-hitch` task asks the agent to write a small text file, and a shell verifier checks its exact content. No external benchmark data is required.

```bash
git clone https://github.com/rsi-gear/agent-hitch.git
cd agent-hitch
hitch eval run \
  --backend harbor \
  --dataset docs/guide/examples \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 \
  --max-concurrent 1 \
  --timeout 5m \
  --setup-timeout 15m \
  --output json
```

If you already have this source checkout, start with the `hitch eval run` command from its root. As with local runs, add `--model MODEL_ID` if you need an explicit model accepted by your selected harness. `@installed` is rejected for evaluations because it cannot identify a portable container artifact.

The extra Codex argument allows this trusted example to write its answer without interactive approval or a nested sandbox. It applies to the harness inside Harbor's task container. Do not copy that argument into an ordinary host-side run.

The example is an installation check, not a quality benchmark. Its Ubuntu base uses a version tag; pin the image digest as well before using a task as part of a reproducibility claim. Setup can take substantially longer than the agent's task on a cold cache.

## Interpret the result

Copy the returned `eval_id`, then replace `EVAL_ID` below:

```bash
hitch eval list --json
hitch eval inspect EVAL_ID --json
```

Check the final status, `summary`, valid/invalid observations, and each trial's `run_id`. Inspect one trial using its run ID:

```bash
hitch runs inspect RUN_ID --json
hitch verifier inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
```

For the example task, valid reward `1` means the expected file was produced; valid reward `0` means it was not. An invalid trial indicates an execution or evidence problem. Hitch's `summary` excludes invalid observations; `backend_summary` retains Harbor's aggregate for diagnosis.

Records live under `~/.hitch/evals/EVAL_ID/`. During execution, `progress.json` describes published trials. The terminal `result.json` becomes authoritative when the evaluation finishes. Per-trial evidence is published under the ordinary `runs/` directory.

## Repair an invalid trial

After fixing the cause, explicitly rerun invalid or missing slots:

```bash
hitch eval rerun EVAL_ID --invalid
```

The default `candidate-restart` reruns the agent and can make new model calls. It is not a replay of the original answer. Valid zero-reward trials are not invalid slots to repair. Automatic verifier infrastructure retries are separate: they retry the verifier in the existing trial without silently rerunning the candidate. After an interruption, first check the [daemon recovery flow](daemon.md#return-to-an-interrupted-evaluation): it may be able to finish collecting the original execution without a new candidate run.

## Move to a benchmark

Replace `--dataset` with a local Harbor dataset or an immutable registry reference such as `terminal-bench@2.0`. This selects the dataset, not just one task: `--max-concurrent 1` limits parallelism, not total task count. Use an explicitly prepared small subset when checking a larger benchmark.

For packaged and sampled benchmarks, see [benchmark packages](../../benchmark-packages.md) and the [native Harbor producer](../../../benchmark-packages/harbor-source/README.md). Use [Daemon: parallelism and recovery](daemon.md) when multiple evaluations share a Docker host. The [Harbor reference](../../evals.md) covers transport, resource policies, and recovery.
