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
  -> generate Harbor JobConfig
  -> harbor run --config ... --yes
       -> create one Docker task environment per trial
       -> load HitchHarborAgent in the Harbor process
       -> upload the minimal Hitch runtime into the task container
       -> Hitch prepare + Hitch run in /app (shared workspace)
       -> selected native harness edits the task filesystem
       -> Harbor verifier computes rewards
  -> normalize Harbor result.json
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

The first implementation supports one candidate and the Docker Harbor backend.
The harness must use an exact published version or a commit from Hitch's
registered remote source. `@installed` and local `git+file://` refs are rejected:
the host executable or source tree would not describe the same runtime inside a
fresh task container.

Dataset values use Harbor conventions:

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
runtime/
events.jsonl
result.json
harbor/
  job.json
  stdout.log
  stderr.log
  job/result.json
```

`result.json` includes the Harbor executable identity, backend paths, trial
counts, per-reward aggregates, a primary reward, and compact per-trial status.
The untouched Harbor `result.json` remains authoritative for backend-specific
detail.

Use `hitch eval list [--json]` to list records and
`hitch eval inspect <eval-id> [--json]` to inspect the complete Hitch envelope.
