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

## Shared daemon control plane

When several evals share one Docker host, start one Hitch daemon and submit the
evals through it. Runs and Harbor trials then use the same vector resource
ledger; the daemon lowers each eval's effective Harbor parallelism to the
currently available CPU, memory, and container capacity instead of allowing
independent `--max-concurrent` values to oversubscribe the host.

`npm run canary:resource-load` is the fixed-machine admission and crash-cleanup check. By
default it requires a 10-CPU, nominal 8-GiB Docker VM and launches 20 real
containers with 2-CPU/4-GiB hard limits through a requested parallelism of
eight. The command fails unless admitted and actually running concurrency both
peak at two, no container is OOM-killed, the ledger returns to zero, and the
lease-fenced reaper removes every owned container and network. Override its
machine/trial inputs with `HITCH_LOAD_CANARY_EXPECT_CPUS`,
`HITCH_LOAD_CANARY_EXPECT_MEMORY_MIB`, `HITCH_LOAD_CANARY_TRIALS`,
`HITCH_DOCKER_CANARY_BASE`, and `HITCH_DOCKER_PATH`.

`npm run canary:harbor-load` exercises the same fixed-capacity policy through
the full managed-Harbor path. It creates 20 offline local tasks and an immutable
local fake Pi harness, requires exactly two admitted and running trial
containers, one shared environment build followed by 19 cache hits, no OOM or
resource leak, cleanup within 60 seconds, and a verified result bundle for
every valid trial. One valid trial deliberately earns zero and one trial
deliberately omits verifier reward evidence; the report proves the real zero is
retained while the invalid trial is excluded from reward aggregation. The
Harbor executable and pinned local Node base may be overridden with
`HITCH_HARBOR_LOAD_CANARY_PATH` and `HITCH_HARBOR_LOAD_CANARY_BASE`. The
offline final image also uses a preloaded support base containing Git; override
it with `HITCH_HARBOR_LOAD_CANARY_SUPPORT_BASE`.

```bash
hitch daemon start \
  --max-concurrent 8 \
  --capacity-cpu-millis 8000 \
  --capacity-memory-mib 16384 \
  --container-slots 8 \
  --capacity-gpus 2 \
  --eval-gpus 1 \
  --capacity-ephemeral-disk-mib 32768 \
  --eval-ephemeral-disk-mib 4096

# Submit and wait for the terminal result.
hitch eval run --daemon \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --max-concurrent 8

# Or decouple submission from observation.
hitch eval submit \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --max-concurrent 8 \
  --provider local-docker \
  --cpu-per-trial 2 \
  --memory-per-trial 4GiB \
  --build-mode prebuild-preferred \
  --model-capture native \
  --idempotency-key nightly-terminal-bench
hitch eval watch eval_<id>
hitch eval cancel eval_<id>
```

The idempotency key is scoped to the Hitch state root. Reusing it with the same
normalized request returns the original eval ID; reusing it with a different
request fails with `idempotency_conflict`. A direct Harbor eval is rejected
while a daemon owns the same root so it cannot bypass the shared quota. Use a
separate `--root` when deliberate isolation is required.

When any execution-policy option is present, the CLI reads the daemon's
current `resource_policy.eval_trial` from `/health`, overlays the explicit
CPU/memory values, and submits the resulting complete immutable policy. CPU is
an integer number of cores; memory accepts `B`, `KiB`, `MiB`, or `GiB` and must
resolve to a whole number of MiB. These options require `--daemon` or
`eval submit`; direct mode rejects them rather than pretending to enforce a
control-plane policy.

The local provider uses conservative logical reservations when task metadata
does not declare resources. For known local tasks, validated task/Compose
limits and sidecars form the admitted reservation, and the generated Harbor
overlay applies representable CPU, memory, GPU and ownership settings to the
controlled Docker services. Runtime observation and explicit unavailability
are sealed in `execution.json`.

Host-side proxy/hybrid capture never opens a wildcard listener. macOS and
Windows bind to loopback; Linux inspects Docker's `bridge` network and binds to
that specific host gateway so trial containers can reach it without exposing a
public interface. Deployments with a different Docker network may set
`HITCH_MODEL_PROXY_BIND_HOST` and `HITCH_MODEL_PROXY_ADVERTISED_HOST`, but the
bind value must be a concrete IP address; `0.0.0.0` and `::` are rejected.
Required capture fails closed when no safe reachable binding is available,
while optional capture records its existing degradation path.

Windows Node 22/24 is a supported host path for CLI/daemon operation, harness
preparation and normal execution. Batch shims are launched through escaped
`cmd.exe` arguments and executable discovery honors `PATHEXT`. Live reattach
to an already-running local Harbor process after a daemon hard crash remains a
POSIX-only capability; on Windows the persisted lease/result evidence still
drives the typed lost, collect-only and explicit rerun paths instead of an
automatic ambiguous Candidate replay.

For GPU trials, Docker must already expose NVIDIA devices to containers. Set
both daemon capacity and per-trial GPU count explicitly; fixed task/Compose
counts are admitted and the final Harbor overlay emits the matching device
reservation. Dynamic requests and `all` fail closed, and a non-GPU host stays
compatible because no device request is written when the count is zero.

Known local task work items enter a shared deficit round-robin dispatcher.
Capacity is acquired atomically per work item, the dispatcher rotates after
each grant, and a temporarily blocked task mutex does not prevent another task
from the same eval from running. A newly submitted small eval therefore gets a
released slot within a bounded round instead of waiting for a large eval to
finish all of its tasks. Opaque datasets retain one conservative coarse
allocation because their work-item identities are not known before Harbor
starts.

For a local dataset with enumerable `task.toml` entries, daemon mode writes an
immutable `execution-plan.json` and runs one Harbor work item per task/attempt.
Different tasks can use the admitted slots concurrently; attempts of the same
task are ordered and never overlap in the local Docker collision domain.
Registry/package datasets whose membership cannot be enumerated keep the
single-Harbor-job compatibility path and its conservative reservation.

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
  -> lock/look up the target-platform artifact in the host cache
  -> on a miss, prepare it in a dedicated builder container with pinned Node/pnpm
  -> generate Harbor JobConfig
  -> harbor run --config ... --yes
       -> create one Docker task environment per trial
       -> load HitchHarborAgent in the Harbor process
       -> upload the minimal Hitch runtime into the task container
       -> install/select the exact pinned Node runtime
       -> upload and re-verify the dedicated-builder harness artifact
       -> Hitch run in the task environment's effective WORKDIR (shared workspace)
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
window. Harbor's agent setup timeout is configured separately because a task
image may need the exact pinned Node.js runtime installed before artifact use.

Every eval prepares the selected immutable harness outside benchmark task
containers. Hitch uses a dedicated Docker builder based on exact Node.js
`22.23.0`, installs exact pnpm `10.17.1`, and stores the result in the host-side
content-addressed cache. The Harbor job pins its artifact ID, revision identity,
entrypoint/content digests, source type, platform, and Node version; every trial
receives the verified directory and runs it without contacting a package
registry or invoking a package manager. The task container recomputes the
uploaded artifact integrity before execution.

The builder platform comes from each task environment's planner-owned
trial-runtime contract, never from the controller host. The task inspector
records an explicit Compose `services.main.platform`; otherwise the planner's
default target is `linux/amd64`. Contracts are grouped by Docker platform,
artifact platform, and exact Node version. Hitch prepares one artifact per
distinct contract before dispatch, writes the complete `prepared_artifacts`
mapping into the eval plan, and pins `artifact_id` plus `runtime_contract` on
every work item. Different task images share an artifact only when they expose
the same runtime ABI. `linux/amd64` maps to `linux-x64`, while `linux/arm64`
maps to `linux-arm64`; both currently use Node `v22.23.0`.

Prepared artifacts are not assumed to be cross-platform `node_modules`
trees. The cache key covers the locked harness revision, controller runtime
(and therefore the adapter/recipe), builder image identity, target platform,
exact Node.js version, and exact pnpm version. A host file lock elects one
dedicated builder on a miss; concurrent and later jobs wait for and reuse the
atomic entry under `<HITCH_ROOT>/store/harbor-artifacts`. A trial that observes
an incompatible artifact fails closed with `hitch-artifact-platform`; there is
no trial-side `hitch prepare` fallback.

Clone, package-manager install, and compilation run on the builder container's
native Linux filesystem. Only after preparation succeeds does Hitch export the
completed content-addressed artifact with `docker cp`, verify it on the host,
and promote it atomically. This avoids changing package-manager filesystem
semantics through a Docker Desktop host bind mount and prevents partial builds
from entering the host artifact store.

The target-platform cache is explicit host state, so Harbor may still use
`environment.delete: true`; deleting a trial container does not delete the
cached artifact. Hitch does not expose the cache as a shared writable trial
mount. `HITCH_HARBOR_BUILDER_BASE_IMAGE` may select an approved equivalent base
image; it cannot override the planner-selected platform. Platform, Node, pnpm,
builder image, controller runtime, and harness revision remain part of the
verified cache contract.

Harbor's Python agent/environment/verifier bridge modules are part of the same
controller-runtime allowlist as the compiled Hitch CLI. Their bytes therefore
participate in `runtime_id`, and Harbor imports them from the eval-pinned
read-only runtime directory. Editing `integrations/harbor` in the working tree
after an eval starts cannot change bridge code used by work items that have not
started yet.

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
and SHA-256 verified on the host and again inside the dedicated builder. The builder prepares
from a private shallow Git source while retaining the host resolver's canonical
revision identity; trials receive only the completed artifact and never fetch
the candidate from the original local path or registered remote.

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
allowed explicitly with repeated `--pass-env NAME` options. The Harbor bridge
passes the same names—not their values—to the inner Hitch run. Values are
resolved only from that process environment and are removed from provider
capture, trajectory, result, event and diagnostic evidence before persistence;
Harbor host stdout/stderr use the same bounded streaming redactor.

For remote workers, offers and content-addressed work specs likewise contain
only credential names. A worker can fetch values only after accepting the exact
offer, through a worker-authenticated endpoint fenced by generation, lease ID
and epoch. The response is a short-TTL `no-store` envelope; the packaged runner
keeps it in process memory, overlays it on the Harbor execution environment,
and clears the map when execution settles. Credential envelopes are not events,
input artifacts, result artifacts, or persistent worker state.

## Records

Each eval is stored at `~/.hitch/evals/eval_<id>/` (or below `--root`):

```text
request.json
submission.json               # daemon admission envelope and request digest
control.json                  # queued/running/cancelling/terminal control state
resolution.json
plan.json
execution-plan.json           # immutable slots, work items, resource reservations
leases/                       # per-work-item worker/resource lease history
runtime.ref.json
local-source/                 # present only for transported local Git commits
  manifest.json
  payload.pack
  resolution.json
events.jsonl
progress.json                 # running, atomically replaced after each published trial
result.json
harbor/
  job.json                         # attempts=1 compatibility layout
  attempt-0001/                    # attempts>1: one n_attempts=1 shard per logical attempt
    job.json
    stdout.log
    stderr.log
    job/result.json
```

Every sealed run bundle also contains `bundle.index.json`, which lists the
canonical relative path, role, size, and SHA-256 digest of every retained file.
`verifyResultBundleIndex` detects later file mutation, addition, or removal.

`result.json` includes the benchmark identity and one `run_id` reference per
trial. Every referenced run is published through the ordinary
`runs/<run-id>/` layout, including provider-native evidence, canonical
trajectory, verifier output, and a valid/invalid observation. Invalid trials
are reported separately and never converted into zero reward. `summary`
aggregates only valid observations; `backend_summary` preserves Harbor's raw
aggregate for diagnostics.

Some shell verifiers mask bootstrap failures by writing `reward.txt = 0` after
an earlier DNS, network, dependency-install, or test-runner failure. Hitch
conservatively reclassifies that result as `verifier_infrastructure_failure`
only when all of the following hold: the reward is exactly zero, no non-empty
CTRF artifact or test-execution marker exists, and bounded Harbor verifier logs
contain a stable infrastructure signature. The sealed run stores
`verifier/infrastructure-error.json`; raw Harbor logs remain in the backend job
directory.

New evals retry verifier bootstrap failures once by default. The retry runs
only `/tests/test.sh` again inside the original live Harbor trial: it does not
recreate or call the Candidate Agent, and therefore grades the exact same
candidate state. Each failed verifier attempt is archived below the Harbor
trial's `verifier/infrastructure-attempts/` directory, while
`infrastructure-retry-history.json` records `candidate_rerun: false` and is
copied into the sealed run. A normal zero reward with CTRF or test-execution
evidence is returned immediately and never retried.

Non-verifier trial infrastructure failures may still require a new physical
trial because no candidate state exists to grade. Verifier failures and missing
verifier results are excluded from that outer retry path, so an exhausted
verifier retry can never silently become a second candidate execution.
Configure the cap with `--infrastructure-retries <n>` and linear backoff with
`--infrastructure-retry-backoff <duration>`; set the retry count to zero to
disable automatic retry. Exhausted verifier retries raise an explicit error,
leave the observation invalid, and return
`eval_infrastructure_retries_exhausted` instead of including a false zero in
the score.

The exported bundle below a Harbor trial is staging only. Hitch validates its
identity and trajectory checksums, atomically publishes it to `runs/`, and then
removes the staging copy so the eval directory never becomes a second
trajectory authority.

While an eval is running, `progress.json` is the authoritative partial trial
membership. Hitch publishes a sealed `runs/<run-id>/` directory before it
atomically replaces progress, so readers never need to inspect Harbor job
directories or run-bundle staging. Terminal `result.json` supersedes progress
and contains the exact same trial set after the final drain, except while an
explicit task rerun is active as described below.

If Harbor records a terminal trial without an exported run bundle, Hitch gives
the atomic bundle marker a two-second readiness grace. Once that grace expires,
it publishes a sealed diagnostic run and advances progress instead of delaying
the invalid trial until the rest of the benchmark finishes.

For a local Harbor dataset, Hitch resolves the canonical top-level task
directories containing `task.toml` before backend launch. `plan.json` records
those task IDs, and the initial `progress.json` records exact `planned_tasks`
and `planned_trials` counts, so partial consumers can render `1/N` coverage as
soon as the first trial settles. Registry-backed datasets leave the counts
`null` until their task membership can be established authoritatively.

## Rerunning invalid tasks

An eval with a frozen local task plan can rerun either every invalid/missing
logical trial or the invalid/missing trials belonging to explicit task names:

```bash
hitch eval rerun <eval-id> --invalid --type candidate-restart --output json
hitch eval rerun <eval-id> --task task-a --task task-b --type candidate-restart --output json
hitch eval rerun <eval-id> --invalid --type candidate-restart --daemon --output json
```

An eval containing daemon `submission.json` is always rerun through the daemon
endpoint. The CLI auto-routes it when the matching daemon is healthy and fails
with `control_plane_required` when that daemon is absent; it never falls back
to the direct rerun implementation. Terminal legacy evals without a submission
envelope retain the direct path.

`--type` is explicit in audit records and defaults to `candidate-restart` for
backward compatibility. Rerun/recovery operations have distinct semantics:

| Type | Candidate | Conversation | Sandbox | Current support |
| --- | --- | --- | --- | --- |
| `candidate-restart` | Executes again from the original instruction | New conversation | Clean environment | Supported |
| `candidate-resume` | Continues an interrupted candidate | Provider-native session | Restored checkpoint | Reserved; rejected until both checkpoint and adapter resume exist |
| `trajectory-replay` | Starts a new physical execution with prior context | Verified canonical trajectory | Restored checkpoint | Reserved; rejected until replay and checkpoint support exist |
| `verifier-only` | Does not execute | None | Original retained environment | Automatic only while the original trial is live |
| `collect-only` | Does not execute | None | None | Reserved for terminal-but-uncollected recovery |

A canonical trajectory is evidence, not a process checkpoint. Feeding it back
to an LLM can reconstruct conversational context, but it cannot restore the
container filesystem, running processes, pending tool calls, credentials, or a
provider-native session. Hitch therefore treats that operation as
`trajectory-replay`, never as transparent `candidate-resume`, and refuses to
perform it unless the source trajectory is verified and the corresponding
sandbox checkpoint can also be restored.

The `candidate-restart` rerun keeps the original eval, benchmark, candidate,
model, timeout, task, and attempt identities, but creates a new physical
Candidate execution. Hitch defines one logical slot for each
`(task_id, attempt)` in the frozen plan. `--invalid` selects all invalid or
missing slots; `--task task-a` selects all invalid or missing attempts for that
task. A named task whose attempts are all valid is rejected.

Verifier infrastructure failures are deliberately not eligible for this
full-trial rerun command. New evals already perform verifier-only retries while
the original environment is live; after that environment is closed, Hitch
returns `eval_verifier_only_rerun_unavailable` rather than rerunning the
Candidate Agent under the guise of regrading the same output.

Harbor 0.21 trial names use opaque random suffixes, so Hitch never derives a
new eval's logical attempt from that suffix. Initial evals execute attempts as
ordered `n_attempts=1` shards and explicitly pass the logical attempt through
the Harbor bridge and importer. Reruns group selected slots by attempt and use
the same execution contract. Valid slots are never selected or overwritten;
each newly valid run atomically replaces only its matching slot in
`progress.json` and receives the verifier's ordinary reward without a retry
penalty.

Hitch 0.2.5 can rerun pre-0.2.5 plans when `attempts=1`. Older multi-attempt
plans do not carry explicit logical-attempt identity and are rejected rather
than repaired by guessing from Harbor trial names.

Rerun audit state is written below `reruns/rerun_<id>/`. `request.json`,
`state.json`, and the command result include `rerun_type` plus explicit
Candidate, conversation, and sandbox semantics. While `state.json`
is `running`, `progress.json` is the current membership and the prior
`result.json` may be stale. When the invocation ends, Hitch regenerates the
top-level result from progress. The eval succeeds only when every planned
task/attempt slot is valid. The JSON envelope retains task-level arrays and
also reports `selected_trials`, `repaired_trials`, and
`remaining_invalid_trials` as `{task_id, attempt}` values.

For a local Git eval, `plan.json` and `result.json` also record the commit, tree,
host resolution identity, payload SHA-256, byte count, object count, and file
count. These durable records never depend on the container's temporary path.
Eval records additionally include `prepared_artifact` with the
artifact/revision identities, integrity digests, source type, and platform;
the machine-local artifact directory appears only in Harbor's `job.json`.
The untouched Harbor `result.json` remains authoritative for backend-specific
detail.

`candidate-restart` selects every invalid logical slot, including
`verifier_infrastructure_failure` and `verifier_result_missing`, because its
declared semantics intentionally execute the Candidate Agent again in a clean
sandbox. The verifier-only guard remains for rerun modes that promise not to
rerun the candidate.

Use `hitch eval list [--json]` to list records and
`hitch eval inspect <eval-id> [--json]` to inspect the complete Hitch envelope.
Run records can be queried with `hitch runs list`, and strict model or harness
comparisons are available through `hitch compare model|harness` with benchmark,
task, model, harness, eval, status, and time filters.
