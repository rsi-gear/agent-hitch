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

For local datasets with known task membership, resource and task-collision
permits are granted per work item by an eval-level deficit round-robin queue.
Opaque datasets retain one coarse allocation. `/health` exposes the dispatcher
under `eval_scheduler.work_items` in addition to the aggregate resource ledger.
The same response keeps the compatibility fields and adds `scheduler.resources`,
local/remote `workers`, and bounded `metrics` for queue/planning/build/setup,
Agent, Verifier and collection time, requested/admitted/effective parallelism,
cache outcomes, lease recovery, rerun type, bundle/capture completeness and
cleanup residue. Harbor wrapper timing evidence keeps Agent and Verifier time
separate; `backend_agent_verifier` remains an explicitly named fallback metric
when an older Harbor integration does not publish phase timing.

## Resource policy

The daemon owns one resource policy for its complete state root. Capacity and
per-unit reservations are configured when it starts:

```bash
hitch daemon start \
  --max-concurrent 8 \
  --capacity-cpu-millis 8000 \
  --capacity-memory-mib 16384 \
  --container-slots 8 \
  --build-slots 2 \
  --capacity-gpus 2 \
  --capacity-ephemeral-disk-mib 32768 \
  --run-cpu-millis 1000 \
  --run-memory-mib 512 \
  --eval-cpu-millis 1000 \
  --eval-memory-mib 1024 \
  --eval-gpus 1 \
  --eval-ephemeral-disk-mib 4096
```

| Value | Default | Meaning |
| --- | --- | --- |
| CPU capacity | Docker VM CPUs minus 1 CPU; conservative `1000` millicore fallback | Shared admission budget |
| Memory capacity | Docker VM memory minus 1 GiB; conservative `1024` MiB fallback | Shared admission budget |
| Container slots | Minimum of `max-concurrent`, CPU fit, and memory fit; `1` when Docker memory is unavailable | Maximum admitted Harbor trials |
| Build slots | `1` | Reserved lane for later managed image builds |
| GPU capacity | omitted (`0`) | Whole Docker-visible devices; must be set explicitly |
| Ephemeral disk capacity | omitted (`0`) | Shared writable-storage admission quota; must be set explicitly |
| Direct run reservation | `1000` millicores, `512` MiB | Cost of one daemon agent run |
| Harbor trial reservation | `1000` millicores, `1024` MiB, one container, GPU/disk omitted | Cost of one admitted local trial |

All values are non-overcommitted reservations. Harbor CPU/memory values become
container hard limits, while a positive GPU value becomes a fixed Compose
device reservation. Ephemeral disk is an admission quota and evidence field;
Hitch does not claim a portable Docker hard limit where the provider cannot
enforce one. `hitch daemon status --json`
returns both `resource_policy` and the live `resources` ledger; human-readable
status prints allocated versus total CPU, memory, container, build, and configured GPU slots.
The selected policy is also persisted in `daemon.json`, so detached startup and
operators inspecting the state root see the same configuration.

Each flag also has an environment-policy equivalent: `HITCH_CAPACITY_CPU_MILLIS`,
`HITCH_CAPACITY_MEMORY_MIB`, `HITCH_CONTAINER_SLOTS`, `HITCH_BUILD_SLOTS`,
`HITCH_CAPACITY_GPUS`, `HITCH_CAPACITY_EPHEMERAL_DISK_MIB`,
`HITCH_RUN_CPU_MILLIS`, `HITCH_RUN_MEMORY_MIB`, `HITCH_EVAL_CPU_MILLIS`,
`HITCH_EVAL_MEMORY_MIB`, `HITCH_EVAL_GPUS`, and
`HITCH_EVAL_EPHEMERAL_DISK_MIB`. A CLI flag wins over its environment value;
otherwise Hitch probes the Docker Engine for CPU and memory before using the
conservative fallback. GPU and ephemeral-disk capacity are never inferred.

GPU capacity is an admission promise made by the operator. Before enabling it
in production, preload a digest-pinned CUDA image containing `nvidia-smi` and
run:

```bash
HITCH_GPU_CANARY_IMAGE=<cuda-image@sha256:digest> npm run canary:gpu-hardware
```

The canary requires one declared device, proves a competing trial cannot enter
until the GPU lease is released, checks Candidate and separate-Verifier
representative containers each receive exactly one usable GPU, validates the
Docker device request, and checks ledger cleanup. CI exposes the same gate as
the manually dispatched `NVIDIA GPU hardware canary` workflow for a
`self-hosted,linux,x64,gpu,nvidia` runner.

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
| `POST` | `/v1/evals/{id}/reruns` | Persist and enqueue a typed rerun operation |
| `GET` | `/v1/evals/{id}/reruns/{rerun-id}` | Read rerun submission, state, and result |
| `GET` | `/v1/evals/{id}/reruns/{rerun-id}/events?offset={byte}` | Incrementally read rerun NDJSON events |
| `POST` | `/v1/evals/{id}/reruns/{rerun-id}/cancel` | Fence the identity and wait for rerun execution and resource cleanup to stop |
| `POST` | `/shutdown` | Gracefully stop the daemon |

`POST /v1/evals` accepts an optional `Idempotency-Key` header. The key is
hashed before persistence and is scoped to the daemon's state root.
The accepted response includes stable `self`, `events`, and `cancel` links.
`hitch eval run --daemon` and `hitch eval submit` expose execution-policy flags
for provider, integer CPU cores per trial, whole-MiB memory size, build mode,
capture mode, and required capture. When any such flag is used, the CLI reads
the daemon's advertised eval-trial defaults and sends a complete immutable
execution policy rather than guessing omitted resource dimensions.

Every planned local Harbor work item writes an execution lease under
`evals/<eval-id>/leases/`. The lease records its worker, collision domain,
parent resource allocation, reservation, epoch, heartbeat, and terminal
release. Running work renews its lease every 10 seconds against a 45-second
TTL. Recovery that can prove the original physical execution is still alive
reissues the lease at a higher epoch; old-epoch heartbeat and release writes
then fail closed. The local provider persists Harbor PID and process-start
identity and can therefore distinguish a live original process from PID reuse.
During daemon startup the scheduler probes that identity before changing the
lease. A live or terminal-uncollected process is adopted at a higher epoch,
heartbeated, and collected into the existing eval. Work items with no prior
lease are then resumed from the immutable execution plan. Missing or
contradictory process evidence is marked `execution_state_ambiguous`; it is not
silently replayed.

The rerun submission body uses one explicit selector:

```json
{"rerun_type":"candidate-restart","selector":{"mode":"invalid"}}
```

or `{"mode":"tasks","task_names":["task-a"]}`. Reruns are durable queued
operations and share the daemon resource ledger and collision domain with new
evals. The reserved resume/replay/collect types retain their distinct semantics
and stable unavailable errors; they never fall back to `candidate-restart`.

`GET /v1/workers` now returns the execution-provider status contract: provider
and worker identity, collision domain, health heartbeat, platforms, backend
versions/features, and vector capacity. For planned local work, Hitch stores a
provider execution record under `evals/<eval-id>/provider/leases/`. The record
pins the work/lease epoch, epoch-qualified backend directory, Harbor PID, and an
OS process-start identity so PID reuse cannot be mistaken for a recovered run.
The local probe distinguishes `running`, `terminal-uncollected`, `released`, and
`ambiguous`. Lease-managed Harbor processes write stdout/stderr directly to
epoch-qualified files instead of daemon-owned pipes, allowing the original
process to survive a daemon crash. The provider can poll and reconcile an
orphaned process without inventing an exit code. A small detached supervisor
also persists the real Harbor exit code when possible. Daemon recovery restores
lease heartbeat, imports terminal Harbor results idempotently, releases the
provider record before the lease, and skips already-settled task/attempt slots.
This is recovery of the same physical execution, not a rerun operation.

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

- Local Harbor evals are connected to the daemon scheduler and share its
  resource ledger with direct agent runs. Registry datasets with opaque task
  membership still use the conservative single-Harbor-job compatibility path.
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
- Reservations currently control admission only; Docker/cgroup hard limits,
  live resource metering, Harbor-wired BuildKit image jobs, and remote workers remain
  future provider work.
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

Daemon rerun submissions may include a client-persisted `rerun_id`. The operation's
`cancel` link targets its own scheduler; the source eval's cancel link does not
stop reruns. Cancellation fences delayed submissions and waits for execution and
lease release. See [durable rerun ownership](evals.md#durable-daemon-rerun-ownership-and-cancellation).
