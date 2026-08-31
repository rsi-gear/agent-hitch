# Agent daemon analysis and Hitch port

## Verdict

Multica's agent daemon design is useful, but its package is not a reusable
library. The mature implementation combines two different layers:

1. a generally useful local execution supervisor; and
2. Multica-specific coordination for workspaces, runtimes, issues, comments,
   skills, repositories, server heartbeats, and updates.

Hitch ports the first layer and deliberately leaves the second behind. Copying
the complete package would bring tens of thousands of lines of product-specific
state and invert Hitch's boundary: a local runtime would become a client of a
particular task-management server.

## What was reused

| Multica pattern | Hitch implementation |
| --- | --- |
| Probe native agent CLIs and pin the resolved path | Registry resolves symlinks, records version, and fingerprints the executable |
| Bounded task-slot semaphore | FIFO scheduler with `max_concurrent` slots |
| Separate preparation and execution failure stages | Persisted request/manifest/result with typed exit categories |
| Stream agent output while retaining raw logs | Normalized `events.jsonl` plus `stdout.log` and `stderr.log` |
| Cancel the complete subprocess tree | POSIX process groups; Windows `taskkill /t` |
| Bind a local health server before accepting work | Loopback HTTP server with explicit starting/running/stopping status |
| Keep one daemon owner per state root | Exclusive `daemon.lock`, random instance ID, and ownership-checked cleanup |
| Graceful daemon stop | Authenticated `/shutdown`, stop accepting work, cancel active children |
| Do not silently replay ambiguous work after a crash | Interrupted queued/running records become `daemon_restarted` failures |
| Atomic state transitions | Temporary-file plus rename for manifests and results |

## What was not copied

The following are Multica product concerns rather than a portable agent runtime:

- cloud login and token renewal;
- workspace discovery and runtime registration;
- server polling, WebSocket wakeups, heartbeats, and leases;
- issue/comment/chat prompt construction;
- skill bundle download and local skill import;
- repository allowlists and workspace project bindings;
- server-driven CLI and daemon auto-update;
- Multica-specific session recovery and failure taxonomy;
- product analytics and runtime status reconciliation.

Hitch can later accept tasks from a remote backend, but that belongs behind a
backend interface. It must not be embedded in the local agent adapter contract.

## Hitch daemon architecture

```text
CLI / local caller
       |
       | authenticated loopback HTTP
       v
+-----------------------+
| Daemon API            |
| health / submit / get |
| cancel / shutdown     |
+-----------+-----------+
            |
            v
+-----------------------+
| FIFO scheduler        |
| bounded worker slots  |
+-----------+-----------+
            |
            v
+-----------------------+       +-------------------+
| Shared run engine     |------>| Codex adapter     |
| persist / supervise   |       +-------------------+
| events / timeout      |------>| Claude adapter    |
+-----------------------+       +-------------------+
```

Direct `hitch run` calls the shared run engine without going through HTTP.
`hitch run --daemon` submits to the queue and follows the same persisted run.
Harbor evals can use the same daemon through `hitch eval run --daemon` or the
separate `eval submit`, `eval watch`, and `eval cancel` commands. Daemon runs
and evals reserve capacity from one vector ledger so aggregate CPU, memory, and
container admission stays bounded.

## Lifecycle

```text
accepted -> queued -> running -> succeeded
                         |  \-> failed
                         |  \-> timed_out
                         \----> cancelled
```

An accepted daemon request is written to disk before it enters the in-memory
queue. Submission resolves the requested harness reference to an immutable
revision before it is accepted. The run engine prepares or reuses the artifact,
writes raw and normalized output during execution, and atomically finalizes the
result.

On restart, any record still marked `queued` or `running` without a result is
failed with `daemon_restarted`. Automatic replay is intentionally avoided:
coding-agent runs mutate workspaces and are not generally idempotent.

## Local API

The daemon listens only on `127.0.0.1`. `GET /health` is unauthenticated so the
CLI can distinguish liveness from readiness. Every other endpoint requires the
per-root bearer token in `daemon.token`.

Run requests are validated against the contract represented by
`docs/schemas/run-request.schema.json`. Error responses carry stable `code` and
`exit_code` fields, which the CLI restores as a typed `HitchError`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness, PID, uptime, detected harnesses, queue counts |
| `GET` | `/v1/harnesses` | Refresh and return detailed harness discovery |
| `GET` | `/v1/workers` | Return local execution-provider capabilities and resource capacity |
| `GET` | `/v1/agents` | Compatibility alias using the legacy response key |
| `POST` | `/v1/runs` | Validate, persist, and enqueue a run |
| `GET` | `/v1/runs/{id}` | Read manifest and final result when present |
| `GET` | `/v1/runs/{id}/events?offset={byte}` | Incrementally read normalized NDJSON events and receive the next offset |
| `POST` | `/v1/runs/{id}/cancel` | Cancel queued or active work |
| `POST` | `/v1/evals` | Validate, persist, and enqueue a Harbor eval |
| `GET` | `/v1/evals/{id}` | Read admission state, progress, and final result |
| `GET` | `/v1/evals/{id}/events?offset={byte}` | Incrementally read eval NDJSON events |
| `POST` | `/v1/evals/{id}/cancel` | Cancel a queued or active eval |
| `POST` | `/shutdown` | Gracefully stop the daemon |

`POST /v1/evals` accepts an optional `Idempotency-Key` header. The key is
hashed before persistence and is scoped to the daemon's state root.

Every planned local Harbor work item writes an execution lease under
`evals/<eval-id>/leases/`. The lease records its worker, collision domain,
parent resource allocation, reservation, epoch, and terminal release. On daemon
restart, an accepted/running lease that cannot be proven complete is marked
`lost`; the enclosing eval follows the existing no-blind-replay recovery rule.

## Filesystem contract

```text
~/.hitch/
  daemon.json
  daemon.lock
  daemon.token
  daemon.log
  daemon.err.log
  workspaces/
    run_<uuid>/
      root/
  runs/
    run_<uuid>/
      request.json
      resolution.json
      workspace.json
      manifest.json
      events.jsonl
      stdout.log
      stderr.log
      result.json
```

The root is relocatable with `--root` or `HITCH_ROOT`, which makes concurrent
test profiles and isolated callers possible.

## Current limitations

- The daemon currently hosts direct agent runs only; benchmark jobs have not
  yet been connected to the scheduler.
- Codex, Claude, Pi, OpenCode, and DeepSeek Harness have native adapters. Codex
  and Pi use ephemeral execution to avoid shared session writes, while DeepSeek
  uses a per-run `DSH_HOME`. Full per-run credential/config homes and resume
  semantics still need adapter-specific work elsewhere.
- Exact npm versions are available for all five harnesses. Codex, Pi, and
  DeepSeek Harness also support registered or clean local Git commits;
  source-build support for Claude Code and OpenCode is not currently declared.
- DeepSeek Harness's official headless profile exposes only final plain text on
  stdout, so DeepSeek events are not available live. Hitch imports the complete
  per-run native DSH session after process exit, including tool lifecycle,
  session identity, usage, reasoning, and original event timestamps.
- Event translation is intentionally additive. Native events that do not have a
  stable common meaning are preserved as `provider.event`.
- Run-history/artifact/workspace GC, durable queue replay policy, and push-based
  SSE/WebSocket delivery are not implemented yet.
- Loopback plus a file token protects the local control API from accidental
  cross-process use; it is not an OS sandbox for the launched coding agent.

## Extension points for subsequent features

New work should attach to one of four boundaries:

- add native behavior in an agent adapter;
- add a new execution backend beside direct execution;
- add scheduling policy around the queue without changing agent semantics; or
- add persisted run metadata/events through schema-versioned additive fields.

This boundary is the main value of the port: future features do not need to
inherit Multica's server protocol or duplicate process-supervision logic.
