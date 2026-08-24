# Harbor-backed agent evals

Hitch can evaluate one immutable harness candidate against a Harbor dataset:

```bash
hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --model openai/gpt-5.6 \
  --attempts 1 \
  --max-concurrent 4 \
  --timeout 15m \
  --setup-timeout 30m
```

## Setup and diagnostics

Hitch can install its pinned Harbor version into its own state directory:

```bash
hitch eval setup harbor
hitch eval doctor
```

Setup requires Python 3.12 or newer and creates an isolated virtual environment
at `~/.hitch/tools/harbor-0.21.0`. It does not modify system Python and does not
install or start Docker. Useful setup options are:

```bash
hitch eval setup harbor --version 0.21.0 --python /path/to/python3.12
hitch eval setup harbor --force
hitch eval setup harbor --json
```

Doctor is read-only. It reports Python compatibility, the selected Harbor
executable/version, Docker CLI and daemon status, and the names (never values)
of recognized provider credentials. Missing credentials are a warning because
some evals use local models; missing Python, Harbor, or Docker is an error.

Managed Harbor discovery is automatic. Selection precedence is `--harbor`,
`HITCH_HARBOR_PATH`, the managed installation, then `harbor` on `PATH`.
`HITCH_PYTHON_PATH` and `HITCH_DOCKER_PATH` can override diagnostic/setup tool
discovery.

## Execution boundary

```text
Hitch eval engine
  -> resolve immutable harness revision
  -> for local Git, build and verify an exact-commit object pack
  -> generate Harbor JobConfig
  -> harbor run --config ... --yes
       -> create one Docker task environment per trial
       -> load HitchHarborAgent in the Harbor process
       -> upload the minimal Hitch runtime into the task container
       -> upload, re-verify, and materialize the local Git pack when present
       -> Hitch prepare + Hitch run in /app (shared workspace)
       -> selected native harness edits the task filesystem
       -> export the complete run bundle before container teardown
       -> Harbor verifier computes rewards
  -> verify and atomically publish each bundle under runs/<run-id>/
  -> attach verifier output/observation and aggregate run_id references
```

The bridge deliberately does not map `codex` to Harbor's built-in Codex agent.
Doing that would bypass Hitch's resolver, artifact preparation, adapter, event
translation, and revision identity checks. Instead, Harbor sees one custom
`hitch` agent and Hitch starts the selected native harness inside the trial
container.

Harbor already isolates every trial in a disposable Docker environment, so
Hitch evals match Harbor's built-in unattended execution behavior: Codex gets
`--dangerously-bypass-approvals-and-sandbox` and OpenCode gets
`--dangerously-skip-permissions`. These are native agent flags; the benchmark
instruction is passed through unchanged. Explicit `--agent-arg` values are
preserved, and an explicitly supplied bypass flag is not duplicated.

The outer Harbor agent timeout is the Hitch timeout plus a 30-second cleanup
window. Harbor's agent setup timeout is configured separately because it may
need to install Node.js 22 and prepare the selected harness revision.

## Inputs and portability

The eval surface supports one candidate and the Docker Harbor backend. A harness
may use an exact published version, a commit from Hitch's registered remote, or
an exact commit from a clean local Git repository:

```bash
hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness 'deepseek@git+file:///absolute/path/to/repo#0123456789abcdef0123456789abcdef01234567'
```

Local transport requires an explicit absolute `git+file://` source and a full
lowercase 40-character SHA-1 or 64-character SHA-256 commit OID. Abbreviations,
branches, tags, `HEAD`, dirty repositories, and `@installed` are rejected before
Harbor starts. Ordinary local `resolve`, `prepare`, and `run` remain compatible
with abbreviated commit IDs.

Hitch packs only the selected commit object and the trees/blobs needed to check
out that commit. Uncommitted files, unrelated refs and history, `.git/config`,
hooks, credentials, and host paths are not included. The payload is size-limited
and SHA-256 verified on the host before handoff and again inside every trial.
The container prepares from a private shallow Git source while retaining the
host resolver's canonical revision identity; it never fetches the candidate
from the original local path or registered remote.

Deployment policy may lower the defaults with
`HITCH_LOCAL_GIT_MAX_BYTES`, `HITCH_LOCAL_GIT_MAX_OBJECTS`,
`HITCH_LOCAL_GIT_MAX_FILES`, and `HITCH_LOCAL_GIT_MAX_FILE_BYTES`. Values are
positive integers; defaults are 512 MiB, 100,000 objects, 50,000 files, and
64 MiB per blob respectively.

Dataset values must select an immutable revision and use Harbor conventions:

- `terminal-bench@2.0` selects a Harbor registry dataset;
- `org/package@ref` selects a Harbor package dataset; and
- an existing local directory is passed to Harbor as a local dataset path.

Common provider credential variables are passed to Harbor as `${NAME}`
references, not copied as secret values into `job.json`. Extra variables can be
allowed explicitly with repeated `--pass-env NAME` options.

## Records

Each eval is stored at `~/.hitch/evals/eval_<id>/` (or below `--root`):

```text
request.json
resolution.json
plan.json
runtime.ref.json
local-source/                 # present only for transported local Git commits
  manifest.json
  payload.pack
  resolution.json
events.jsonl
result.json
harbor/
  job.json
  stdout.log
  stderr.log
  job/result.json
```

`result.json` includes the benchmark identity and one `run_id` reference per
trial. Every referenced run is published through the ordinary
`runs/<run-id>/` layout, including provider-native evidence, canonical
trajectory, verifier output, and a valid/invalid observation. Invalid trials
are reported separately and never converted into zero reward. `summary`
aggregates only valid observations; `backend_summary` preserves Harbor's raw
aggregate for diagnostics.

The exported bundle below a Harbor trial is staging only. Hitch validates its
identity and trajectory checksums, atomically publishes it to `runs/`, and then
removes the staging copy so the eval directory never becomes a second
trajectory authority.

For a local Git eval, `plan.json` and `result.json` also record the commit, tree,
host resolution identity, payload SHA-256, byte count, object count, and file
count. These durable records never depend on the container's temporary path.
The untouched Harbor `result.json` remains authoritative for backend-specific
detail.

Use `hitch eval list [--json]` to list records and
`hitch eval inspect <eval-id> [--json]` to inspect the complete Hitch envelope.
Run records can be queried with `hitch runs list`, and strict model or harness
comparisons are available through `hitch compare model|harness` with benchmark,
task, model, harness, eval, status, and time filters.
