# Hitch

**One local runtime. Any coding agent.**

Hitch is an agent-first CLI and daemon for discovering and running native coding
agents through one stable, machine-oriented interface.

> Status: pre-alpha. Installed-agent discovery, direct runs, and the local
> daemon are implemented. Revision preparation and benchmark backends remain
> planned.

## Available now

Hitch currently supports Codex CLI and Claude Code adapters. It provides:

- executable discovery, version probing, and executable fingerprints;
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
  --agent codex \
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
  --agent codex \
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
  --agent claude \
  --cwd /workspace/project \
  --prompt-file task.md

hitch daemon cancel run_<id>
```

State is stored below `~/.hitch` by default. Use `--root <path>` or
`HITCH_ROOT` to relocate it. Native executable overrides use
`HITCH_CODEX_PATH` and `HITCH_CLAUDE_PATH`.

## Why Hitch?

Coding-agent CLIs expose different commands, model flags, configuration formats,
session models, event streams, and process behavior. Hitch absorbs that
integration cost behind a small adapter contract while preserving the native
runtime.

```text
caller -> Hitch CLI / daemon -> shared run engine -> Codex CLI
                                             \----> Claude Code
```

The direct CLI and daemon use the same engine, so persistence, timeout,
cancellation, and event behavior do not drift.

## Planned work

The broader design includes immutable revision resolution, prepared artifact
caching, managed workspace isolation, additional agents, and benchmark backends
such as Harbor. Those interfaces are documented but not yet implemented.

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
