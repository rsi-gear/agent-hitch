# Operate and troubleshoot

For every command and option, see the [CLI reference](cli-reference.md).

Use direct runs for a single interactive workflow. Use the daemon when work should outlive the submitting command or share a managed queue. For the scheduling model and crash recovery workflow, start with [Daemon: parallelism and recovery](daemon.md).

## Submit a background run

Start the daemon from a shell with the credentials needed by your harness. The long-lived daemon uses its own process environment; exporting a variable later in a different shell does not update it.

```bash
hitch daemon start --max-concurrent 2
hitch daemon status --json
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Summarize this repository without editing files" \
  --timeout 5m
```

Submission returns a run ID without waiting for completion. Inspect it with `hitch runs inspect RUN_ID --json`. Use `hitch run --daemon ...` or `hitch daemon submit ... --wait` when the command should wait for the result.

```bash
hitch daemon cancel RUN_ID
hitch daemon logs -n 50
```

Cancellation targets that daemon's run. Preserve any needed output in its retained workspace before removing it.

## Queue an evaluation

With the daemon running, submit from the source checkout used in the evaluation tutorial:

For this Codex example, configure `CODEX_API_KEY` in the daemon's environment before starting it, as described in the [evaluation setup](evaluations.md). The Codex permission argument below is scoped to the trusted task container.

```bash
hitch eval submit \
  --dataset docs/guide/examples \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 \
  --max-concurrent 1 \
  --timeout 5m \
  --setup-timeout 15m \
  --idempotency-key hello-hitch-01
hitch eval watch EVAL_ID --output jsonl
```

Reuse an idempotency key only when you intend to retrieve the same submission with the same inputs. A changed request under the same key fails with `idempotency_conflict`; use a new key for a new experiment.

```bash
hitch eval cancel EVAL_ID
```

The evaluation's `--max-concurrent` is a ceiling. Actual parallelism also depends on shared CPU, memory, and container capacity. The daemon detects Docker capacity where possible; inspect its status and read [how parallelism is decided](daemon.md#how-parallelism-is-decided) before increasing concurrency. Direct evaluations are rejected while a daemon owns the same Hitch root. Submit through it or deliberately use a separate root.

## Keep experiments in a separate root

```bash
hitch --root /absolute/path/to/hitch-state runs list --json
```

`--root` takes precedence over `HITCH_ROOT`; the default is `~/.hitch`. Use the same root when starting a daemon, submitting, inspecting, and cancelling its work. Place it outside the managed source repository. Roots have separate state and queues, but separate roots do not coordinate a shared Docker host's total resources.

When you are finished with a daemon and have checked its active work:

```bash
hitch daemon stop
```

Stopping cancels active work during shutdown; it is not a pause-and-resume mechanism.

## Diagnose a failure

| Symptom | What to check next |
| --- | --- |
| `hitch` is not found | Check Node.js and the global npm executable directory on your `PATH`. |
| Installed harness is missing | Run `hitch list` and `hitch inspect HARNESS --json`; use a supported exact package reference if the program is not installed. |
| Authentication or model access fails | Verify the harness's login, model ID, and provider access. For evaluations, confirm credentials reach the container; for daemon work, check the daemon's environment. |
| A local model works on the host but not in an evaluation | Check [container access to inference](model-inference.md#reach-the-model-from-a-docker-evaluation), especially loopback, DNS, endpoint protocol, and named environment variables. |
| Worktree creation fails | Run `git status --short`, including untracked files. Preserve changes or choose `copy` mode. Keep the state root outside the source. |
| Copy provisioning fails | Stop concurrent writes to the source and check for initialized submodules or linked nested workspaces. |
| Evaluation doctor reports errors | Start Docker, select Python 3.12+, and complete `hitch eval setup harbor`. A missing local-model credential can be only a warning. |
| Evaluation remains queued | Check `hitch daemon status --json` and resource capacity before raising concurrency. |
| Evaluation score is absent | Inspect its trial run and verifier evidence. Diagnose an invalid observation instead of converting it to zero. |
| Trajectory is absent or rejected | Check whether startup completed and whether the stored trajectory reference has a canonical checksum. Do not edit the stored evidence to bypass validation. |
| A command cannot find an existing ID | Confirm the ID prefix (`run_` or `eval_`) and the state root. |

Capture the Hitch version, command with secrets removed, exit code, and relevant run/eval IDs when reporting an issue. Inspect logs locally before sharing them. The [issue tracker](https://github.com/rsi-gear/agent-hitch/issues) and [Discord](https://discord.gg/cZ4NBbHDk) are available for questions.

## Recovery boundaries

After a daemon crash, evaluation recovery uses durable requests, plans, leases, and publication progress to requeue accepted evaluations, adopt identifiable local executions, collect complete results, and continue genuinely unstarted work. Live local Harbor process adoption is POSIX-only.

Unfinished ordinary Harness runs without terminal results are marked failed with `daemon_restarted`. Ambiguous candidate execution is not silently replayed. Hitch retains evidence and managed workspaces, and does not merge agent changes automatically. Follow the [interruption scenarios and recovery steps](daemon.md#what-happens-after-an-interruption) before submitting replacement work.
