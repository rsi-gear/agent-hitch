# Hitch 0.2 Development Spec

- Status: Draft v0.1
- Target release: `0.2.0`
- Updated: 2026-08-20
- Positioning: content-addressed version control and evidence storage for agent harnesses
- Hitch baseline reviewed: `dev@c42ef93`
- Gear design reviewed: `docs/dsh-self-evolving-harness-spec.md` v0.4 and `docs/hitch-dsh-integration.md` v0.3
- DeepSeek Harness contract reviewed: `master@141eb6fef83422698aef7a981029e843e8161534`

## 1. Summary

Hitch 0.2 repositions Hitch from "one local runtime for coding agents" to the
version-control and evidence layer for agent harnesses. Hitch resolves mutable
user input to immutable harness revisions, prepares content-addressed runnable
artifacts, executes exact revisions in controlled workspaces, and records the
runtime and trajectory evidence needed to reproduce or compare a run.

The identity chain is:

```text
Harness Ref
  -> Resolved Revision
  -> Prepared Artifact
  -> Run / Eval
  -> Trajectory
  -> Feedback / Evaluation evidence

Hitch Controller Runtime
  -> SHA-256 Controller Runtime Bundle
  -> referenced by Run / Eval
```

Four changes make that positioning concrete:

1. Eval-local Hitch runtime copies are replaced with a shared, read-only,
   SHA-256-addressed controller runtime cache.
2. Agent trajectories use the DeepSeek Harness session-log contract and
   message-feedback semantics, while Hitch lifecycle events remain a separate
   control plane.
3. Hitch implements the adapter and evidence boundaries required by the Gear
   self-evolving harness design.
4. The JavaScript codebase is migrated to strict TypeScript and published as
   compiled ESM.

## 2. Goals and non-goals

### 2.1 Goals

Hitch owns the following responsibilities:

- Parse a harness reference and resolve it to an immutable revision identity.
- Prepare a revision as a validated, content-addressed, platform-specific
  artifact.
- Package the active Hitch controller into a validated, content-addressed
  runtime bundle suitable for container upload.
- Execute a run or eval with exact revision, artifact, controller runtime, and
  workspace identities.
- Persist the agent trajectory, process logs, terminal result, and links to
  evaluation evidence.
- Expose stable CLI, JSON schemas, and read-only records for Gear's
  `RefineService` and other consumers.
- Preserve enough native provider data to audit translation loss.

### 2.2 Non-goals

Hitch does not own:

- The Gear champion pointer, promotion policy, or rollback policy.
- Verifier execution policy, scoring, `evaluationContextDigest`, or the final
  refinement decision.
- DSH `/refine`, persistent IPython, or `HarnessLoader` implementation.
- Seed or held-out task generation.
- Mutation of model, provider, credential, network, permission, evaluator, or
  DSH agent-loop configuration.
- Process security for local workspaces. A Hitch workspace is not a sandbox.
- Byte-for-byte reproduction of DSH's default Zstandard session encoding in
  V1. Hitch uses DSH's supported uncompressed JSONL encoding.

## 3. Domain model and authority boundaries

The major records have distinct meanings and must not be collapsed:

| Record | Identity | Authority |
| --- | --- | --- |
| Resolved revision | Source plus exact version/commit | Hitch resolver |
| Prepared artifact | Revision, recipe, toolchain, platform, content | Hitch artifact store |
| Controller runtime bundle | Exact Hitch execution payload bytes | Hitch controller runtime store |
| Workspace snapshot | Source and isolated execution state | Hitch workspace manager |
| Run control events | Scheduling, process, timeout, and terminal lifecycle | Hitch run engine |
| Agent trajectory | Model-visible messages, tool calls/results, turn/step boundaries | DSH-compatible trajectory store |
| Verifier result and score | Trusted task verifier execution | Gear `RefineService` |
| Champion and promotion decision | Accepted harness lineage | Gear `RefineService` |

Every run and eval must make the following chain queryable:

```text
requested harness ref
  -> resolved revision identity
  -> prepared artifact id
  -> controller runtime id
  -> workspace snapshot identity
  -> run id
  -> trajectory ref
  -> terminal result
```

An evaluation may add verifier and score references, but Hitch must not imply
that those values can be derived from the trajectory alone.

## 4. Shared read-only controller runtime cache

### 4.1 Terminology

The Hitch code uploaded into a Harbor task container is called a
`ControllerRuntimeBundle`. This is distinct from:

- a prepared harness artifact, which contains the selected harness revision;
- a per-run `runtime-home`, which is writable harness configuration/session
  state; and
- the task workspace, which the selected harness edits.

### 4.2 Store layout

```text
<hitch-root>/
  store/
    controller-runtimes/
      sha256/
        <64-hex>/
          manifest.json
          payload/
            package.json
            dist/
  locks/
    controller-runtimes/
      <64-hex>.lock
  tmp/
    runtime-staging-*/
```

New eval directories do not contain a complete Hitch runtime:

```text
eval_<id>/
  request.json
  resolution.json
  runtime.ref.json
  plan.json
  events.jsonl
  result.json
  harbor/
    job.json
    stdout.log
    stderr.log
    job/result.json
```

`runtime.ref.json` is the durable, portable reference. Harbor's generated
`job.json` may include the local absolute cache path required by the Python
bridge, but that path is diagnostic machine-local state and is not identity.

### 4.3 Runtime manifest

```ts
type Sha256 = `sha256:${string}`

interface ControllerRuntimeFile {
  path: string
  size: number
  executable: boolean
  sha256: Sha256
}

interface ControllerRuntimeEntrypoints {
  cli: {
    path: string
    launcher: 'node'
  }
}

interface ControllerRuntimeManifest {
  schema_version: '2'
  runtime_id: Sha256
  node_range: '>=22'
  entrypoints: ControllerRuntimeEntrypoints
  files: ControllerRuntimeFile[]
  created_at: string
}
```

`entrypoints.cli.path` is the CLI entrypoint relative to the upload root
(`/opt/hitch`); it MUST be one of the declared `files` and is executed by the
Harbor bridge instead of a hardcoded TypeScript build path. `created_at` is
descriptive and is excluded from `runtime_id` calculation.

The controller-runtime manifest was promoted from `schema_version: '1'` to
`'2'` when `entrypoints` was added to the canonical identity. Legacy
`controller-runtime-ref-v1` references that point at a v1 manifest are treated
as invalid (`controller_runtime_integrity_mismatch`) rather than silently
re-interpreted: a v1 manifest cannot declare `entrypoints`, so there is no
trusted entrypoint to execute. There is no automatic v1→v2 promotion or
rewrite of historical bundles; a future explicit migration/GC command may
re-materialize them (spec §4.7 policy applies to any historical runtime
storage kind).

### 4.4 Canonical identity

Runtime identity is calculated as follows:

1. Enumerate an explicit allowlist of compiled runtime payload files.
2. Reject symlinks, hardlinks, devices, FIFOs, sockets, path traversal,
   duplicate paths, and undeclared files.
3. Normalize manifest paths to NFC with `/` separators.
4. Sort files by the UTF-8 bytes of the normalized path.
5. Hash each file's original bytes with SHA-256.
6. Canonically encode `{ schema_version, node_range, entrypoints, files }` with
   sorted object keys and no insignificant whitespace.
7. Set `runtime_id` to the SHA-256 of that canonical encoding.

The digest excludes cache path, source path, file mtime, uid/gid, creation
time, and host-specific metadata. The executable bit is included. The package
name/version are covered because `package.json` is part of the payload.

A bundle's identity is only valid when the recomputed canonical digest equals
both the manifest's declared `runtime_id` and the content-addressed cache
directory id; a runtime id can never be rebound to a different payload.

### 4.5 Creation and promotion

- Runtime construction copies the allowlisted payload into a unique staging
  directory. It must not hardlink files from the development or installed
  package tree.
- The staging payload is hashed, its manifest is written, and the complete
  tree is verified a second time.
- A lock keyed by `runtime_id` serializes promotion.
- Promotion uses an atomic rename into the final content-addressed directory.
- If a valid bundle already exists, staging is discarded and the existing
  bundle is returned as a cache hit.
- If the destination is invalid, it is quarantined before a replacement is
  promoted. An expected historical runtime id must never be relabeled with
  different bytes.
- After promotion on POSIX, directories are set to `0555`, ordinary files to
  `0444`, and the declared CLI entrypoint (`entrypoints.cli.path`) to `0555`.
  Sibling files in the same directory (for example `.map` sources) stay `0444`.

Read-only permissions prevent accidental mutation. They are not a security
boundary against a user with permission to rewrite the Hitch state root.
Integrity is enforced by hashes, not by permission bits alone.

### 4.6 Use and verification

- Every use validates the manifest, declared file set, sizes, executable bits,
  and SHA-256 digests before returning the bundle path.
- Run/eval records store `runtime_id` and manifest digest.
- The Harbor bridge uploads the shared host bundle into each isolated trial
  container. V1 removes duplicate host copies; it does not remove the required
  container upload.
- Before uploading, the bridge re-verifies the canonical digest and the
  on-disk payload hashes against the manifest, and asserts the job-pinned
  `controller_runtime_id` equals the manifest's `runtime_id`. This closes the
  TOCTOU window between the TypeScript-side verification and the container
  upload. The full remote entrypoint path is shell-quoted and control
  characters are rejected, so command-argument boundaries never depend on
  path content safety.
- A missing or corrupt expected runtime produces
  `controller_runtime_integrity_mismatch`; it must not silently fall back to
  the currently installed Hitch version.

### 4.7 Legacy eval records

- Existing `eval_<id>/runtime/` trees remain readable as
  `embedded-runtime-v1`.
- New evals always use `controller-runtime-ref-v1`.
- `hitch eval inspect` reports which storage kind a record uses.
- Hitch does not delete, rewrite, hash-promote, or replace old embedded
  runtimes automatically.
- A future explicit migration/GC command may promote and remove old copies,
  but it is outside this milestone.

## 5. DSH-compatible trajectory storage

### 5.1 Two-plane event model

Run control and agent trajectory are separate persistence planes:

- `events.jsonl` remains Hitch's append-only run-control and compatibility
  streaming log. It records workspace, resolution, process, timeout,
  cancellation, backend, and terminal events.
- `trajectory/.../session.jsonl` is the canonical agent trajectory. It records
  model-visible messages, raw assistant chunks when available, tool
  calls/results, request metadata, and turn/step boundaries.

This separation avoids encoding Hitch scheduling state as fake DSH
conversation events. During the compatibility window, `events.jsonl` may also
contain normalized message/tool projections, but it is not the trajectory
source of truth.

### 5.2 Per-run persistence root

Each run owns a separate DSH-compatible persistence root:

```text
runs/run_<id>/
  request.json
  resolution.json
  manifest.json
  result.json
  events.jsonl
  stdout.log
  stderr.log
  trajectory.ref.json
  trajectory/
    --<normalized-cwd>--/
      <encoded-session-id>/
        session.jsonl
  feedback/
    message-feedback.json
```

Using one persistence root per run prevents collisions if two providers reuse
a native session id while retaining the DSH project/session directory shape.

V1 uses the DSH JSONL backend's supported settings:

```text
compression = none
packChunks = false
```

The first logical line is the immutable session header. Every following line
is one `SessionEvent` JSON object. No Zstandard frames or packed chunk rows are
written in V1.

### 5.3 Compatibility target

Trajectory compatibility is pinned, not inferred from the latest DSH source:

```ts
interface TrajectoryFormatRef {
  family: 'dsh-session'
  version: 0
  contract_commit: '141eb6fef83422698aef7a981029e843e8161534'
  compression: 'none'
  pack_chunks: false
}
```

An implementation PR must re-check the DSH baseline and replace the commit
above if a different exact revision is selected. Hitch must not silently track
DSH `master` or accept an unknown format version.

### 5.4 Session header and events

The header follows DSH's logical storage contract:

```ts
interface SessionHeaderLine {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  seedLength?: number
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}
```

Events follow the DSH envelope:

```ts
interface SessionEvent<T = unknown> {
  type: string
  seq: number
  time: number
  data: T
  ignorable?: true
  sourceEventSeqs?: number[]
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
}
```

Required invariants include:

- Event `seq` starts at `0` and remains contiguous.
- `time` is a non-negative safe-integer Unix epoch millisecond value.
- Turn and step brackets are properly nested and closed.
- A tool result pairs with exactly one tool call in the same step.
- `user/message`, `assistant/message`, and `tool/result` surface metadata is
  valid.
- Unknown Hitch informational events use a namespaced type and
  `ignorable: true`.
- A completed run has no open call, step, or turn.
- A timeout, cancellation, or crash preserves recorded work and appends a
  valid terminal boundary where possible.

### 5.5 Native and projected trajectories

`trajectory.ref.json` records translation fidelity:

```ts
type TrajectoryFidelity = 'native' | 'normalized' | 'minimal'

interface TrajectoryRef {
  schema_version: '1'
  run_id: string
  session_id: string
  provider_session_id?: string
  format: TrajectoryFormatRef
  fidelity: TrajectoryFidelity
  path: string
  sha256?: Sha256
}
```

- `native`: the harness emitted valid DSH `SessionEvent` records. Hitch
  validates and stores them without changing native event fields.
- `normalized`: an adapter had structured provider events and projected them
  into DSH turn/message/tool events. The original provider record remains
  reachable through the normalized event or raw process log.
- `minimal`: the provider exposed only partial or plain-text output. Hitch
  synthesizes the smallest valid turn/step/message trajectory and retains the
  original stdout/stderr logs.

All supported harnesses produce a canonical DSH-compatible trajectory. The
contract is not restricted to `deepseek` and `dsh-evolving`.

### 5.6 Result derivation

- `result.json.output` is the text of the last non-empty assistant message in
  the canonical trajectory.
- Tool-call-only assistant messages and empty text blocks do not overwrite a
  previously observed final text.
- Terminal success requires both process success and successful trajectory
  finalization.
- A trajectory recording failure changes the Hitch result to
  `trajectory_recording_failed` even if the harness process exited with zero.

### 5.7 Compatibility transition

- Existing runs with only `events.jsonl` are reported as
  `legacy-event-log-v1`.
- New runs write both the control log and canonical trajectory.
- Gear `trajectory.query()` must prefer `trajectory.ref.json` and use
  `events.jsonl` only for legacy runs.
- Normalized message/tool events in `events.jsonl` remain available for one
  compatibility release and may be removed only after Gear and other known
  consumers migrate.

## 6. DSH-compatible trajectory feedback

Hitch adopts both DSH feedback concepts without merging them.

### 6.1 Immutable session feedback

`feedback/record` is an append-only, log-only session event containing one
human-authored text remark. It:

- may be emitted while the trajectory is live;
- never enters derived model history;
- is not editable or deletable; and
- is separate from per-message positive/negative feedback.

Post-run feedback must not reopen a finalized session log merely to append a
`feedback/record`; use the sidecar API instead.

### 6.2 Editable message feedback sidecar

```ts
type MessageFeedbackRating = 'positive' | 'negative'
type MessageFeedbackVersion = string

interface MessageFeedbackItem {
  messageId: string
  rating: MessageFeedbackRating
  note?: string
  version: MessageFeedbackVersion
  createdAt: number
  updatedAt: number
}

interface MessageFeedbackRow {
  session: {
    createdAt: number
    cwd?: string
  }
  items: MessageFeedbackItem[]
}
```

The sidecar behavior matches DSH:

- One whole-session row is bound to `{ sessionId, createdAt, cwd }`.
- A lifecycle identity mismatch is treated as absence, preventing a reused
  session id from inheriting stale feedback.
- Forked sessions do not inherit feedback.
- A target must be a non-empty, append-origin `assistant/message` with the
  requested `messageId`.
- `rating` is exactly `positive` or `negative`.
- An optional note must contain a non-whitespace character and is stored
  verbatim. The default maximum is 8192 UTF-8 bytes.
- `ifVersion: null` requests creation and fails if an item already exists.
- Existing items require an exact current version for update.
- A matching-version no-op returns the existing item without changing its
  version or timestamps.
- A material create/update assigns a fresh opaque UUID version. Updates retain
  `createdAt` and never move `updatedAt` backward.
- Delete ignores the supplied version when the item is already absent;
  otherwise it requires the exact current version.
- Updating an item retains first-creation order. Deleting and recreating moves
  it to the end.
- A per-session queue serializes read/compare/write operations in one process.
- The target trajectory is flushed and physically revalidated before a
  sidecar commit, so durable feedback never precedes its target message.
- Sidecar writes are atomic whole-row replacements.

Message feedback is not trajectory content, does not enter model context, and
does not change the trajectory digest.

### 6.3 Public operations

The TypeScript service and CLI share three operations:

```ts
messageFeedback.list({ sessionId })
messageFeedback.put({ sessionId, messageId, rating, note?, ifVersion })
messageFeedback.delete({ sessionId, messageId, ifVersion })
```

Stable business failures are:

- `session-not-found`
- `target-not-found`
- `version-conflict`
- `note-blank`
- `note-too-large`

Storage corruption and I/O failures are infrastructure errors, not business
failure variants.

## 7. Gear and `dsh-evolving` integration

### 7.1 Separate harness identity

The existing `deepseek` adapter and new `dsh-evolving` adapter represent
different revision domains:

- `deepseek`: revision is the DSH implementation itself.
- `dsh-evolving`: revision is a complete harness overlay repository commit;
  the overlay manifest transitively pins an exact DSH revision.

The existing `deepseek` adapter must not build an overlay repository using its
DSH source recipe. `dsh-evolving` requires its own registered definition and
build contract.

### 7.2 Definition contract

The adapter has these capabilities:

```ts
{
  non_interactive: true,
  streaming: true,
  structured_messages: true,
  structured_tool_events: true,
  sessions: true,
  resume: false,
  model_selection: false,
  graceful_cancel: false,
}
```

`model_selection: false` means the overlay fixes the rollout model.
`process()` must reject a non-empty `request.model` with
`capability_unsupported` rather than silently overriding it.

`graceful_cancel: false` means Hitch may terminate the process group, but must
not promise that DSH flushed a complete session tail.

### 7.3 Overlay build contract

Preparing an exact overlay commit must:

1. Validate `harness/manifest.json`, its schema, canonical digest, and artifact
   inventory.
2. Require `dshRevision` to be an exact full commit or exact package version
   plus registry integrity. Branches, tags, ranges, and `latest` are invalid.
3. Verify every declared overlay artifact digest.
4. Reject undeclared files, symlinks, hardlinks, special files, path escape,
   duplicate paths, and case-folding collisions.
5. Install/checkout the pinned DSH dependency and validate its lock/integrity.
6. Materialize the complete overlay as a read-only prepared artifact.
7. Generate a trusted launcher outside the mutation allowlist.

The launcher contract is:

```sh
#!/bin/sh
set -eu

if [ "${1-}" = "--version" ]; then
  exec <pinned-dsh> --version
fi

exec <pinned-dsh> \
  --profile headless \
  --patch "<artifact>/harness.cordis.yml" \
  --events jsonl \
  "$@"
```

`--patch` must precede the first headless app flag because the DSH launcher
stops parsing top-level flags at the first app-owned flag.

### 7.4 Adapter process contract

- The launcher owns `--profile`, `--patch`, and `--events`; the adapter does
  not duplicate them.
- The task is a positional argument, not stdin.
- Every run gets an isolated `DSH_HOME` under its Hitch run directory.
- `agent_args` uses an explicit allowlist of safe headless app flags.
- The adapter rejects flags that alter profile, patch, event format, model,
  provider, credential, permission, or trusted loader configuration.

### 7.5 DSH stdout NDJSON prerequisite

DSH headless must add `--events jsonl` before Hitch can stream native events
during execution. The direct `deepseek` adapter may still claim post-run native
fidelity when a pinned DSH build flushes its complete isolated session before
exit: Hitch configures raw/unpacked JSONL, validates and redacts that artifact,
then imports it as canonical plus provider evidence. The live wire contract is:

```ts
type DshHeadlessRecord =
  | {
      schema_version: 1
      kind: 'session'
      session_id: string
    }
  | {
      schema_version: 1
      kind: 'event'
      session_id: string
      event: SessionEvent
    }
```

Requirements:

- stdout is a strict one-object-per-line framing channel.
- Human-readable diagnostics and errors go to stderr.
- The session record appears before the first event for that session.
- Every event carries the session id and preserves native `seq`, `time`,
  `type`, `data`, and surface metadata.
- Plain headless mode continues to print only the final text for compatibility.
- A happy-path fixture compares the stdout `(type, seq)` stream with the
  persisted DSH session.
- A timeout fixture proves that already emitted events remain consumable.

The implementation must not infer native trajectory data by scanning DSH
session files by mtime.

### 7.6 Local safe-declarative evaluation

Gear V1 may evaluate a safe-declarative candidate through local Hitch runs:

```text
hitch resolve dsh-evolving@git+file://<harness-repo>#<full-sha> --json
hitch prepare dsh-evolving@git+file://<harness-repo>#<full-sha> --json
hitch run \
  --harness dsh-evolving@git+file://<harness-repo>#<full-sha> \
  --workspace-mode worktree \
  --cwd <immutable-seed-workspace> \
  --prompt-file <task-prompt> \
  --output jsonl
```

Gear saves champion and candidate resolutions separately. Their identities
must be different. Every run's actual revision identity is compared with its
role's expected identity; a mismatch fails the round.

Hitch is authoritative for resolution, prepared artifact, workspace,
trajectory, and terminal result. `RefineService` remains authoritative for
verifier execution, score, held-out evidence, and promotion decision.

### 7.7 Executable candidate evaluation

An executable candidate does not enter Harbor until one complete transport
path is implemented and pinned:

1. Push the candidate to the adapter's registered remote and resolve the exact
   remote commit inside each trial container; or
2. Upload a validated offline source/artifact/controller bundle with exact
   identities and platform compatibility; or
3. Extend the Harbor agent to receive a host-prepared artifact rather than
   resolving and preparing the candidate again inside the container.

Removing the `git+file` input guard alone is insufficient because the
container still cannot access the host repository.

For Gear comparisons, any errored/cancelled trial, missing reward, missing
result, or revision identity mismatch makes the comparison failed. It must not
be treated as a zero-score but otherwise comparable candidate.

## 8. Strict TypeScript migration

### 8.1 Scope

The following move to TypeScript:

- `src/`
- `test/`
- `test-support/`
- `scripts/`
- the CLI entrypoint

`integrations/harbor/hitch_harbor_agent.py` remains Python because Harbor's
custom agent API is Python. It is an explicit cross-language integration
boundary, not incomplete migration.

### 8.2 Compiler and source policy

- ESM output.
- `module` and `moduleResolution` use `NodeNext`.
- `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes` are enabled.
- No implicit `any`.
- External JSON, provider events, CLI input, and process output enter as
  `unknown` and pass runtime validation before narrowing.
- Cross-boundary identifiers use branded string types where practical.
- Public JSON wire fields retain existing snake_case names unless a schema
  version explicitly changes them.
- Internal domain objects may use camelCase.
- Error codes and exit codes remain stable typed vocabularies.

### 8.3 Build and package layout

```text
src/**/*.ts
test/**/*.test.ts
scripts/**/*.ts
dist/
  bin/hitch.js
  src/**/*.js
  scripts/**/*.js
```

- `tsc` emits to `dist/` with source maps.
- `dist/` is not committed.
- npm `bin.hitch` points to `dist/bin/hitch.js`.
- The published package includes compiled runtime files, JSON schemas, the
  Harbor Python bridge, README, and license.
- It excludes TypeScript source, tests, fixtures, and development dependencies.
- V1 keeps zero runtime npm dependencies so the controller runtime payload is
  self-contained after compilation.
- `typescript` and `@types/node` are development dependencies.
- `package-lock.json` is committed and CI uses `npm ci`.

### 8.4 Proposed module boundaries

```text
src/
  domain/                 branded ids, wire types, runtime validators
  revisions/              harness reference parsing and resolution
  artifacts/              prepared harness artifact store
  controller-runtime/     controller bundle hashing/cache/verification
  trajectories/           DSH session projection and persistence
  feedback/               lifecycle-bound message feedback sidecar
  adapters/               provider-specific launch and translation
  workspaces/             isolated workspace lifecycle
  runs/                   run orchestration and control events
  evals/                  evaluation records
  backends/harbor/        Harbor config/result integration
  daemon/                 local authenticated queue
  cli/                    commands and rendering
```

This is a dependency direction, not a requirement to create one file per
folder. Domain types and pure validators must not import CLI, daemon, backend,
or filesystem orchestration modules.

### 8.5 CI and release

CI runs on Node 22 and 24 on Linux and macOS:

```text
npm ci
npm run typecheck
npm run build
npm test
npm run coverage
npm pack --dry-run
```

Release validation runs only from compiled output after `npm ci` and build.
The packed artifact is installed into a temporary prefix and smoke-tested with:

```text
hitch --version
hitch list --json
hitch eval doctor --json
```

The Harbor bridge is syntax-checked with Python and tested against the compiled
runtime layout used inside `/opt/hitch`.

## 9. Schema and compatibility policy

The global Hitch schema version must not be bumped solely because the
implementation language changes. New independently versioned schemas are
introduced for:

- controller runtime manifest/reference;
- trajectory reference;
- DSH-compatible trajectory format binding; and
- message feedback sidecar.

A breaking change to an existing public request/result/event shape requires a
global schema-version decision and migration note.

Readers must distinguish at least:

```text
Eval runtime:
  embedded-runtime-v1
  controller-runtime-ref-v1

Run trajectory:
  legacy-event-log-v1
  dsh-session-v0
```

Compatibility readers may support old records indefinitely. Writers emit only
the new format after the relevant milestone lands. Hitch never silently
rewrites historical evidence during inspect/list operations.

## 10. Implementation plan

### Phase 0: Pin baselines and fixtures

- Record exact Hitch, Gear, and DSH commits in both implementation PRs.
- Re-check DSH session types and headless CLI against the selected commit.
- Add a deterministic mock model, known tool-call fixture, and minimal overlay
  repository fixture.
- Ensure every source link in the design resolves at the target checkout.

### Phase 1: TypeScript equivalence migration

- Add TypeScript config, lockfile, build, typecheck, test, coverage, and pack
  workflows.
- Migrate code without changing CLI or persistence behavior.
- Keep all existing tests passing against compiled output.
- Verify the existing npm and Harbor runtime layouts before proceeding.

### Phase 2: Controller runtime cache

- Add runtime manifest, canonical hashing, validation, locking, staging,
  promotion, and read-only permissions.
- Replace eval-local runtime materialization with `runtime.ref.json`.
- Update Harbor config/bridge to consume compiled cached payloads.
- Add legacy eval inspection support.

### Phase 3: Canonical trajectory and feedback

- Split control-event and trajectory persistence.
- Add DSH raw JSONL writer/reader and relational invariants.
- Migrate every adapter to native/normalized/minimal trajectory production.
- Add trajectory refs and final-output derivation.
- Add DSH-compatible message feedback service and CLI.
- Preserve old normalized event streaming for the compatibility window.

### Phase 4: DSH NDJSON prerequisite

- Land DSH `--events jsonl` support against a pinned commit.
- Prove stdout/session-log parity with deterministic fixtures.
- Prove timeout-prefix consumption.

### Phase 5: `dsh-evolving` and Gear local loop

- Register the exact overlay remote/build recipe.
- Add launcher ordering, argument allowlist, isolated `DSH_HOME`, identity, and
  output tests.
- Update Gear `trajectory.query()` to consume `trajectory.ref.json`.
- Validate baseline/candidate identity and EvaluationRecord references.

### Phase 6: Executable candidate Harbor path

- Select and implement one complete container transport path.
- Pin source/artifact/controller identities and platform requirements.
- Tighten eval success criteria for errored/cancelled/missing-reward trials.
- Verify equal images and resource limits for baseline/candidate comparisons.

## 11. Acceptance criteria

### 11.1 Controller runtime

- Two evals from identical Hitch payload bytes reference the same
  `runtime_id`.
- Neither eval directory contains a complete runtime copy.
- Concurrent first use produces exactly one valid cache entry.
- Changing any payload byte or executable bit fails integrity verification.
- A cache bundle is never used as a writable cwd, runtime home, or workspace.
- A corrupt expected historical bundle never falls back to another Hitch
  version.
- Harbor executes the exact cached compiled runtime and records its id.

### 11.2 Trajectory

- Every new run has a readable `trajectory.ref.json` and DSH-compatible raw
  `session.jsonl`.
- Header identity and physical path agree.
- Sequence numbers are contiguous from zero.
- Turn/step and tool call/result invariants pass on success, failure, timeout,
  and cancellation fixtures.
- DSH native records survive without field loss.
- Non-DSH adapters retain raw provider evidence and report fidelity.
- `result.output` equals the final non-empty assistant text.
- A trajectory write/finalization failure cannot produce a successful Hitch
  result.

### 11.3 Feedback

- Only valid append-origin assistant messages can be targeted.
- Sidecar identity fences session-id reuse and does not copy on fork.
- Same-version concurrent updates have at most one material success.
- No-op, retry, version-conflict, delete-absent, note validation, ordering, and
  timestamp semantics match DSH.
- Feedback does not alter trajectory bytes, derived model history, or output.

### 11.4 Gear integration

- `hitch list --json` exposes both `deepseek` and `dsh-evolving`.
- Overlay build rejects mutable DSH refs, invalid digests, undeclared files,
  symlinks, and unsafe paths.
- Launcher `--version` and flag ordering match the pinned DSH CLI.
- `dsh-evolving` rejects model and protected argument overrides.
- A controlled native run records exactly one session, at least one non-empty
  assistant message, and strictly paired fixture tool events.
- Actual overlay digest, DSH revision, Hitch revision identity, and expected
  Gear identity all match.
- Failed/timed-out rollout, missing verifier evidence, or identity mismatch
  cannot yield an acceptable candidate.

### 11.5 TypeScript and release

- Strict typecheck passes with no implicit `any`.
- Existing public CLI behavior remains covered during the equivalence phase.
- Node 22/24 and Linux/macOS CI pass.
- Coverage remains at or above the existing thresholds.
- `npm pack` contains compiled runtime files and no tests or TypeScript source.
- A temporary global install passes CLI and Harbor runtime smoke tests.

## 12. Open decisions and blockers

The following are intentionally unresolved and block their corresponding
implementation phase:

1. **Registered overlay repository URL.** `dsh-evolving` cannot ship a commit
   recipe until the real overlay repository and build entrypoint are fixed.
2. **Pinned DSH live-event PR.** Current DSH headless prints final plain text;
   live native event streaming and stdout/session parity still depend on an
   exact merged `--events jsonl` commit. Post-run provider-native import is not
   blocked because rc.7 flushes its isolated durable session before exit.
3. **Executable candidate Harbor transport.** Select registered remote,
   validated offline bundle, or host-prepared artifact transfer before
   executable candidates enter Harbor.
4. **Compatibility removal release.** Do not remove normalized message/tool
   projections from `events.jsonl` until Gear and every known consumer read the
   canonical trajectory ref.

The following V1 choices are decided by this spec:

- DSH compatibility means logical session schema, path encoding, relational
  invariants, and feedback semantics. V1 uses DSH's official raw JSONL mode
  instead of reproducing default Zstandard/packed-chunk bytes.
- Every supported harness produces a DSH-compatible canonical trajectory;
  fidelity is explicit rather than making the format DeepSeek-only.
- The TypeScript migration covers the Node codebase. The Harbor custom agent
  remains an explicit Python integration boundary.

## 13. References

- [Current Hitch design](design.md)
- [Current Hitch eval design](evals.md)
- [Current Hitch workspace design](workspaces.md)
- [Gear DSH self-evolving harness spec](https://github.com/rsi-gear/gear/blob/main/docs/dsh-self-evolving-harness-spec.md)
- [Gear Hitch to DSH integration design](https://github.com/rsi-gear/gear/blob/main/docs/hitch-dsh-integration.md)
- [DSH session event types at the reviewed commit](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/core/session/src/types.ts)
- [DSH JSONL persistence at the reviewed commit](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/session/session-persistence-jsonl/README.md)
- [DSH message feedback at the reviewed commit](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/feedback/message-feedback/README.md)
- [DSH headless runner at the reviewed commit](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/bundle/headless/src/index.ts)
