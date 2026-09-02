# Standard benchmark packages

Implemented scope: local Package v1 loading, validation and content locking;
explicit task enumeration; Harbor 0.21 execution with real Hitch harnesses;
`tool-server@1`, native terminal tasks, and a trusted no-tools model-call driver.
The terminal driver retains upstream collect hooks, task budgets, resource limits
and shared/separate verifier behavior. Its grader accepts Harbor reward JSON or
text with JSON-first precedence. Standard command graders require reward JSON.

Independent producers are available under `benchmark-packages/automationbench`,
`harbor-source` (Terminal-Bench 4.0 and Science 0.1), `gdpval` (public weighted
rubric), and `hle` (authorized public data, separate no-tools/with-tools profiles).
Implementation and real execution coverage are separate: see
`benchmark-expansion-status.json` for fixed samples, attempts and blockers.
OSWorld 2.0 requires its matching gated tasks/assets and VM integration;
CursorBench requires its authorized task/grader package. Neither has a validated
integration. Full Eval V2, report/regrade and remote package execution remain
later work.

## Commands

```sh
hitch benchmark validate --package /absolute/package
hitch benchmark lock --package /absolute/package
hitch eval run --benchmark /absolute/package \
  --harness codex@version:0.145.0 --model gpt-5.4
# A portable lock lives beside benchmark.toml and the complete package:
hitch eval run --benchmark-lock /absolute/package/benchmark.lock.json \
  --harness codex@version:0.145.0 --model gpt-5.4
```

Source conversion is optional and separate from Hitch. An author can directly
write a package. `benchmark-packages/automationbench/import.mjs` is one independent
producer; adding a producer does not change core dispatch or package allowlists.

The package requires `benchmark.toml`, `source-manifest.json`, its selected
profile, and the explicit `tasks/` membership. Each task requires original
instruction, Harbor configuration, `task.hitch.json`, Compose environment and
separate verifier. Shared runtime files and tool schemas use package-relative
paths. Schemas are published under `docs/schemas/benchmark-*.schema.json`.

Validation rejects unknown required fields/capabilities, missing hooks, missing
metrics, duplicate IDs, mismatched membership, floating Docker base images,
special files and symlinks. The bounded TOML reader accepts strings, numbers,
booleans, arrays, inline tables and table headers; unsupported TOML syntax fails
explicitly. The execution subset is Linux/amd64, single-step Harbor 1.4, a
Compose tool sidecar and a separate verifier. Harbor's existing task inspector
also validates environment resources before the candidate starts.

The profile declares open network access (`network: "open"`, Harbor `public`).
Model-only network enforcement, desktop/no-tools profiles, other transports,
daemon and remote package scheduling fail rather than silently degrade. Budget
defaults come from each task; an explicit `--timeout` is recorded as an override.
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
  and named primary metric. V1's `reward` is assigned from this mapping.

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
tool and metric names, validates/locks it, and runs the same driver, hooks,
snapshot and grading path. The score must be one, proving the tool was called.
Real AutomationBench trials are a separate explicit canary. Their measured
results and exact execution identities belong in the acceptance record.
