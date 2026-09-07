# Standard benchmark packages

Implemented scope: local Package v1 loading, validation and content locking;
explicit task enumeration; Harbor 0.21 execution with real Hitch harnesses;
`tool-server@1`, native terminal tasks, and a trusted no-tools model-call driver.
The terminal driver retains upstream collect hooks, task budgets, resource limits
and shared/separate verifier behavior. Its grader accepts Harbor reward JSON or
text with JSON-first precedence. Standard command graders require reward JSON.

Independent producers are available under `benchmark-packages/automationbench`,
`harbor-source` (Terminal-Bench 4.0 and Science 0.1), `gdpval` (public weighted
rubric), `hle` (authorized public data, separate no-tools/with-tools profiles),
and `osworld`. AutomationBench emits a self-contained ordinary Harbor dataset
directly. Every current Package v1 producer is normalized by the same
`hitch benchmark compile` boundary into that dataset form. Gear runs only the
compiled `--dataset`; it does not select a benchmark verifier or execute Package
v1 itself. Implementation and real execution coverage are separate: see
`benchmark-expansion-status.json` for fixed samples, attempts and blockers.
CursorBench remains excluded because its authorized task/grader package is not
available. Generic native-phase execution and artifact-only regrading are
implemented; remote Package v1 execution remains unsupported. The
[implementation spec](hitch-benchmark-eval-spec.zh-CN.md) records the current
boundaries and verified regrades.

## Commands

```sh
hitch benchmark validate --package /absolute/package
hitch benchmark compile --package /absolute/package --out /absolute/compiled-dataset
hitch eval run --dataset /absolute/compiled-dataset \
  --harness codex@version:0.145.0 --model gpt-5.4
```

`hitch eval run --benchmark` and `--benchmark-lock` remain local compatibility
entry points. They compile with the same standard compiler internally before
entering eval execution. New Gear integrations must use the explicit compile +
`--dataset` flow. `benchmark compile` refuses to overwrite its output directory.
Standard datasets retain each task's agent time budget unless `--timeout` is
explicitly supplied. Both entry points enforce the compiled task's candidate
requirements: no-tools tasks require the trusted `model-call` harness without
agent overrides, and native-image agent tasks require the image-capable Codex
harness.

Source conversion is optional and separate from Hitch. An author can directly
write a package or a standard Harbor dataset. Adding a producer does not change
core dispatch or package allowlists.

The AutomationBench producer emits task-owned simulator sidecars and task-owned
verifiers. The candidate container receives only the public tool client/schema;
the simulator state is collected as a sidecar artifact after the agent exits and
is never mounted into the candidate. Its adapter manifest binds the upstream
revision, adapter revision, scoring contract, task trees, and complete dataset
digest. `task_completed_correctly` becomes `total_score`; `partial_credit`
becomes optional `process_score` with sanitized assertion components. It has no
native feedback channel.

All currently runnable benchmark adapters use this score mapping:

| Benchmark | Standard input | `total_score` source | `process_score` | `feedback` |
| --- | --- | --- | --- | --- |
| AutomationBench | direct dataset | `task_completed_correctly` | `partial_credit` plus assertion components | unavailable |
| Terminal-Bench 4.0 | compiled Package v1 | `reward` | unavailable | unavailable |
| Terminal-Bench-Science 0.1 | compiled Package v1 | `reward` | unavailable | unavailable |
| GDPval public rubric | compiled Package v1 | `rubric_score` | unavailable | unavailable |
| HLE | compiled Package v1 | `correct` | unavailable | unavailable |
| OSWorld V2 | compiled Package v1 | `native_score` | unavailable | unavailable |

GDPval's `strict_success` remains an auxiliary raw metric; it is not a process
score. OSWorld's fractional `native_score` is the official final scalar and is
therefore a total score, not a process score. The compiler never fabricates a
missing optional channel.

The package requires `benchmark.toml`, `source-manifest.json`, its selected
profile, and the explicit `tasks/` membership. Each task requires original
instruction, Harbor configuration and `task.hitch.json`. Tool-server tasks use
a Compose environment and separate verifier; terminal tasks retain their
upstream environment and shared/separate verifier configuration. Trusted
model-call tasks use a canonical input and final-response export. Shared runtime
files and tool schemas use package-relative paths. Schemas are published under
`docs/schemas/benchmark-*.schema.json`.

Validation rejects unknown required fields/capabilities, missing hooks, missing
metrics, duplicate IDs, mismatched membership, floating Docker base images,
special files and symlinks. The bounded TOML reader accepts strings, numbers,
booleans, arrays, inline tables and table headers; unsupported TOML syntax fails
explicitly. Execution targets Linux/amd64, with terminal, tool-server and
trusted model-call drivers. Tool-server tasks use Harbor task schema 1.4 and
can declare native-phase execution with fresh candidate conversations. Harbor's
existing task inspector also validates environment resources before the
candidate starts.

The profile declares open network access (`network: "open"`, Harbor `public`).
Model-only network enforcement, undeclared transports, daemon and remote package
scheduling fail rather than silently degrade. No-tools execution requires the
trusted `model-call` harness without agent overrides. Native-image agent tasks,
including the desktop transport, currently require the Codex harness. These
driver capabilities do not establish official OSWorld task coverage. Budget
defaults come from each task; an explicit `--timeout` is recorded as an override.
Candidate time and bounded evidence collection are accounted separately.
Sampling and concurrency defaults come from the profile and serial MVP path.

## Lock, execution and evidence

Content identities cover files, POSIX modes, prompt, source map, selected IDs,
tool schemas, shared runtime, gold/graders, dependency locks and Docker build
contexts/base image digests. Host paths and mtimes are excluded. The lock itself
is excluded from package identity. The source adapter and prompt transformations
are recorded when the producer supplies those source references.

Before running, Hitch copies and revalidates the source into its state store,
compiles Harbor tasks, and hashes the compiled tree. Reusing an altered stored
source or task tree fails. Edits to the author's original directory cannot alter
an already sealed run. The eval directory preserves:

- `benchmark/benchmark.lock.json`, `manifest.json`, `effective-profile.json`;
- a reference to the sealed source/compiled package;
- the existing execution plan, candidate revision/runtime identity and run IDs;
- Harbor trial `benchmark-lifecycle.json`, collected snapshot/audit and raw grader files;
- `verifier/benchmark-rewards.json` linking source task ID, task digest, raw metrics
  and named primary metric. The bridge assigns both `reward` and `total_score`
  from this mapping; raw auxiliary metrics remain available for audit.

Hooks run only through the managed worker. They receive the versioned request
on stdin, return one JSON response on stdout, and write diagnostics to stderr.
Request IDs are stable within a trial phase; successful repeats reuse the
response. Failed prepare and cancellation still enter provider cleanup. Main
container shutdown precedes quiesce/snapshot. Invalid hook output or missing
snapshot prevents grading from becoming a valid observation.

The CLI transport is installed by Hitch, accepts tool names and schemas solely
from the package, and validates the prepared binding against the locked schema.
Only the candidate binding and token enter the main container. Tokens and admin
handles are excluded from the lifecycle journal. Required rewards must be finite
numbers in their declared ranges; binary rewards must be exactly 0 or 1. Zero is
valid. Missing/invalid metrics raise errors. The raw upstream rewards remain in
the original grader file even when the generic bridge adds V1's primary alias.

## Credentials

Use existing `--pass-env OPENAI_API_KEY` for API access. To use a Codex ChatGPT
session in an isolated Harbor container, explicitly pass an in-memory
`HITCH_CODEX_AUTH_JSON` value with `--pass-env HITCH_CODEX_AUTH_JSON`. For example,
a Node launcher can read the user's existing `~/.codex/auth.json` and set that
environment value for the child Hitch process. Do not paste it into shell
arguments or a task file.

The Codex adapter accepts this handoff only with Hitch's internal Harbor marker,
writes a mode-0600 file in a private container temporary directory, and points
`CODEX_HOME` there. It is outside the run bundle, workspace and images and is
deleted with the trial container. Nested opaque credentials are included in
the existing output redaction rules. This feature does not modify host login.

## Verification

`npm run check` runs offline contract/regression tests. The Docker contract
canary invokes a deterministic local Git fixture harness and no model:

```sh
node dist/scripts/canary-benchmark.js --fixture
```

It creates a package in a temporary directory with different benchmark/task,
tool and metric names, validates it, compiles it to a standard dataset, and runs
that dataset through the same driver, hooks, snapshot and grading path. Both
`reward` and `total_score` must be one, proving the tool was called and the
standard result contract was preserved.
Real AutomationBench trials are a separate explicit canary. Their measured
results and exact execution identities belong in the acceptance record.
