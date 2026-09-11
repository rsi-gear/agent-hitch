# Quick Start

Install Hitch, run Codex on a repository, inspect the evidence, then submit two independent tasks to the daemon. The examples ask the agent to inspect files without changing them. Steps 1–5 need no Docker; the parallel example declares a small host resource budget explicitly.

## 1. Install Hitch

Before 0.2.10 is published to npm, [install from source](model-inference.md#use-the-current-dev-build).

```bash
node --version
npm install --global agent-hitch@0.2.10
hitch --version
hitch list
```

Node must be version 22 or later. `hitch list` discovers supported harnesses and reports local availability; an exact package reference can be prepared even when the harness is not globally installed.

## 2. Authenticate the harness

Hitch starts the selected harness non-interactively, so complete its authentication before the run. For the pinned Codex example:

```bash
npx --yes @openai/codex@0.92.0 login
```

Follow Codex's sign-in flow. For API-key authentication and headless environments, see the [Codex authentication documentation](https://developers.openai.com/codex/auth). Authentication and model availability depend on your provider account. The harness version here is an explicit example, not a claim that it is the newest release.

If you already use another supported harness, inspect its requirements with `hitch inspect pi --json` (replace `pi` with its ID), configure that harness, and choose its reference instead.

## 3. Choose a clean repository

Change into the Git repository you want the agent to inspect, then check its state:

```bash
git status --short
```

For `worktree` mode, this must produce no output: staged, unstaged, and untracked files all count. Commit or otherwise preserve your changes first. If you want to include current uncommitted files, use `--workspace-mode copy`; see [workspace modes](versions-and-workspaces.md).

## 4. Run the task

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Summarize this repository and its test commands. Do not modify files." \
  --timeout 5m \
  --output json
```

The first run resolves and prepares the package, which may require network access. Later runs reuse verified cached artifacts. `--output json` prints the final result; use `--output jsonl` when you want lifecycle events as they happen.

The example uses the harness's configured default model. Add `--model MODEL_ID` to select one explicitly; replace `MODEL_ID` with an ID accepted by that harness and available to your account. Hitch forwards the selection to the harness, so provider prefixes are not interchangeable across adapters. For hosted APIs, Ollama, or a custom inference server, follow [local and remote model inference](model-inference.md).

## 5. Confirm the result

Copy the `run_id` from the output. In the following commands, replace `RUN_ID` with that complete value, including its `run_` prefix:

```bash
hitch runs inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
hitch workspace path RUN_ID
```

A completed command is not sufficient evidence that the task succeeded. Check the run's status, exit code, final output, and any error. The trajectory view shows the available conversation and tool evidence; if the harness failed before capture started, a trajectory may be absent.

Hitch keeps run records below `~/.hitch/runs/RUN_ID/` and retains managed workspaces after completion. It never merges agent changes back into your source repository automatically.

## 6. Submit two runs in parallel

Start one daemon from the authenticated shell. This example assigns Hitch a budget of 2 CPUs and 2 GiB; adjust it to the capacity available on your host. If a daemon is already running for this root, inspect its status and use it rather than starting a second instance.

```bash
hitch daemon start \
  --max-concurrent 2 \
  --capacity-cpu-millis 2000 \
  --capacity-memory-mib 2048 \
  --container-slots 2
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Summarize the architecture without changing files." \
  --timeout 5m
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Find the test commands without changing files." \
  --timeout 5m
hitch daemon status --json
hitch runs list --json
```

Each submit returns a different Run ID without waiting for execution to finish, so no shell `&` is needed. Each run gets its own worktree. Two runs can overlap when both remain active and the resource budget fits; a fast run may finish before you inspect the queue. Use each ID with `hitch runs inspect` and `hitch trajectory project` as above. Two configured container slots do not start Docker; these ordinary runs execute on the host.

The daemon continues accepted work when the submitting CLI exits. A daemon crash is a different event: unfinished ordinary runs are marked `daemon_restarted`, while supported evaluations have lease-based recovery. See [Daemon: parallelism and recovery](daemon.md) before relying on unattended recovery.

Next, [run a small Docker evaluation](evaluations.md). If the daemon above is still running, follow that tutorial with `hitch eval run --daemon` so the evaluation uses the same resource budget. For failures, use [the troubleshooting table](operations.md).
