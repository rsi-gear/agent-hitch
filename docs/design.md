# Hitch Design Document

- **Status:** Draft
- **Product:** Hitch
- **Repository:** `agent-hitch`
- **Primary interface:** `hitch` CLI
- **Audience:** autonomous agents and agent orchestration systems

## 0. Implementation status

The first executable slice is implemented in dependency-free Node.js 22+. It
includes native Codex CLI, Claude Code, Pi, OpenCode, and DeepSeek Harness
discovery and direct execution, normalized JSONL events, persisted run records,
bounded daemon concurrency, cancellation, timeout handling, health reporting,
and conservative crash recovery.

The resolver, artifact store, and prepared revisions described below are now
implemented for installed executables, exact npm package versions, registered
Git commits, and clean local Git commits. Codex, Pi, and DeepSeek Harness provide
source-build recipes; Claude Code and OpenCode currently provide installed and
package-version recipes. DeepSeek Harness runs through its official headless
profile with plain-text final output and a per-run `DSH_HOME`. Shared,
detached-worktree, and independent-copy workspace modes are implemented. A
first optional benchmark backend delegates task execution, container lifecycle,
verification, and rewards to Harbor while retaining Hitch as the agent
execution path inside each task container. Harbor can be installed into
Hitch-owned state with `hitch eval setup harbor`, and the read-only `hitch eval
doctor` command verifies its prerequisites.

Sections 1–23 describe the target architecture. Current daemon behavior is also
specified in `docs/daemon.md`, and the workspace contract is specified in
`docs/workspaces.md`.

## 1. Summary

Hitch provides one machine-oriented interface for running different coding-agent
harnesses and different revisions of those harnesses.

The product boundary is intentionally narrow:

```text
resolve -> prepare -> run -> report
```

An upper-level agent remains responsible for choosing a harness, modifying its
source, creating commits, designing comparisons, evaluating results, and deciding
what to do next.

Hitch is therefore not an evolution platform or an agent orchestrator. It is the
switching and execution layer those systems can call.

## 2. Problem

Coding-agent harnesses differ in several ways:

- installation and update mechanisms
- command-line flags and process lifecycle
- prompt and task input formats
- configuration and credential locations
- non-interactive and interactive modes
- session creation and resume behavior
- approval and permission models
- streaming output and tool-event formats
- cancellation and shutdown behavior

An agent that directly integrates every harness must understand all of those
differences. It also becomes coupled to mutable global configuration such as
`~/.codex` or `~/.claude`, making concurrent and reproducible execution hard.

Hitch absorbs that integration cost behind a stable CLI and a small adapter
contract.

## 3. Goals

### 3.1 Product goals

1. Let an agent discover which harnesses and revisions are available.
2. Resolve user-friendly references to immutable revision identifiers.
3. Prepare and cache runnable artifacts reproducibly.
4. Run different harnesses through the same invocation contract.
5. Emit machine-readable lifecycle events and typed failures.
6. Keep concurrent runs isolated from each other and from user-global config.
7. Preserve harness-specific capabilities without pretending every harness is
   identical.

### 3.2 Engineering goals

- idempotent `resolve` and `prepare` operations
- deterministic resolution and manifests
- atomic artifact installation
- explicit inputs and inspectable outputs
- support for local Git repositories and upstream repositories
- safe cancellation and complete child-process cleanup
- adapters that can evolve independently of the CLI core

## 4. Non-goals

The first versions of Hitch will not:

- decide which harness should be used
- edit or mutate harness source code
- create Git commits on behalf of an evolution agent
- implement benchmark tasks, verifiers, reward logic, or winner promotion
- schedule multi-candidate A/B experiments
- coordinate multiple agents
- provide model routing or API gateway behavior
- synchronize user prompts, MCP servers, or skills across desktop applications
- provide a GUI, dashboard, system tray, or cloud sync

These features can be implemented by systems above Hitch or added later as
separate, optional components.

## 5. Actors and primary scenarios

### 5.1 Calling agent

The primary actor is an agent or orchestration process that can invoke a local
CLI and parse JSON.

Typical flow:

```text
inspect candidates
      |
resolve a revision
      |
prepare the artifact
      |
run the task
      |
consume events and result
      |
choose the next action outside Hitch
```

### 5.2 Human developer

A human can use the same commands for debugging and local development. Human
readable output is useful, but it must be a presentation of the machine contract,
not a separate behavioral path.

### 5.3 Adapter author

An adapter author adds support for a harness by describing its capabilities,
materializing its runtime configuration, launching it, and translating its
observable lifecycle into Hitch events.

## 6. Terminology

### Harness definition

Metadata and adapter configuration for a harness family, such as `pi` or
`codex`. A definition is not a specific installed version.

### Harness reference

A user-facing expression such as `pi@installed`, `pi@version:0.84.1`, or
`pi@commit:abc1234`. A bare `pi` is the compatibility alias for
`pi@installed`. Future branch or tag selectors would be mutable inputs.

### Harness revision

An immutable resolved identity, such as a full Git commit SHA, exact package
version plus integrity hash, or source-tree content digest.

### Artifact

A prepared installation produced from one harness revision. Artifacts are
immutable after successful preparation.

### Adapter

Harness-specific logic that converts Hitch's common run request into the native
invocation and converts native output into Hitch events.

### Run

One execution of a prepared artifact in a workspace. A run has an immutable
manifest, isolated runtime state, events, diagnostics, and a final result.

### Profile

A named set of runtime configuration references, such as model defaults,
credential references, permission mode, or adapter options. Profiles do not
change artifact identity.

## 7. Design principles

### 7.1 Explicit selection

The primary run interface always accepts an explicit harness reference:

```bash
hitch run --harness pi@commit:abc1234 ...
```

An optional workspace default may be added for human convenience, but explicit
selection always wins. The core API must never depend on a process-global
"currently selected harness."

### 7.2 Immutable resolution

Mutable inputs must be resolved before execution:

```text
pi@commit:abc1234 -> pi@git:<repository>#<full-commit-sha>
```

The resolved value is recorded in the artifact and run manifests.

### 7.3 Isolation instead of global rewriting

Hitch should avoid modifying the user's normal harness configuration. Each run
receives a dedicated runtime home/config directory wherever the target harness
supports it.

If a harness cannot redirect its config directory, the adapter must declare the
limitation. Serialized global mutation is a compatibility fallback, not the
default architecture.

### 7.4 Minimal common denominator

Hitch standardizes:

- run start and completion
- prompt/task input
- working directory
- environment and profile references
- stdout/stderr capture
- cancellation and timeout
- exit status
- core lifecycle diagnostics

It does not force unsupported features such as session resume, approvals, or
structured tool events into a false common abstraction. Those are declared as
capabilities.

### 7.5 JSON is the contract

Human-readable output is optional presentation. Automation uses versioned JSON
documents and JSONL event streams.

## 8. High-level architecture

The implementation is organized as a checked dependency DAG: pure `domain`
contracts at the base, Node.js primitives in `foundation`, independently
testable capabilities (`adapters`, `revisions`, `artifacts`, `workspaces`, and
`trajectories`) above them, application orchestration in `runs` and `evals`,
and `daemon`/`cli` at the interface edge. Each boundary exposes an `index.ts`
facade; the build rejects cross-boundary deep imports and dependency cycles.

```text
                         +----------------------+
                         | Upper-level Agent    |
                         +----------+-----------+
                                    |
                                    | CLI + JSON/JSONL
                                    v
+------------------------------------------------------------------+
| Hitch Core                                                       |
|                                                                  |
|  +------------+  +------------+  +------------+  +------------+ |
|  | Registry   |  | Resolver   |  | Store      |  | Run Engine | |
|  +------------+  +------------+  +------------+  +------------+ |
|                                              |                   |
|                                  +-----------+-----------+       |
|                                  | Adapter Interface     |       |
+----------------------------------+-----------+-----------+-------+
                                               |
                   +---------------------------+------------------+
                   |                           |                  |
                   v                           v                  v
             +-----------+               +-----------+      +----------+
             | Pi        |               | Codex     |      | Others   |
             | Adapter   |               | Adapter   |      |          |
             +-----------+               +-----------+      +----------+
```

### 8.1 Registry

Stores harness definitions and known source metadata. It answers which harnesses
exist and which adapter owns each harness.

The registry is metadata, not the artifact store and not an experiment database.

### 8.2 Resolver

Converts a harness reference into an immutable revision. Resolution may inspect:

- a Git repository
- a local Git working tree
- a package registry
- an installed executable
- a registry-provided default source

### 8.3 Artifact store

Maintains prepared revisions in a content-addressed or revision-addressed local
store. Preparation occurs in a temporary location and is atomically promoted
only after validation succeeds.

### 8.4 Run engine

Creates a run directory, writes the manifest, asks the adapter for a native
process specification, supervises the process, streams events, handles timeout
and cancellation, and writes the final result.

### 8.5 Adapters

Contain harness-specific installation, configuration, invocation, capability,
and event translation logic.

### 8.6 Local daemon

The daemon is an optional long-lived frontend to the same run engine. It owns a
bounded FIFO queue, exposes health and run-control endpoints on `127.0.0.1`, and
persists every accepted request before launch. Direct `hitch run` remains the
simplest path; `hitch run --daemon` is intended for callers that need shared
concurrency control, asynchronous submission, cancellation, and inspection.

The daemon is not an agent orchestrator: it does not choose an agent, construct
task graphs, assign work, or evaluate results. See `docs/daemon.md` for the
porting analysis and API.

## 9. CLI surface

The CLI contains seven primary commands.

### 9.1 `hitch list`

Lists registered harness definitions and installation state.

```bash
hitch list --json
```

Example response:

```json
{
  "schema_version": "1",
  "harnesses": [
    {
      "id": "pi",
      "adapter": "pi",
      "installed_revisions": ["abc123"],
      "status": "available"
    }
  ]
}
```

### 9.2 `hitch inspect`

Returns definition, source, capabilities, installed revisions, and known
limitations.

```bash
hitch inspect pi --json
```

### 9.3 `hitch resolve`

Resolves a mutable reference without preparing or running it.

```bash
hitch resolve pi@commit:abc1234 --json
```

Example response:

```json
{
  "schema_version": "1",
  "requested_ref": "pi@commit:abc1234",
  "resolved_revision": {
    "harness": "pi",
    "source_type": "git",
    "source": "https://github.com/example/pi.git",
    "revision": "abc123fullsha",
    "identity": "sha256:..."
  }
}
```

### 9.4 `hitch prepare`

Resolves, fetches, builds, validates, and caches a revision.

```bash
hitch prepare pi@commit:abc1234 --json
```

Calling `prepare` repeatedly for the same resolved identity must be safe and
should return the cached artifact when valid.

### 9.5 `hitch run`

Runs a task with an explicitly selected harness.

```bash
hitch run \
  --harness pi@commit:abc1234 \
  --cwd /workspace/project \
  --prompt-file task.md \
  --profile default \
  --timeout 30m \
  --output jsonl
```

`run` may implicitly call `resolve` and `prepare`. The separate commands exist
so agents can inspect cost and failure boundaries before execution.

### 9.6 `hitch eval`

The optional eval surface delegates benchmark semantics to Harbor:

```bash
hitch eval setup harbor
hitch eval doctor --json
hitch eval run --dataset terminal-bench@2.0 --harness codex@version:0.92.0
```

Setup installs a pinned Harbor version into the selected Hitch state root. It
does not mutate system Python or install Docker. Doctor checks Python, Harbor,
the Docker daemon, and provider credential presence without exposing secret
values. Eval execution automatically discovers the managed Harbor installation.

## 10. Harness reference syntax

The first parser should support:

```text
pi                                      installed executable compatibility alias
pi@installed                            installed executable
pi@version:0.42.1                       exact published package version
pi@commit:abc1234                       commit from the registered Git source
pi@git+file:///path/to/pi#abc1234       clean local Git repository and commit
```

Rules:

1. A successful resolution always produces an immutable identity.
2. Package versions are exact semantic versions. Ranges, tags such as `latest`,
   and implicit selector guessing are rejected.
3. Short Git SHAs are expanded to full SHAs and must be unambiguous.
4. Branch and tag selection is not part of the first implementation.
5. Dirty local trees are rejected. A future explicit snapshot mode may identify
   them by content digest.
6. Explicit Git URLs are limited to `file://` in the first implementation;
   remote commits use the harness's registered source.
7. Authentication material must not appear in persisted source URLs.

## 11. Machine output contract

### 11.1 JSON documents

Non-streaming commands return one JSON document on stdout when `--json` is set.
Diagnostics intended for humans go to stderr.

Every public document includes:

```json
{
  "schema_version": "1"
}
```

### 11.2 JSONL events

`hitch run --output jsonl` emits one event per line:

```json
{"schema_version":"1","type":"run.started","run_id":"run_01","harness":"pi","revision":"abc123"}
{"schema_version":"1","type":"message.delta","run_id":"run_01","text":"Inspecting repository..."}
{"schema_version":"1","type":"tool.started","run_id":"run_01","call_id":"call_01","name":"shell"}
{"schema_version":"1","type":"tool.completed","run_id":"run_01","call_id":"call_01","status":"succeeded"}
{"schema_version":"1","type":"run.completed","run_id":"run_01","status":"succeeded","exit_code":0}
```

Core event types:

- `run.started`
- `workspace.ready`
- `process.stdout`
- `process.stderr`
- `message.delta`
- `message.completed`
- `diagnostic`
- `run.completed`
- `run.failed`

Optional capability-dependent events:

- `session.created`
- `approval.requested`
- `tool.started`
- `tool.completed`
- `usage.updated`

Unknown event fields must be ignored by consumers. Unknown event types may be
recorded and skipped, allowing additive protocol evolution.

### 11.3 Exit codes

Proposed stable categories:

| Code | Meaning |
|---:|---|
| 0 | Successful Hitch operation or successful harness run |
| 2 | Invalid CLI input or manifest |
| 3 | Harness or revision not found |
| 4 | Resolution failed |
| 5 | Preparation or build failed |
| 6 | Harness launch failed |
| 7 | Harness run failed |
| 8 | Timed out |
| 9 | Cancelled |
| 10 | Capability unsupported |
| 11 | Policy or trust check rejected the operation |
| 12 | Internal Hitch error |

The final JSON result carries a more specific typed error code and diagnostic
details. Shell exit codes remain a coarse, stable classification.

## 12. Core data model

### 12.1 Harness definition

```yaml
schema_version: "1"
id: pi
display_name: Pi
adapter: pi
default_source:
  type: git
  url: https://github.com/example/pi.git
capabilities:
  non_interactive: true
  streaming: true
  sessions: true
  resume: true
  structured_tool_events: true
```

### 12.2 Resolved revision

```yaml
harness: pi
source_type: git
source: https://github.com/example/pi.git
requested_revision: abc1234
resolved_revision: abc123fullsha
identity: sha256:...
resolved_at: 2026-08-07T00:00:00Z
```

### 12.3 Artifact manifest

```yaml
artifact_id: sha256:...
harness: pi
revision_identity: sha256:...
adapter: pi
adapter_version: "1"
platform: darwin-arm64
entrypoint: bin/pi
artifact_integrity: sha256:...
prepared_at: 2026-08-07T00:00:00Z
```

### 12.4 Run manifest

```yaml
run_id: run_01
artifact_id: sha256:...
harness: pi
requested_harness_ref: pi@commit:abc1234
revision_identity: sha256:...
revision: abc123fullsha
workspace: /workspace/project
profile: default
input:
  type: prompt_file
  path: task.md
timeout_seconds: 1800
created_at: 2026-08-07T00:00:00Z
```

Secrets must not be serialized into these manifests.

## 13. Adapter contract

The implementation language may change, but the conceptual adapter interface is:

```text
Adapter
  metadata() -> AdapterMetadata
  capabilities(artifact) -> Capabilities
  validate_artifact(artifact) -> Diagnostics
  materialize_config(run_context) -> RuntimeConfig
  launch(run_context, runtime_config) -> ProcessSpec
  translate_output(native_event) -> zero or more HitchEvent
  cancel(process) -> CancelResult
  collect_result(process, events) -> RunResult
```

### 13.1 Adapter responsibilities

- translate common inputs into native flags, RPC calls, or stdin messages
- create harness-specific runtime configuration
- redirect config and session directories where possible
- declare capabilities and limitations truthfully
- translate native lifecycle signals into Hitch events
- terminate all spawned child processes on cancellation
- avoid leaking credentials in arguments, manifests, or events

### 13.2 Core responsibilities

- reference parsing and immutable resolution
- artifact locking, caching, and atomic promotion
- run ID generation and directory lifecycle
- timeout and cancellation coordination
- output framing and schema versioning
- generic process supervision
- persistent run manifest and final result

Adapters should not implement experiment scheduling or winner selection.

## 14. Run lifecycle

```text
hitch run
   |
   v
parse and validate request
   |
   v
resolve immutable revision
   |
   v
find or prepare artifact
   |
   v
create isolated run directory
   |
   v
materialize adapter config
   |
   v
launch and supervise harness
   |
   +----> stream normalized events
   |
   v
collect result and diagnostics
   |
   v
atomically finalize run record
```

If any stage fails, Hitch emits a typed failure identifying the stage. An agent
must be able to distinguish "revision not found" from "build failed" and
"harness ran but task failed."

## 15. Isolation and concurrency

### 15.1 Run directory

Each run gets an isolated directory containing:

```text
run_<id>/
  manifest.json
  runtime-home/
  config/
  events.jsonl
  stdout.log
  stderr.log
  result.json
```

### 15.2 Environment

The adapter receives a controlled environment with explicit values for runtime
home, config paths, workspace, and credential references. Inheriting the entire
parent environment should be configurable and conservative by default.

### 15.3 Locks

- artifact preparation is locked by resolved artifact identity
- completed artifacts are immutable and need no run lock
- run directories are never shared
- global-config fallback adapters use a per-harness exclusive lock

### 15.4 Workspace isolation

Every run selects an explicit workspace mode:

- `shared` uses the caller's directory directly and preserves the original
  compatibility behavior. The caller owns concurrency safety.
- `worktree` requires a clean Git workspace and creates a detached worktree at
  the accepted `HEAD` commit. The requested `cwd` is mapped to the same relative
  subdirectory in the new checkout.
- `copy` snapshots the current filesystem state. Git sources are cloned without
  hardlinks and overlaid with the source work tree, so their root Git metadata is
  independent and dirty, untracked, and ignored files are retained.

Managed workspaces are stored by run ID and retained after completion. Hitch
never applies their contents back to the source workspace automatically. The
`workspace inspect`, `workspace path`, and `workspace remove` commands expose
their lifecycle. See `docs/workspaces.md` for the detailed contract.

## 16. Configuration and secrets

Configuration precedence should be explicit:

```text
CLI arguments
  > run manifest
  > named profile
  > harness definition defaults
```

Credentials are passed by reference, for example:

```yaml
credentials:
  openai: env:OPENAI_API_KEY
  anthropic: env:ANTHROPIC_API_KEY
```

Initial implementations may support environment references. Native keychain and
external secret-provider integrations can be added later.

Hitch must redact known credential values from logs and diagnostics. It should
prefer environment variables or protected files over command-line arguments,
which may be visible in process listings.

## 17. Local filesystem layout

Proposed default:

```text
~/.hitch/
  config.yaml
  registry/
    harnesses/
  store/
    artifacts/
    refs/
  cache/
    sources/
  locks/
    artifacts/
    sources/
    workspaces/
  workspaces/
    run_<id>/
      root/
  tmp/
  runs/
  profiles/
```

For CI and nested-agent use, all state must be relocatable through one explicit
root option or environment variable:

```bash
hitch --root /tmp/hitch-state ...
```

## 18. Trust and security boundary

Preparing and running a harness executes third-party code. Hitch cannot make an
untrusted harness safe merely by normalizing its CLI.

The minimum trust model should include:

- display and persist the exact resolved source identity
- require explicit opt-in for unregistered sources
- reject dirty local trees unless explicitly allowed
- never execute build hooks during `list` or `inspect`
- separate resolution from preparation so agents can review before execution
- support checksums or signatures when a source provides them
- make network and sandbox policy visible in the run manifest

OS-level sandboxing is valuable but is not required for the first functional
prototype. The design must leave room for a future runner backend that uses
containers or native sandboxing.

## 19. Capability model

Capabilities prevent the common interface from becoming misleading.

Initial fields:

```yaml
non_interactive: true
streaming: true
structured_messages: true
structured_tool_events: false
sessions: true
resume: true
approvals: false
model_selection: true
config_dir_override: true
graceful_cancel: true
```

A request for an unsupported required capability fails before launch:

```bash
hitch run --harness example --require resume
```

Adapters may also expose namespaced options:

```bash
hitch run --harness codex --adapter-option codex.approval_policy=never
```

Namespaced options are recorded in the run manifest and must not silently alter
the meaning of common options.

## 20. MVP plan

### Phase 0: contract spike

- finalize JSON schemas and exit codes
- implement a fake adapter used for deterministic tests
- validate cancellation, timeout, streaming, and artifact caching

### Phase 1: first real adapter

- implement Pi or Codex end to end
- support registered source, exact revision, prepare, and run
- isolate runtime config
- capture a replayable run record

### Phase 2: abstraction validation

- implement the second adapter from a structurally different harness
- revise the adapter interface based on real incompatibilities
- add capability negotiation and typed limitations

### Phase 3: local harness development

- resolve local Git repositories by commit
- support explicit dirty-tree snapshots
- improve artifact reuse and build diagnostics

### Phase 4: community adapters

- document adapter authoring
- define conformance tests
- add Claude Code and OpenCode adapters
- decide whether adapters ship in-tree or as signed plugins

## 21. MVP acceptance criteria

The MVP is successful when an external agent can:

1. list supported harnesses without parsing human text
2. resolve two different harness revisions to immutable identities
3. prepare both revisions idempotently
4. run the same task against Pi and Codex by changing only `--harness`
5. consume valid JSONL lifecycle events from both runs
6. distinguish resolution, preparation, launch, timeout, cancellation, and
   harness failures
7. run the two harnesses concurrently without their Hitch config colliding
8. reproduce each invocation from its persisted run manifest, excluding secrets

## 22. Decisions made

- The product name is **Hitch** and the repository name is `agent-hitch`.
- The primary user is an Agent, not a human desktop user.
- The primary interface is a CLI with JSON/JSONL, not a GUI.
- Harness selection is explicit per run; global switching is not the core model.
- Git revision support is a first-class feature.
- Harness references use explicit `version:` and `commit:` selector types.
- A bare harness name means `@installed` for compatibility.
- `--harness` is the public selector; legacy `--agent <name>` means
  `--harness <name>@installed` and cannot select a revision.
- Benchmark definitions, reward policy, winner promotion, and self-evolution
  remain outside this repository; Hitch may invoke an optional eval backend.
- The first adapters should be Pi and Codex to test materially different native
  interfaces.
- The contract spike uses dependency-free Node.js 22+ before Hitch commits to a
  compiled external-plugin ABI.
- A local daemon is an optional execution frontend, not a replacement for the
  direct CLI path.
- Daemon-mutating endpoints require a per-root bearer token even though the
  server listens only on loopback.

## 23. Open questions

1. Should adapters initially remain in-tree or load as external plugins?
2. What is the minimal event schema both Pi and Codex can support faithfully?
3. Should `prepare` permit arbitrary build commands from community manifests by
   default, or require a trust flag?
4. How should installed vendor CLIs be fingerprinted when their package manager
   does not expose an integrity hash?
5. Which session behaviors belong in the common contract versus adapter-specific
   extensions?
