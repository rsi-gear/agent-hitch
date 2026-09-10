# Pin versions and isolate workspaces

Select the harness executable and the workspace independently. A fixed executable does not imply a fixed working directory.

## Choose a harness reference

| Reference | Use it when |
| --- | --- |
| `codex@installed` | You want to fingerprint and run the executable already on this machine. |
| `codex@version:0.92.0` | You want a specific published package version, prepared in Hitch's cache. |
| `codex@commit:COMMIT` | You want to build an exact commit from the registered upstream repository. Replace `COMMIT` with a real commit. |

Use `hitch inspect HARNESS --json` to check the adapter before selecting a source. Building a source commit also requires that harness's build toolchain; package versions are the simpler starting point.

| Harness | Installed | Package version | Source commit |
| --- | --- | --- | --- |
| Codex | Yes | Yes | Yes |
| Claude Code | Yes | Yes | No |
| Pi | Yes | Yes | Yes |
| OpenCode | Yes | Yes | No |
| DeepSeek Harness | Yes | Yes | Yes |

Resolve the identity without starting an agent, or prepare its runnable files in advance:

```bash
hitch resolve codex@version:0.92.0 --json
hitch prepare codex@version:0.92.0 --json
```

Keep the resolved identity and artifact reference with your experiment. `@installed` is useful locally but is not a portable evaluation reference. Harbor evaluations require an immutable package or commit reference.

## Choose a workspace mode

| Mode | Starting files | What to watch for |
| --- | --- | --- |
| `shared` | Your original directory | This is the default. Agent edits affect that directory, and concurrent writers are not isolated. |
| `worktree` | A detached worktree from a clean Git HEAD | Requires a clean repository, including untracked files. Ignored files are not copied. |
| `copy` | A snapshot of the current filesystem | Includes dirty, untracked, and ignored files. Supports non-Git directories; linked nested Git workspaces and initialized submodules are rejected. |

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --cwd /absolute/path/to/project \
  --workspace-mode copy \
  --prompt "Summarize the current changes" \
  --timeout 5m
```

Replace the path before running. Avoid editing the source while Hitch snapshots it: source changes during copying can make provisioning fail. Keep the Hitch state root outside the source directory.

Workspace isolation controls the directory supplied to the agent. It is not an operating-system sandbox: absolute paths, network access, and shared Git metadata may remain accessible. Use an appropriate container or OS sandbox when you need that boundary.

## Review and remove a workspace

```bash
hitch workspace inspect RUN_ID --json
hitch workspace path RUN_ID
```

Open the returned directory and review its changes. Preserve anything you need before cleanup. Hitch retains managed workspaces after success, failure, cancellation, and timeout.

```bash
hitch workspace remove RUN_ID
```

Normal removal refuses a changed or indeterminate workspace. `--force` explicitly discards it; use that option only after saving the output you need. Shared source directories are not managed workspaces to delete through this command.

See the [workspace contract](../../workspaces.md) for snapshot and recovery details. Next, [read the evidence from a run](runs-and-evidence.md).
