# Workspace isolation

Hitch can give each run its own working directory. This protects the source
checkout from ordinary agent edits and prevents isolated runs from writing the
same files concurrently. It is not an operating-system security sandbox.

## Modes

`shared` is the compatibility default. The harness runs directly in `cwd`, and
Hitch does not serialize or isolate concurrent writers.

`worktree` creates a detached Git worktree from the source `HEAD` captured when
the run is accepted. The source must be clean, including staged, unstaged, and
untracked files. Ignored files are not copied. If `cwd` names a repository
subdirectory, the harness starts in the corresponding isolated subdirectory.

`copy` snapshots the current filesystem state and supports dirty Git trees and
non-Git directories. For Git sources, Hitch makes a clone without hardlinks,
checks out the captured commit, removes the checked-out work tree, and overlays
the current source files except the root `.git`. This preserves dirty,
untracked, and ignored files while keeping the copied root Git metadata
independent. Linked nested Git workspaces and initialized submodules are
rejected in this mode because their `.git` pointer would otherwise reference the
source repository.

Copying is not atomic relative to processes outside Hitch. Hitch hashes the
source before and after copying and rejects a snapshot when the content or
source `HEAD` changes during that window. The Git `HEAD` is pinned when the run
is accepted; working-tree content is captured when the run begins provisioning.

```bash
hitch run \
  --harness codex@installed \
  --cwd /workspace/project \
  --workspace-mode worktree \
  --prompt "Implement the task"
```

The daemon submission command accepts the same `--workspace-mode` option.

## Retention

Managed workspaces are retained after success, failure, timeout, and
cancellation because they may contain the run's primary output. Hitch never
merges or copies changes back to the source automatically.

```bash
hitch workspace inspect run_<id> --json
hitch workspace path run_<id>
hitch workspace remove run_<id>
```

Removal without `--force` succeeds only when Hitch observed no changes. Use
`--force` to remove a changed or indeterminate workspace. A daemon restart marks
an already prepared managed workspace as `orphaned` and retains it; an
incomplete provisioning directory is cleaned without replaying the run.

## Records

The run manifest keeps its existing `workspace` field as the requested source
path and adds `workspace_mode`, `source_workspace`, `execution_workspace`,
`workspace_snapshot`, `workspace_retained`, and `workspace_changed`. Detailed
lifecycle state is written to `runs/run_<id>/workspace.json`; managed files live
under `workspaces/run_<id>/root`.

The Hitch state root must be outside the managed source repository. This avoids
recursive copies and nested worktree targets.

## Security boundary

Workspace isolation controls the working directory supplied to the harness; it
does not restrict filesystem or network access. A harness can still access an
absolute source path, follow a symlink outside the workspace, or mutate shared
Git metadata. Git worktrees also share objects, refs, and some repository
configuration. Use an OS sandbox or container when running untrusted code.
