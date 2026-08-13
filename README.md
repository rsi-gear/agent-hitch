# Hitch

[![npm version](https://img.shields.io/npm/v/agent-hitch.svg)](https://www.npmjs.com/package/agent-hitch)
[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/agent-hitch)](https://github.com/rsi-gear/agent-hitch/releases)
[![Discord](https://img.shields.io/badge/Discord-Join_chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

**Let agents choose their harness with one runtime.**

Hitch lets an agent choose which harness and revision to use for each run. It is
an agent-first CLI and daemon for discovering and running native coding agents
through one stable, machine-oriented interface.

Hitch is designed as infrastructure for Recursive Self-Improvement (RSI),
including harness evolution and model evolution.

> Status: pre-alpha. Installed-harness discovery, immutable revision resolution,
> prepared artifact caching, direct runs, the local daemon, and Harbor-backed
> agent evals are implemented.

## News

- **2026-08-13:** Hitch now supports DeepSeek Harness.

## Available now

Hitch currently supports Codex CLI, Claude Code, Pi, OpenCode, and DeepSeek
Harness adapters. It provides:

- executable discovery, version probing, and executable fingerprints;
- exact package-version and Git-commit resolution;
- immutable prepared artifacts with integrity-aware caching;
- direct execution with normalized JSONL events;
- a persistent local daemon with bounded concurrency;
- queued and active-run cancellation, timeouts, and process-tree cleanup;
- managed shared, Git worktree, and independent-copy workspace modes;
- Harbor-backed evaluation in Docker with normalized reward summaries;
- atomic manifests/results plus raw stdout and stderr logs; and
- conservative recovery of interrupted records after daemon restart.

Versioned machine-contract schemas live in [`docs/schemas`](docs/schemas).
Runtime validation rejects unknown request fields and preserves typed errors
across the daemon HTTP boundary.

## Installation

Hitch requires Node.js 22 or newer. Install the CLI globally from npm:

```bash
npm install --global agent-hitch
hitch --version
hitch list --json
```

You can also try it without a global installation:

```bash
npx agent-hitch --help
```

For development from a checkout:

```bash
npm test
npm link
hitch list --json
```

Run a task directly:

```bash
hitch run \
  --harness codex@installed \
  --model gpt-5.6-terra \
  --cwd /workspace/project \
  --workspace-mode worktree \
  --prompt-file task.md \
  --output jsonl
```

Run through the persistent daemon:

```bash
hitch daemon start --max-concurrent 4

hitch run \
  --daemon \
  --harness codex@installed \
  --model gpt-5.6-terra \
  --cwd /workspace/project \
  --prompt-file task.md \
  --output jsonl

hitch daemon status --json
hitch daemon stop
```

Submit asynchronously and cancel later:

```bash
hitch daemon submit \
  --harness claude@installed \
  --cwd /workspace/project \
  --prompt-file task.md

hitch daemon cancel run_<id>
```

State is stored below `~/.hitch` by default. Use `--root <path>` or
`HITCH_ROOT` to relocate it. Native executable overrides use
`HITCH_CODEX_PATH`, `HITCH_CLAUDE_PATH`, `HITCH_PI_PATH`,
`HITCH_OPENCODE_PATH`, and `HITCH_DEEPSEEK_PATH`.

## Harbor-backed evals

Run an agent eval with Harbor:

```bash
# Installs pinned Harbor into ~/.hitch/tools without changing system Python.
hitch eval setup harbor
hitch eval doctor

hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --model openai/gpt-5.6 \
  --attempts 1 \
  --max-concurrent 4

hitch eval list
hitch eval inspect eval_<id> --json
```

`hitch eval setup harbor` requires Python 3.12+ and creates an isolated virtual
environment at `~/.hitch/tools/harbor-<version>`. It does not install or start
Docker. `hitch eval doctor` checks Python, the selected Harbor installation,
the Docker daemon, and whether a common provider credential is present. Hitch
automatically prefers the managed Harbor installation for subsequent evals;
`--harbor` and `HITCH_HARBOR_PATH` remain explicit overrides.

Harbor owns task discovery, Docker lifecycle, verification, and rewards. Its
custom Hitch agent uploads a minimal Hitch runtime into each task container and
runs the exact selected harness revision in `/app`. This ensures the benchmark
measures the Hitch execution path rather than Harbor's native agent adapter.

Eval currently accepts exact `version:` refs and `commit:` refs backed by a
registered remote source. Installed executables and local `git+file://` refs are
rejected because they are not portable into Harbor containers. Common provider
credentials are forwarded by environment-variable reference; use
`--pass-env NAME` for an additional variable. Eval records are stored under
`~/.hitch/evals` and include the request, resolved revision, plan, generated
Harbor config, raw backend logs/result, normalized result, and JSONL events.

## Select a harness revision

Harness selection is explicit for every run. Bare names retain the installed
executable behavior; exact published versions and Git commits resolve to
immutable identities and are prepared in Hitch's artifact store.

```bash
# Bare name is an alias for codex@installed.
hitch run --harness codex --prompt "Inspect this repository"

# Resolve or prewarm an exact published version.
hitch resolve codex@version:0.92.0 --json
hitch prepare codex@version:0.92.0 --json
hitch run --harness codex@version:0.92.0 --prompt "Inspect this repository"

# Build a commit from the registered upstream repository.
hitch run --harness codex@commit:0123456789abcdef --prompt "Inspect this repository"

# Build a clean commit from a local harness repository.
hitch run \
  --harness 'pi@git+file:///workspace/pi#0123456789abcdef' \
  --prompt "Inspect this repository"
```

Version selectors require exact semantic versions; ranges and `latest` are not
accepted. Short commit IDs are expanded and must be unambiguous. Local Git
repositories must be clean. Codex, Pi, and DeepSeek Harness support
source-commit preparation; Claude Code and OpenCode currently support installed
and exact-version sources.

The legacy `--agent <name>` option remains available as an alias for
`--harness <name>@installed`. It cannot select revisions or be combined with
`--harness`.

Preparation executes the registered package lifecycle or source-build commands
with the permissions of the Hitch process. A resolved identity makes the input
auditable and cacheable; it is not a security sandbox.

## Why Hitch?

Coding-agent CLIs expose different commands, model flags, configuration formats,
session models, event streams, and process behavior. Hitch absorbs that
integration cost behind a small adapter contract while preserving the native
runtime.

```text
caller -> Hitch CLI / daemon -> shared run engine -> Codex CLI
                                             \----> Claude Code
                                             \----> Pi
                                             \----> OpenCode
                                             \----> DeepSeek Harness
```

The direct CLI and daemon use the same engine, so persistence, timeout,
cancellation, and event behavior do not drift.

## Planned work

- [ ] Additional harness adapters
- [ ] Additional API provider support
- [ ] Local model inference support

## Design principles

- **Agent-first:** structured output, stable exit categories, no required UI.
- **Explicit over ambient:** agent, model, workspace, and state root are visible.
- **Minimal common contract:** unknown native events remain available rather
  than being forced into misleading abstractions.
- **Isolated control state:** each root has its own daemon, token, queue, and run
  records.
- **Safe interruption:** cancellation targets the complete subprocess tree.
- **No implicit replay:** interrupted workspace-mutating runs fail visibly.

## Documentation

- [Design document](docs/design.md)
- [Agent daemon analysis and port](docs/daemon.md)
- [Workspace isolation](docs/workspaces.md)
- [Harbor-backed evals](docs/evals.md)
- [Release process](docs/releasing.md)

## Community

Join the [Hitch community on Discord](https://discord.gg/cZ4NBbHDk) to ask
questions, share feedback, and discuss coding-agent infrastructure.

## Acknowledgements

Hitch draws inspiration from [Multica](https://github.com/multica-ai/multica) and
uses [Harbor](https://github.com/harbor-framework/harbor) as its evaluation
backend. We are grateful to both projects for the foundations they provide.

## Naming

The repository is named `agent-hitch`; the product and executable are named
`Hitch` and `hitch`.

## License

Licensed under the [Apache License 2.0](LICENSE).
