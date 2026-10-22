# CLI reference

A searchable reference for every user-facing Hitch command, checked against the CLI dispatch and argument parsers. Start with [Quick Start](quickstart.md) for a runnable walkthrough.

Syntax: `VALUE` is a placeholder, `[OPTIONS]` is optional, and `A|B` means choose one. Replace placeholders with actual values and omit brackets. Separate option names and values with spaces. Commands below are a reference, not a script to run from top to bottom.

Durations accept `ms`, `s`, `m`, or `h` (for example `500ms` or `5m`); a bare number means milliseconds.

## Find a command

- [Help and state root](#help-and-state-root): `help, --version, capabilities`
- [Harnesses and artifacts](#harnesses-and-artifacts): `list, inspect, resolve, prepare`
- [Run a task](#run-a-task): `run`
- [Evaluations](#evaluations): `eval`
- [Benchmark packages](#benchmark-packages): `benchmark`
- [Benchmark resources](#benchmark-resources): `resources`
- [Models and inference](#models-and-inference): `models`
- [Daemon and capacity](#daemon-and-capacity): `daemon`
- [Remote workers](#remote-workers): `worker`
- [Results and comparisons](#results-and-comparisons): `runs, compare`
- [Workspaces](#workspaces): `workspace`
- [Trajectories and verifier evidence](#trajectories-and-verifier-evidence): `trajectory, verifier`
- [Feedback](#feedback): `feedback`
- [Image cache](#image-cache): `images`
- [Training integration](#training-integration): `training`

## Help and state root

| Command / options | Purpose and notes |
| --- | --- |
| `hitch help` | Print the command overview. `hitch`, `hitch --help`, and `hitch -h` are equivalent. |
| `hitch --version` | Print the installed version; `hitch -V` is the alias. |
| `hitch capabilities [--json]` | Report versioned machine-interface capabilities. |
| `--root PATH` | Set the state directory for a command. Precedence: this option, `HITCH_ROOT`, then `~/.hitch`. Keep the same root when submitting and inspecting work. |

Use top-level `hitch --help`; subcommands do not implement their own `--help`. `--json` is accepted only where listed. `run`, `eval run`, and `eval watch` use `--output json|jsonl` instead. Some integration commands always emit JSON and need no output flag.

## Harnesses and artifacts

| Command / options | Purpose and notes |
| --- | --- |
| `hitch list [--json]` | List supported harnesses and installed-executable discovery results. |
| `hitch inspect HARNESS [--json]` | Inspect an adapter and its capabilities. |
| `hitch resolve HARNESS_REF [--json]` | Resolve a requested reference to its exact revision identity. |
| `hitch prepare HARNESS_REF [--json]` | Prepare or reuse the verified executable artifact. |

References include `codex@installed`, `codex@version:VERSION`, `codex@commit:COMMIT`, and `codex@git+file:///absolute/repository#FULL_COMMIT`. Replace `VERSION` with an exact published package version. A bare harness name selects its installed executable. Evaluations require portable, immutable references; local Git evaluations require a clean repository and a full lowercase commit hash. See [versions and workspaces](versions-and-workspaces.md).

## Run a task

```text
hitch run --harness HARNESS_REF [--prompt TEXT | --prompt-file PATH] [RUN_OPTIONS] [--daemon] [--output json|jsonl]
```

Run a harness and wait for its result. Prompt input can also come from non-interactive stdin. Direct runs default to JSONL; `--daemon` submits to the daemon and follows the run. An endpoint model resolves and freezes an already deployed service at submission. [Run tutorial](quickstart.md).

### Shared run options

These options are also accepted by `hitch daemon submit`.

| Command / options | Purpose and notes |
| --- | --- |
| `--harness REF` | Required harness reference. |
| `--model ID` | Model accepted by the harness; omitted means its default. Managed models use `local/NAME` or `local/sha256:DIGEST`. |
| `--prompt TEXT`, `--prompt-file PATH` | Choose one prompt source; otherwise read non-interactive stdin. |
| `--cwd PATH` | Source workspace; defaults to the current directory. |
| `--workspace-mode shared\|worktree\|copy` | Default `shared` runs in the source directory. `worktree` isolates a clean Git HEAD; `copy` includes current filesystem changes. |
| `--timeout DURATION` | Run time limit; default `0` has no time limit. |
| `--agent-arg VALUE` | Repeat to pass individual arguments to the harness. |
| `--context-file JSON`, `--parent-file JSON` | Attach typed task context or a parent relationship. |
| `--model-identity-file JSON`, `--protocol-identity-file JSON` | Attach structured model or protocol identities for integration workflows. |
| `--agent NAME` | Legacy alternative to `--harness`; selects an installed harness by name. These two options are mutually exclusive. |

## Evaluations

| Command / options | Purpose and notes |
| --- | --- |
| `hitch eval setup harbor [--version VERSION] [--python PATH] [--force] [--json]` | Install Hitch’s pinned Harbor in an isolated tool directory; `--force` rebuilds that install. |
| `hitch eval doctor [--harbor PATH] [--python PATH] [--docker PATH] [--json]` | Check prerequisites without starting an evaluation. |
| `hitch eval bind --model MODEL [--pass-env NAME ...] [--minimum-validity DURATION] [--timeout DURATION] --json` | Bind the running daemon’s model environment, frozen credentials, Harbor Python runtime, and supported environment-referenced files. Minimum validity and preparation timeout each default to `30m`. Capability `evaluation_preparation: "1"` adds progress streaming for long binding/submission requests while preserving the CLI JSON result; task admission includes the Harbor helper’s five-minute credential-validity margin. The daemon's `HITCH_HARBOR_PYTHON_RUNTIME_TIMEOUT_MS`, `HITCH_HARBOR_PYTHON_RUNTIME_MAX_FILES`, and `HITCH_HARBOR_PYTHON_RUNTIME_MAX_BYTES` control inventory work; defaults are 30 minutes, 250,000 traversal entries (including derived caches), and 2 GiB of reads. See the [binding protocol](../../evaluation-bindings.zh-CN.md). |
| `hitch eval run --dataset REF --harness REF [EVAL_OPTIONS]` | Execute and wait for a result; default output is JSON. |
| `hitch eval submit --dataset REF --harness REF [EVAL_OPTIONS]` | Submit to an already-running daemon and immediately return accepted IDs as JSON. |
| `hitch eval watch EVAL_ID [--output json\|jsonl]` | Follow a daemon evaluation; default JSONL. |
| `hitch eval cancel EVAL_ID` | Request cancellation through the daemon; always returns JSON. |
| `hitch eval list [--json]` | List evaluations stored under the selected root. |
| `hitch eval inspect EVAL_ID [--json]` | Inspect request, plan, state, result, and runtime references. |
| `hitch eval rerun EVAL_ID (--invalid \| --task NAME ...) [RERUN_OPTIONS]` | Repair selected invalid or missing attempts, retaining valid results. Repeat `--task` for each name. |
| `hitch eval rerun-cancel EVAL_ID RERUN_ID` | Cancel one daemon rerun operation; always returns JSON. |
| `hitch eval control --file INTENT.json` | Apply a durable ordered start/pause intent through the daemon; always returns JSON. |

### Evaluation options

Shared by `eval run` and `eval submit` unless a row limits the scope. Start with the [one-task evaluation](evaluations.md); supported recovery behavior is in [daemon](daemon.md).

| Command / options | Purpose and notes |
| --- | --- |
| `--backend harbor` | Current backend; default `harbor`. |
| `--dataset REF`, `--harness REF` | Required dataset and immutable harness reference. |
| `--model ID` | Select the model independently of the harness. |
| `--attempts N`, `--max-concurrent N` | Positive integers; ordinary dataset defaults are 1 attempt and up to 4 concurrent trials, further bounded by resources. |
| `--timeout DURATION`, `--setup-timeout DURATION` | Candidate and setup budgets. Standard compiled tasks retain their task budget unless overridden; other defaults are described in the [evaluation contract](../../evals.md). |
| `--infrastructure-retries N`, `--infrastructure-retry-backoff DURATION` | Control eligible infrastructure retries; N can be 0 to disable. |
| `--agent-arg VALUE`, `--pass-env NAME` | Repeat for harness arguments and credential/environment variable names forwarded to the container. |
| `--environment-binding ID` | Require the binding returned by `eval bind` at admission and before each Harbor execution; supports local Docker, external models, and capture `off`/`native`. |
| `--artifact-pin JSON` | Repeat once per used platform to pin `platform`, `artifact_id`, `artifact_integrity`, and `entrypoint_integrity` before task execution. See the [artifact pin protocol](../../evaluation-artifact-pins.zh-CN.md). |
| `--training-binding-file JSON` | Bind a supported training episode to an external training gateway. See [training integration](../../slime-training-binding.zh-CN.md). |
| `--resource-config FILE` | Attach an explicit resource approval created by `resources approve`. An exact match to the frozen task and current effective limits can remove its unknown-resource classification; this file does not override limits. |
| `--daemon` | `eval run` only: submit to and follow the daemon. Managed dataset models automatically select this path. |
| `--output json\|jsonl` | `eval run` only; default `json`. `eval submit` always returns acceptance JSON. |
| `--idempotency-key KEY` | Daemon submissions only; reuse a key for the same immutable request. |
| `--eval-id EVAL_ID`, `--harbor PATH` | Direct `eval run` only: choose an eval ID or Harbor executable. Daemon mode assigns IDs and uses its own Harbor environment. |
| `--benchmark DIRECTORY`, `--benchmark-lock FILE` | `eval run` compatibility inputs instead of `--dataset`; local direct execution only. Prefer explicit `benchmark compile` followed by a dataset evaluation. |
| `--control-file INTENT.json` | `eval submit` only: attach an ordered control intent. Mutually exclusive with `--idempotency-key`. |

### Execution policy

These options require `eval run --daemon` or `eval submit`.

| Command / options | Purpose and notes |
| --- | --- |
| `--provider ID` | Choose an execution provider; the default is `local-docker`. |
| `--cpu-per-trial N` | Positive whole CPU cores reserved per trial. |
| `--memory-per-trial SIZE` | Use B, KiB, MiB, or GiB; the result must be a positive whole number of MiB, e.g. `2GiB`. |
| `--build-mode backend\|prebuild-preferred\|prebuild-required` | Delegate building, prefer Hitch prebuild with fallback, or require prebuild. |
| `--model-capture off\|native\|proxy\|hybrid` | Select model interaction capture. Support depends on the harness and endpoint. |
| `--require-model-capture` | Reject unavailable required capture; cannot combine with capture mode `off`. |

### Rerun and ordered control

| Command / options | Purpose and notes |
| --- | --- |
| `--type TYPE` | Default `candidate-restart`; `collect-only` imports completed evidence without executing the candidate. `verifier-only` needs supported retained artifacts. `candidate-resume` and `trajectory-replay` require unavailable checkpoint/adapter prerequisites and may be rejected. |
| `--endpoint-attempt-file READY_ATTEMPT.json` | With `--daemon --invalid --type candidate-restart`; freeze a new endpoint binding and parent attempt, retaining valid slots and all actual cost. |
| `--verifier-runtime SHA256` | Only with `--type verifier-only`; selects an exact verifier runtime. |
| `--daemon`, `--rerun-id RERUN_ID` | Use daemon recovery; explicit rerun IDs require daemon mode. Existing control-plane evaluations also route through the daemon. |
| `--harbor PATH` | Direct rerun only; incompatible with daemon recovery. |
| `--output json` | The only rerun output format. |
| `--control-file INTENT.json` | Attach an ordered intent and select daemon mode. |

Ordered controls are an integration workflow: preserve the evaluation key and increase the sequence when changing start/pause intent. See the [control schema](../../schemas/ordered-eval-control.schema.json) and [integration contract](../../slime-training-binding.zh-CN.md). Ordinary evaluations use watch, cancel, and rerun directly.

## Benchmark packages

| Command / options | Purpose and notes |
| --- | --- |
| `hitch benchmark validate --package DIRECTORY` | Validate a local package; always emits JSON. |
| `hitch benchmark lock --package DIRECTORY [--out FILE]` | Create a content lock; optionally choose its output path. |
| `hitch benchmark compile --package DIRECTORY --out DATASET_DIRECTORY` | Compile to a Harbor-compatible dataset. Output directory must not already exist. |

Each command requires `--package`. Only lock accepts optional `--out`; compile requires it and validate rejects it. None accepts `--json`, because output is already JSON. See [benchmark packages](../../benchmark-packages.md).

## Benchmark resources

| Command / options | Purpose and notes |
| --- | --- |
| `hitch resources request OPERATION [--input JSON_FILE]` | Invoke the resource API in the selected `--root`; always returns JSON. The input file supplies the operation-specific object; omitting it supplies `{}`. |
| `hitch resources legacy-export --ref DATASET_OR_SELECTION --output NEW_DIRECTORY` | Materialize an explicit legacy dataset with a new identity. The destination must not already exist. |
| `hitch resources profile --eval EVAL_ID --task TASK_ID [--output FILE]` | Collect memory observations and the frozen resource identity for one task from a stored evaluation. |
| `hitch resources recommend --eval EVAL_ID --task TASK_ID [--identity FILE] [--min-complete-trials N] [--output FILE]` | Report current role limits, observations, and eligibility for a lower-memory proposal. The minimum complete-trial count defaults to 3; `--identity` additionally checks the profile against a current identity file. |
| `hitch resources approve --config FILE --actor NAME --reason TEXT --output FILE` | Write an explicit approval for an identity and its role limits. All four options are required; the approval does not change container limits. |

For `resources profile` and `resources recommend`, choose exactly one source: `--eval EVAL_ID --task TASK_ID`, `--input FILE` for an execution-evidence list, or `--profile FILE` for a saved profile. Imported files do not provide provider lifecycle attestation. `--identity` and `--min-complete-trials` belong only to `recommend`. These commands emit JSON; `--output FILE` saves the result and prints its file metadata instead. Current real observations remain `partial`, so recommendations report why lowering is blocked and omit a lower-memory value. See the [resource profiling and approval contract (Chinese)](../../hitch-phase-resource-reservation-spec.zh-CN.md#13-p1-实际接口与使用边界2026-10-21).

Operations are `capabilities`, `configure`, `inspect`, `import`, `seal-task`, `seal-dataset`, `selection`, `preflight`, `pin`, `release`, `materialize`, `workspace-end`, `lease-end`, `audit`, `bundle-export`, and `bundle-import`. Resource datasets are opt-in v2 inputs; ordinary v1 datasets retain their existing behavior. Inspection and audit can be requested without an input file; audit is dry-run unless the request explicitly sets `apply: true`.

Release uses the original owner and generation. End an execution workspace only after execution and result sealing are confirmed; a timeout or disconnected worker does not establish that resources are safe to release. See the [resource storage protocol and request examples (Chinese)](../../resource-storage.zh-CN.md) for request fields, fixed OCI identities, role isolation, offline bundles, and recovery limits.

## Models and inference

External model APIs use frozen endpoint bindings. Local model storage remains an artifact/CAS operation.

| Command / options | Purpose |
| --- | --- |
| `hitch models connect --name NAME --file ENDPOINT.json [--persist-credential] [--json]` | Save an immutable connection revision and update its alias; no deployment. |
| `hitch models inspect MODEL [--verify] [--json]` | Inspect endpoint/name or local/name; endpoint verification probes text, SSE and declared tool capabilities. |
| `hitch models add DIRECTORY --name NAME [--force] [--json]` | Import a complete safetensors model artifact. |
| `hitch models gc [--dry-run] [--apply] [--json]` | Inspect or apply local artifact garbage collection. |

Run/eval accept `--model-binding-file READY.json`, `--max-output-tokens N`, `--temperature N`, `--top-p N`, and `--seed N`. A binding file adds private connection data to the public binding and is frozen before task submission. Credentials are environment references; values never enter public evidence. See [model inference](model-inference.md).

## Daemon and capacity

| Command / options | Purpose and notes |
| --- | --- |
| `hitch daemon start [--foreground] [--port N] [--max-concurrent N] [CAPACITY_OPTIONS]` | Start detached by default; foreground stays in the terminal. Port defaults to 7463; `0` selects a free port. Concurrency defaults to 4. |
| `hitch daemon serve [--port N] [--max-concurrent N] [CAPACITY_OPTIONS]` | Low-level foreground server entry, also used by detached startup. |
| `hitch daemon stop` | Request daemon shutdown. |
| `hitch daemon status [--json]` | Read status, queues, capacity, and health. |
| `hitch daemon logs [-n LINES]` | Print recent logs; default 50 lines. |
| `hitch daemon submit --harness REF [RUN_OPTIONS] [--wait] [--output json\|jsonl]` | Submit a run using the shared run options. Returns acceptance JSON immediately unless `--wait` is supplied. Waiting defaults to JSON. |
| `hitch daemon cancel RUN_ID` | Request cancellation of a daemon run. |

### Capacity options

Accepted by daemon start and serve. CPU values use millicores (`1000` = one core); memory and disk values use MiB. GPU values are whole device counts. CLI values override corresponding `HITCH_…` environment variables. [Configuration and recovery](daemon.md).

| Command / options | Purpose and notes |
| --- | --- |
| `--capacity-cpu-millis N`, `--capacity-memory-mib N` | Total CPU and memory admission capacity; inferred from Docker when available, otherwise conservative defaults. |
| `--container-slots N`, `--build-slots N` | Independent container/build concurrency budgets; build slots default to 1. |
| `--capacity-gpus N`, `--eval-gpus N` | Total GPU capacity and default per-trial reservation; both default to 0 and must be explicitly configured for GPU tasks. |
| `--capacity-ephemeral-disk-mib N`, `--eval-ephemeral-disk-mib N` | Total and per-trial ephemeral disk admission budgets; defaults 0, admission accounting only. |
| `--run-cpu-millis N`, `--run-memory-mib N` | Ordinary run reservation defaults: 1000 millicores and 512 MiB. |
| `--eval-cpu-millis N`, `--eval-memory-mib N` | Default trial reservation: 1000 millicores and 1024 MiB; task declarations may require more. |
| `--unknown-max-parallelism N` | Shared admission cap for tasks missing CPU or memory declarations; default 1, range 1–10000. Also accepted by `worker run`. Overrides `HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM`; normal resource capacity still applies. |

## Remote workers

```text
hitch worker list [--json]
hitch worker observe PROVIDER [--nonce HEX] [--json]
hitch worker register --server URL --registration JSON --admin-token-file FILE --credential-file FILE
hitch worker run --server URL --registration JSON --credential-file FILE [--harbor PATH] [--docker PATH] [--unknown-max-parallelism N] [--once] [--poll-interval DURATION] [--heartbeat-interval DURATION]
```

`list` reads worker status from the daemon. `observe` returns a fresh execution observation; optional nonce is 32 lowercase hexadecimal characters. `register` rotates the worker credential and writes it to the requested file. `run` downloads and verifies inputs, executes accepted offers, reports results, and handles authorized cleanup. Use a dedicated state root on each worker host.

`observe` retries a failed Docker info probe at most once, using a new command each time. It stops after the first valid observation; changed identities remain visible. Each Docker info command has a 10s deadline, and the environment probe has a 25s cancellation deadline. Returning from cancellation can take longer while subprocesses and file operations finish. Persistent failures still return an unavailable environment. Optional [probe diagnostics](../../schemas/execution-observation-diagnostics.schema.json) describe safe failure categories and attempt timing beside the environment; they contain no command output or paths and do not enter its identity digest. Older observations without diagnostics remain readable.

`--once` exits after handling work and finishing pending jobs and cleanup; it may wait for an offer. Polling defaults to 1s and heartbeat to 10s; each interval must be from 50ms to 5m. Registration uses the [worker registration schema](../../schemas/remote-worker-registration.schema.json). See [execution-provider contracts](../../hitch-harbor-control-plane-implementation-status.md).

## Results and comparisons

| Command / options | Purpose and notes |
| --- | --- |
| `hitch runs list [FILTERS] [--json]` | Query recorded runs. |
| `hitch runs inspect RUN_ID [--json]` | Inspect a run and verify linked trajectory evidence. |
| `hitch runs rebuild-index [--json]` | Rebuild derived query indexes from stored runs. |
| `hitch runs candidate RUN_ID [--context-license allowed\|denied\|unknown] [--capture-required] [--redaction-policy ID] [--json]` | Derive a training-data candidate from a verified bundle. License defaults to unknown; the policy label defaults to `hitch-provider-redaction-v1`. |
| `hitch compare model [FILTERS] [--reference-run RUN_ID] [--json]` | Compare model outcomes and report whether the runs meet strict comparability requirements. |
| `hitch compare harness [FILTERS] [--reference-run RUN_ID] [--json]` | Compare harness outcomes under compatible conditions. |

### Shared query filters

Accepted by `runs list` and both compare commands. Filters select records; comparisons do not launch new model calls. [Evidence tutorial](runs-and-evidence.md).

```text
--context-kind KIND
--benchmark ID           --benchmark-revision REVISION
--task ID                --task-digest SHA256
--seed-task ID           --seed-digest SHA256
--iteration ID
--harness ID             --harness-revision IDENTITY
--provider MODEL_PROVIDER
--requested-model ID     --effective-model ID
--eval EVAL_ID           --status STATUS
--from TIMESTAMP         --to TIMESTAMP
```

For queries, `--provider` means model provider and `--harness` means harness ID. For evaluation execution, `--provider` selects an execution provider and `--harness` takes a revision reference. `--from` and `--to` filter creation time.

## Workspaces

| Command / options | Purpose and notes |
| --- | --- |
| `hitch workspace inspect RUN_ID [--json]` | Inspect source/execution paths, mode, retention, and changes when available. |
| `hitch workspace path RUN_ID` | Print the retained execution directory; fails when none is retained. |
| `hitch workspace remove RUN_ID [--force] [--json]` | Remove the managed workspace. Force allows removal of changed workspaces; shared source directories are protected. |

See [workspace modes and retention](versions-and-workspaces.md).

## Trajectories and verifier evidence

| Command / options | Purpose and notes |
| --- | --- |
| `hitch trajectory inspect RUN_ID [--json]` | Inspect the canonical trajectory; JSON includes the complete event array. |
| `hitch trajectory project RUN_ID [--profile analysis] [--max-bytes N] [--json]` | Produce a bounded analysis view. |
| `hitch trajectory events RUN_ID [EVENT_OPTIONS] [--json]` | Read a bounded cursor page of events. |
| `hitch verifier inspect RUN_ID [--json]` | Read redacted verifier results and diagnostics. |
| `hitch verifier artifact RUN_ID NAME [--offset N] [--limit N] [--sha256 DIGEST] [--json]` | Read one UTF-8 byte page from a complete sanitized verifier artifact. The digest fences continuation against a changed source. |
| `hitch verifier repair RUN_ID [--source EVAL_RELATIVE_TRIAL_DIR] [--json]` | Recover a legacy truncated diagnostic from its exact retained Harbor source into a digest-bound immutable supplement. The sealed run and score remain unchanged. |

```text
--types TYPE_A,TYPE_B
--seq-start N           --seq-end N
--field PATH            --canonical-sha256 SHA256
--limit N               --max-bytes N
--cursor OPAQUE_CURSOR
```

The block lists event options. Field inspection requires an exact sequence window and the canonical SHA-256 returned by a prior view. Treat cursors as opaque values; preserve the query when continuing a page. See [runs and evidence](runs-and-evidence.md).

Verifier artifact offsets are UTF-8 byte offsets. `--limit` accepts 4 through
65536 bytes; continue with the returned `next_offset` until `eof` is true.
`NAME` is one of `ctrf.json`, `test-stdout.txt`, `test-stderr.txt`,
`stdout.txt`, or `stderr.txt`. Verifier repair accepts only the run's known
eval-relative legacy Harbor trial path and rejects ambiguous sources and legacy
credential-value redactions. See the [verifier evidence contract](../../verifier-evidence.md).

## Feedback

```text
hitch feedback list RUN_ID [--json]
hitch feedback put RUN_ID --message MESSAGE_ID --rating positive|negative [--note TEXT] [--if-version VERSION] [--json]
hitch feedback delete RUN_ID --message MESSAGE_ID [--if-version VERSION] [--json]
```

Attach feedback to a message in a canonical trajectory. Use `--if-version` for a conditional update or delete against the version returned by the service. Feedback is stored separately from the sealed run evidence.

## Image cache

| Command / options | Purpose and notes |
| --- | --- |
| `hitch images gc [--minimum-age DURATION] [--apply] [--json]` | Preview eligible image cleanup by default; apply performs deletion. Minimum age defaults to 24h. |
| `hitch images pin SHA256 [--reason TEXT]` | Protect a Hitch environment image from garbage collection. |
| `hitch images unpin SHA256` | Remove the explicit pin; normal reference protection still applies. |

Image IDs identify Hitch environment image manifests. Garbage collection retains active and referenced images and checks ownership. See [environment images](../../environment-images.md).

## Training integration

| Command / options | Purpose and notes |
| --- | --- |
| `hitch training register --file PATH` | Register an external training endpoint; `--file -` reads JSON from stdin. Always outputs JSON and does not accept `--json`. |
| `hitch training runtime [--json]` | Observe the controller runtime identity and capabilities; always outputs JSON. |
| `hitch training evidence RUN_ID [--json]` | Inspect training binding and exact policy/token evidence; always outputs JSON. |

These commands connect evaluation episodes to a training system. Use `--training-binding-file` on evaluations with the supported training harness and external gateway as described in the [training contract](../../slime-training-binding.zh-CN.md). Use `runs candidate` for result-derived training-data candidates.

## Compatibility and internal options

This reference covers user-facing command paths and options. `--internal-*` options are reserved for Hitch’s Harbor bridge and are rejected outside that context. JSON integration files must match the [versioned schemas](../../schemas); they are not arbitrary configuration bags. For release differences, compare `hitch --version` and `hitch capabilities --json` with the source checkout.

`--persist-credential` explicitly imports the endpoint environment secret into revision-scoped private host storage (0600), so existing/restarted daemons can resolve later incarnation keys. Same-revision secret replacement is rejected; public bindings and tasks retain no secret value.
