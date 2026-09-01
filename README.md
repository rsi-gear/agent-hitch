# Hitch

[![npm version](https://img.shields.io/npm/v/agent-hitch.svg)](https://www.npmjs.com/package/agent-hitch)
[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/agent-hitch)](https://github.com/rsi-gear/agent-hitch/releases)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md)

**Reproducible runs for agent harnesses.**

Hitch runs Codex, Claude Code, Pi, OpenCode, and DeepSeek Harness from exact
versions or Git commits. Every run links the harness revision, immutable
artifact, workspace, trajectory, logs, and evaluation evidence.

```text
version or commit -> immutable artifact -> run or eval -> verifiable evidence
```

```bash
npm install --global agent-hitch

hitch run \
  --harness codex@version:0.92.0 \
  --prompt "Inspect this repository"
```

> **Status:** pre-alpha. The core run, provenance, trajectory, feedback,
> daemon, and Harbor evaluation paths are implemented.

## Why Hitch?

Git tells you which source changed. Hitch tells you exactly what ran and which
evidence it produced.

- **Reproduce** a run from an exact package version or source commit.
- **Compare** harnesses and models through one execution contract.
- **Audit** results with immutable artifacts, native events, canonical
  trajectories, logs, feedback, and eval records.

Hitch is useful for teams building agent evals, harness experiments, coding
agent infrastructure, and automated promotion pipelines.

## Quick start

Hitch requires Node.js 22 or newer.

```bash
npm install --global agent-hitch
hitch --version
```

Run an exact harness version in an isolated Git worktree:

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Inspect this repository" \
  --output jsonl
```

The output includes a run ID. Use it to inspect the saved trajectory:

```bash
hitch trajectory inspect RUN_ID
```

Every run is stored below `~/.hitch/runs/RUN_ID` with its manifest, result,
events, logs, and trajectory.

## Pin any harness revision

Harness selection is explicit for every run:

```bash
# Fingerprint and use the executable already installed on this machine.
hitch run --harness codex@installed --prompt "Inspect this repository"

# Resolve and run an exact published version.
hitch run --harness codex@version:0.92.0 --prompt "Inspect this repository"

# Build and run an exact commit from a registered upstream repository.
hitch run --harness codex@commit:0123456789abcdef --prompt "Inspect this repository"
```

| Harness | Installed | Exact package version | Source commit |
| --- | :---: | :---: | :---: |
| Codex | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | — |
| Pi | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | — |
| DeepSeek Harness | ✓ | ✓ | ✓ |

Exact versions and commits are prepared as validated, content-addressed
artifacts and reused from Hitch's local cache. Installed executables are useful
for local work; immutable references are better when portability matters.

## Evidence from every run

Hitch records the chain from request to result:

- requested reference and immutable resolved revision;
- validated, content-addressed runnable artifact;
- workspace, model identity, lifecycle, and terminal result;
- normalized control-plane events and raw process logs;
- redacted provider-native events where supported;
- DSH-compatible canonical trajectory with SHA-256-bound files; and
- versioned message feedback and evaluation evidence.

Use the CLI to query runs and attach feedback without rewriting the trajectory:

```bash
hitch runs list --json
hitch feedback list RUN_ID --json
hitch feedback put RUN_ID \
  --message MESSAGE_ID \
  --rating positive \
  --note "Kept the change focused"
```

Machine-contract schemas are versioned in [`docs/schemas`](docs/schemas).

## Reproducible agent evals

Hitch integrates with [Harbor](https://github.com/harbor-framework/harbor) to
evaluate an exact, portable harness revision in Docker:

```bash
hitch eval setup harbor
hitch eval doctor

hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --model openai/gpt-5.6
```

Each eval links the resolved harness revision, content-addressed Hitch
controller runtime, backend configuration, rewards, logs, and trajectory
evidence. See [Harbor-backed agent evals](docs/evals.md) for setup and
portability rules.

## Built for automation

- JSON and JSONL output with versioned schemas and typed errors
- Direct execution or a persistent daemon with bounded concurrency
- Shared, detached Git worktree, and independent-copy workspace modes
- Timeouts, cancellation, process-tree cleanup, and interrupted-run recovery
- Local state isolation through `--root <path>` or `HITCH_ROOT`

Start a queue when you need long-lived execution:

```bash
hitch daemon start \
  --max-concurrent 4 \
  --capacity-cpu-millis 4000 \
  --capacity-memory-mib 8192 \
  --container-slots 4 \
  --capacity-gpus 1 \
  --eval-gpus 1
hitch run --daemon --harness codex@version:0.92.0 --prompt-file task.md
```

## Documentation

- [Design and architecture](docs/design.md)
- [Harbor-backed evals](docs/evals.md)
- [Workspace isolation](docs/workspaces.md)
- [Daemon design](docs/daemon.md)
- [Hitch 0.2 development spec](docs/hitch-0.2-development-spec.md)
- [Release process](docs/releasing.md)

## Project status

Hitch is a pre-alpha local versioning and evidence layer. It complements Git;
it does not currently provide a remote artifact registry, branches, tags,
candidate promotion, or rollback policy.

Remote artifact synchronization, named candidates, promotion records, and more
harness adapters are planned.

## Community

Join the [Hitch community on Discord](https://discord.gg/cZ4NBbHDk) to ask
questions, share feedback, and discuss agent-harness infrastructure.

Hitch draws inspiration from [Multica](https://github.com/multica-ai/multica)
and uses [Harbor](https://github.com/harbor-framework/harbor) as its evaluation
backend.

## License

Licensed under the [Apache License 2.0](LICENSE).
