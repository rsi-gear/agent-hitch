# Daemon: parallelism and recovery

The daemon is Hitch's coordinator for long-running work. It accepts submissions independently of the caller, schedules runs and evaluations against shared capacity, and records the state needed to recover supported evaluations. You can disconnect, return later, and inspect the same IDs.

## Start one coordinator

Use one daemon per Hitch state root. Ordinary daemon runs and evaluations share its CPU and memory budget; evaluations also reserve container and build slots. Separate roots have separate schedulers and do not coordinate a shared host's capacity.

Complete the [evaluation setup](evaluations.md) first, including Harbor, Docker, and container authentication. Start the daemon from the shell that already has `CODEX_API_KEY` configured for this Codex example. Later changes to another shell's environment do not update a running daemon.

```bash
hitch daemon status --json
```

If stopped, start with a budget that fits the capacity available to Hitch. This example allocates 4 CPUs, 8 GiB of memory, four container slots, and one concurrent image build:

```bash
hitch daemon start \
  --max-concurrent 4 \
  --capacity-cpu-millis 4000 \
  --capacity-memory-mib 8192 \
  --container-slots 4 \
  --build-slots 1
```

Keep these resource settings for subsequent starts. If a daemon is already running, inspect and reuse its configuration. Change its configuration only after dealing with its active work; `hitch daemon stop` cancels active work during shutdown and is not a pause command.

## Submit without waiting

Replace the dataset path below with a local Harbor dataset containing several independent tasks. The guide's `docs/guide/examples` dataset also works, but its single task cannot demonstrate parallel trials within one evaluation. The Codex permission argument is for these trusted task containers only.

```bash
hitch eval submit \
  --dataset /absolute/path/to/harbor-dataset \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --provider local-docker \
  --cpu-per-trial 2 \
  --memory-per-trial 4GiB \
  --attempts 1 \
  --max-concurrent 8 \
  --timeout 5m \
  --setup-timeout 15m \
  --idempotency-key parallel-demo-01
```

Submission persists the request and returns an `eval_id`. Replace `EVAL_ID` with that value:

```bash
hitch eval watch EVAL_ID --output jsonl
hitch eval inspect EVAL_ID --json
hitch daemon status --json
```

Watching is observation: reconnecting to the same ID does not start another evaluation. Use `hitch eval run --daemon` with the same execution options when you want to submit and wait in one command.

To submit another evaluation, repeat the submission with a new idempotency key, such as `parallel-demo-02`. Both evaluations share the daemon's total capacity. If a submission response is lost, retry the original request with its original key to retrieve the same evaluation. The same key with changed inputs produces `idempotency_conflict`.

## How parallelism is decided

Three controls work together:

| Control | What it limits |
| --- | --- |
| `hitch daemon start --max-concurrent` | Concurrent ordinary Harness runs. It also contributes to default container-slot calculation when slots are not explicit; it is not a universal evaluation-count limit. |
| `hitch eval submit --max-concurrent` | Requested trial parallelism within that evaluation. It does not reserve that many workers immediately. |
| Daemon resource capacity and per-trial requirements | What can actually run across evaluations and ordinary daemon runs at the same time. CPU, memory, container slots, and other configured requirements must all fit. |

With the example budget, trials requiring 2 CPUs and 4 GiB can occupy at most two slots at once, even though the evaluation requests eight and four container slots exist. That assumes independent tasks, no other work, and no extra resources required by task metadata or sidecars. Two evaluations share those two available trial slots; each does not get two of its own.

```text
Evaluation A ─┐
Evaluation B ─┼─ shared CPU / memory / container budget ─ eligible task slots
Host runs ───┘
```

For datasets with known task membership, the dispatcher rotates between evaluation queues at task boundaries. It reserves all required resources together and checks task collision locks before starting work. Distinct eligible tasks can overlap; attempts of the same task in the same collision domain stay ordered. A blocked task can yield to other eligible work. Opaque datasets use a coarser allocation path, so the same fine-grained scheduling guarantee does not apply.

Docker trials receive CPU and memory limits. Ordinary host-run reservations are scheduling accounting, not operating-system limits on those processes. If capacity flags are omitted, Hitch attempts Docker capacity detection and uses conservative fallback values; check `hitch daemon status --json` before increasing parallelism.

Managed local SGLang reserves service resources in this ledger; remote model nodes own their GPUs. External model servers need a separate inference budget. See [model inference capacity](model-inference.md#account-for-daemon-and-inference-capacity) for concurrency and service recovery.

## What makes evaluation recovery possible

Recovery uses persisted execution state instead of submitting the experiment again:

1. **Durable request and plan.** Hitch retains the accepted request, resolved inputs, task/attempt plan, and publication progress. A queued evaluation can return to the queue after restart.
2. **Execution leases and process identity.** A lease records ownership of a task execution. Local recovery verifies the original process's start identity as well as its PID. Adopting it advances the lease epoch, so stale owners cannot update the new lease.
3. **Recoverable output and publication.** Local execution records its exit and output independently of the daemon. Recovery can collect a completed result and publish it idempotently. Already published slots are skipped, and genuinely unstarted slots can continue from the saved plan.

This supports recovery of the evaluation around an existing candidate execution. It does not reconstruct an agent conversation from a trajectory or automatically replay a candidate whose execution state is uncertain.

## What happens after an interruption

| Event or saved state | Recovery behavior |
| --- | --- |
| Submitting CLI or watcher disconnects | The daemon continues accepted work. Reconnect using the original ID. |
| Daemon restarts with a queued evaluation | The durable submission is requeued. |
| Supported local Harbor execution is still alive | On POSIX, recovery can verify and adopt the original process, then wait for and collect its result. |
| Execution finished but its result was not collected | Recovery collects available complete evidence and reconciles publication without starting a new candidate. |
| Some task slots are published and others never started | With a complete, consistent saved execution plan, recovery skips published slots and schedules unstarted work. |
| Process identity, execution state, or saved plan is ambiguous | Recovery reports failure, such as `execution_state_ambiguous`, rather than guessing whether to repeat execution. Inspect before choosing an explicit repair. |
| Ordinary Harness run was queued, preparing, or running when the daemon crashed | On restart, an unfinished run without a terminal result is marked failed with `daemon_restarted`; it is not automatically resumed. |

Live local-process adoption after a hard daemon crash is POSIX-only. Windows can use recorded terminal evidence and explicit repair paths, but cannot provide that live reattachment guarantee. A host reboot, a lost container, or a destroyed state root is different from losing only the daemon process.

## Return to an interrupted evaluation

Check daemon status first. If it is stopped, start it with the same state root, credentials, and resource configuration used before. The default root is `~/.hitch`; keep a custom `--root` consistent across every command. Let recovery reconcile its saved state, then inspect the original evaluation:

```bash
hitch eval inspect EVAL_ID --json
hitch eval watch EVAL_ID --output jsonl
hitch daemon logs -n 50
```

If repair is needed, choose it explicitly:

| Repair | Meaning |
| --- | --- |
| `hitch eval rerun EVAL_ID --invalid` | Default `candidate-restart`: creates a fresh candidate execution for selected invalid or missing slots and can make new model calls. Valid zero scores are not invalid slots. |
| `hitch eval rerun EVAL_ID --invalid --type collect-only` | Imports complete late results when the isolated execution and its evidence are identifiable. It does not rerun the agent; missing evidence causes rejection. |
| `verifier-only` | Regrades a retained candidate only for supported frozen benchmark executions with complete candidate artifacts and a separate verifier. It is not supported for every task, including this guide's shared-environment example. |
| `candidate-resume` / `trajectory-replay` | Reserved modes currently rejected when the required sandbox checkpoint and adapter-native support are unavailable. They do not silently become a restart. |

Cancellation is also durable: use `hitch eval cancel EVAL_ID` for the original evaluation, or `hitch eval rerun-cancel EVAL_ID RERUN_ID` for a rerun. A daemon restart does not remove that cancellation intent.

For command contracts and repair prerequisites, see the [Harbor evaluation reference](../../evals.md). Use [operations and troubleshooting](operations.md) for root selection, cancellation, and common failures.
