# Hitch user guide

Hitch evaluates models and agent harnesses: fix the harness to compare models, or fix the model to compare harness revisions. Its daemon coordinates parallel work within a shared resource budget and uses persisted execution records to recover supported evaluations after interruption.

Hitch accepts Harbor-compatible task definitions for existing benchmarks and custom tasks. Its [benchmark packages](../../benchmark-packages.md) define inputs, tools, lifecycle hooks, and grading; Hitch manages execution orchestration and result evidence. Harbor is the current execution backend.

## Quick Start

You need Node.js 22+, Git, model access, and a clean Git repository. Run these commands from that repository; `git status --short` must show no changes for `worktree` mode. The login command opens Codex's authentication flow.

Before 0.2.10 is published to npm, [install from source](model-inference.md#use-the-current-dev-build).

```bash
npm install --global agent-hitch@0.2.10
npx --yes @openai/codex@0.92.0 login
git status --short
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m \
  --output json
```

Replace `RUN_ID` with the returned `run_id`, then inspect the result:

```bash
hitch runs inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
```

Check the status and exit code as well as the answer. See [Quick Start](quickstart.md) for authentication details, workspace choices, and the next step: submitting two independent runs to the daemon.

## Parallel execution and recovery

One daemon coordinates runs and evaluations in the same state root. Multiple submissions share CPU, memory, and container capacity; known-task evaluations take turns at task boundaries. A disconnected caller can observe the same evaluation again by ID.

After a daemon crash, a supported local Docker evaluation can reattach to a verified live Harbor process or collect its completed result, then continue unstarted work. Ordinary Harness runs and ambiguous execution states have different recovery rules. Read [Daemon: parallelism and recovery](daemon.md) for a runnable configuration, a concurrency example, and the exact recovery boundaries.

## Start here

1. [Quick Start](quickstart.md): install Hitch, authenticate, run a task, then submit parallel work.
2. [Local and remote model inference](model-inference.md): connect a hosted API or local model server, including container access and the managed SGLang preview.
3. [Pin versions and isolate workspaces](versions-and-workspaces.md): choose the exact executable and the files it can work on.
4. [Read runs and evidence](runs-and-evidence.md): inspect results, trajectories, verifier output, and feedback.
5. [Run your first evaluation](evaluations.md): check Docker and Harbor, run one example task, and interpret its score.
6. [Daemon: parallelism and recovery](daemon.md): understand scheduling, shared capacity, durable submissions, and crash recovery.
7. [Operate and troubleshoot](operations.md): cancel tasks, inspect state, and diagnose failures.
8. [CLI reference](cli-reference.md): find all commands, options, query filters, and integration entry points.

## The four things Hitch connects

| Concept | What it means |
| --- | --- |
| Harness | The agent program, such as Codex, Claude Code, Pi, OpenCode, or DeepSeek Harness. It is distinct from the model the program calls. |
| Revision and artifact | The selected package version or Git commit, and the verified executable files prepared from it. |
| Run | One invocation with a prompt, workspace, model selection, lifecycle, and result. Its ID starts with `run_`. |
| Evaluation | A model and harness configuration evaluated against dataset tasks. Compatible no-tools tasks use the trusted `model-call` driver. Its ID starts with `eval_`; its trials reference ordinary Hitch runs. |

```text
Model + harness + tasks → versioned experiment → execution → results & evidence
```

Pinning a harness makes its executable identifiable. Repeating an experiment also requires preserving the prompt, workspace, dataset, model configuration, and environment. A remote model can still produce different answers.

## Before you begin

- Install Node.js 22 or later. Git is required for worktree isolation and source-based harnesses.
- Configure credentials for the harness and model provider you intend to use. Hitch does not provide model access.
- Local runs do not require Docker. Harbor evaluations require Python 3.12 or later and a working Docker daemon.
- Examples use a POSIX shell on macOS or Linux. On Windows, use equivalent PowerShell commands or a POSIX shell; consult [operations](operations.md) for the recovery limitation.

This guide describes Hitch 0.2.10, which is pre-alpha. Run `hitch --version` to check your installation. The versioned command and schema references in your checkout are authoritative when using a different release.

## Go deeper

The guide covers user workflows. For detailed contracts, read [workspace isolation](../../workspaces.md), [Harbor evaluations](../../evals.md), [verifier evidence](../../verifier-evidence.md), [benchmark packages](../../benchmark-packages.md), or the [architecture](../../design.md).
