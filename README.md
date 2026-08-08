# Hitch

**One local runtime. Any coding agent.**

Hitch is an agent-first CLI and daemon for discovering and running native coding
agents through one stable, machine-oriented interface.

> Status: pre-alpha. Installed-harness discovery, immutable revision resolution,
> prepared artifact caching, direct runs, and the local daemon are implemented.
> Benchmark backends remain planned.

## Available now

Hitch currently supports Codex CLI, Claude Code, Pi, and OpenCode adapters. It provides:

- executable discovery, version probing, and executable fingerprints;
- exact package-version and Git-commit resolution;
- immutable prepared artifacts with integrity-aware caching;
- direct execution with normalized JSONL events;
- a persistent local daemon with bounded concurrency;
- queued and active-run cancellation, timeouts, and process-tree cleanup;
- atomic manifests/results plus raw stdout and stderr logs; and
- conservative recovery of interrupted records after daemon restart.

Versioned machine-contract schemas live in [`docs/schemas`](docs/schemas).
Runtime validation rejects unknown request fields and preserves typed errors
across the daemon HTTP boundary.

Hitch requires Node.js 22 or newer. From this checkout:

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
`HITCH_CODEX_PATH`, `HITCH_CLAUDE_PATH`, `HITCH_PI_PATH`, and
`HITCH_OPENCODE_PATH`.

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
repositories must be clean. Codex and Pi support source-commit preparation;
Claude Code and OpenCode currently support installed and exact-version sources.

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
```

The direct CLI and daemon use the same engine, so persistence, timeout,
cancellation, and event behavior do not drift.

## Planned work

The broader design includes managed workspace isolation, additional harnesses,
and benchmark backends such as Harbor. Those interfaces are documented but not
yet implemented.

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

## Naming

The repository is named `agent-hitch`; the product and executable are named
`Hitch` and `hitch`.

## License

License to be selected before the first public release.
