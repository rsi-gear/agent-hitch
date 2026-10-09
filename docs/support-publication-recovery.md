# Support publication recovery

Implemented against Hitch `origin/dev` commit `1659701` in the isolated `codex/recover-incomplete-evaluations` worktree. Its evaluation implementation matches the handoff's v0.2.16 source; the dev package version is still 0.2.15. This change does not deploy a runtime, extend an evaluation budget, or mutate the handoff's frozen evaluations.

The supplied handoff identifies repeated whole-dataset verification during each completed-trial import: the uncompiled native-descriptor lookup and score capture both load and hash the complete standard benchmark. The private 19-trial data is not included, so the reported production timing and experimental speedup have not been reproduced locally.

## Verification boundary

The ordinary local standard-dataset execution performs the existing complete content verification before minting an opaque in-memory execution receipt. The receipt binds the frozen request's benchmark ID and dataset digest, candidate revision, normalized root and eval-directory paths, eval ID, and dataset directory identity; minting also checks canonical eval-directory containment and dataset-root identity. It is scoped to one admitted execution; it is neither a global path cache nor a persisted authorization shortcut. A restarted execution obtains a new receipt through full verification.

Each imported trial resolves its task through the existing locked Harbor identity, falling back to the result task name when no lock is available. It rechecks the frozen request, current manifest digest and contents, exact task membership, and dataset root identity, then hashes that task's entire content tree against the admitted digest. File and directory identity checks reject symlinks and mutation during the scan. Ordinary task-file hardlinks retain their prior supported behavior. Manifest metadata must be a bounded contained regular file.

Native-descriptor lookup and verifier score capture share that import's verified task snapshot. Descriptor bytes come from the same verified reads, rather than a later unverified file probe. Consumers assert the complete receipt binding and refresh manifest metadata before returning; a receipt from another eval, task, dataset, candidate, or legacy input cannot opt out of standard validation. The snapshot is evidence about the bytes verified at import, not a permanent assertion that a mutable directory cannot change afterward. A later import checks current contents again; a new full admission still rejects mutations to other tasks.

This optimization is wired through local planned execution, ordinary local import, and local infrastructure-retry imports under the same request identity. It eliminates repeated N-task **content** hashes per trial. Task membership metadata is still checked per import. The public full manifest loader remains a full content verifier. Direct imports without an execution receipt, resource datasets/selections, remote paths, and compiled native-package checks retain their compatibility verification paths; they are not given an arbitrary caller-selected scope.

Bundle sealing, trajectory and candidate identity validation, score contracts, process evidence, valid zero scores, and invalid/missing-bundle diagnostics retain their existing semantics. The tests import prepared evidence only and make no model calls.

## Publication and terminal records

The publisher advances its in-memory progress only after the durable write succeeds. Failed publication remains observable and can be retried for the same logical slot. Duplicate successful publication is a no-op. Execution waits for all producer tasks to settle, then closes and drains the publisher before terminal finalization; a closed publisher cannot accept a late write.

All evaluation terminal writers share the publication lock and preserve durable trial records when constructing `result.json`. `progress.json` now accepts `running`, `succeeded`, `failed`, and `cancelled` while keeping schema version 1. Its generation continues to count trial additions/replacements, not status-only changes. Late running projections cannot overwrite a terminal status or introduce new terminal trials.

Result and progress writes are individually atomic. If interrupted between them, the shared state reader reconciles the terminal status and any result-only trial references under the same lock. Real inspection, scheduler status, and startup recovery use this reader. Observers receive a serialized progress/result pair. Newer explicit invalid-slot repairs retain their valid references and generation against an older failed result; conflicting valid identities fail closed.

Explicit rerun paths can replace invalid slots and publish their own new terminal result. They cannot replace a valid zero. Preparation restart is narrower: only an empty failed pre-execution result can restart. The preceding result remains in the rerun's `previous-attempt` archive, while its active terminal projection is removed before the new attempt; another preparation failure creates a fresh failed result. Existing cancelled or evidence-bearing evaluations do not use that preparation shortcut.

## Deterministic regression evidence

The new import/publisher fixtures exercise genuine sealed bundles, trajectory files, identities, total/process scores, duplicate publication, and terminal state at concurrency 1, 4, and 20. Every task has three files totaling 70 bytes. Diagnostic content-read accounting verifies:

| Concurrent tasks | Full receipt admission | All per-trial imports combined |
| ---: | ---: | ---: |
| 1 | 3 files / 70 bytes | 3 files / 70 bytes |
| 4 | 12 files / 280 bytes | 12 files / 280 bytes |
| 20 | 60 files / 1,400 bytes | 60 files / 1,400 bytes |

These are scan-count and byte-count assertions, not a wall-clock production speed claim. Negative cases cover changed selected contents, manifests, task membership, symlinks, a mutation during hashing, unknown tasks, forged/misbound receipts, changed frozen requests, full admission detecting another task's mutation, and legacy-to-standard receipt reuse. Resource dataset and selection fallback score contracts are exercised explicitly.

Terminal regressions cover a failed durable publication followed by the same-slot retry, queued publication before cancellation, synthetic control-plane finalization, real inspection/startup recovery, concurrent serialized observation, a crash with result-only references, explicit invalid-slot repair, valid zero preservation, and preparation archive/restart behavior.

## Final validation (2026-10-09)

The following required static checks passed on the final source and tests:

```sh
npm run typecheck
npm run build
npm run check:architecture
node dist/scripts/check-syntax.js
```

Architecture validation covered 435 source files and 944 cross-module edges. `git diff --check` also passed.

The packaged remote worker and terminal regression suite passed **22/22** in **45.38 seconds**:

```sh
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  node --test --test-reporter=tap --test-timeout=120000 \
  dist/test/remote-worker-harbor.test.js dist/test/eval-terminal-progress.test.js
```

The final complete test corpus passed **880 tests**, with **0 failures** and **7 environment/platform opt-in skips**, in **139.10 seconds**:

```sh
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  node --test --test-concurrency=4 --test-timeout=120000 'dist/test/*.test.js'
```

This includes local, native, resource, remote worker, verifier, control-plane, rerun, cancellation, schema, and publication tests. The resource-v3 packaged evaluation completed in 8.19 seconds; its existing 20-second wait was unchanged. The import regressions still exercise 1, 4, and 20 concurrent trial imports inside their test file.

Unrestricted `npm run check` was **not** a passing full-suite run on this host. Its static phases passed, but default file concurrency exceeded the resource-v3 fixture's 20-second result wait: the worker had completed, its trial was published, and the offer awaited resource release without worker errors. An unrelated scheduler fixture also exposed a workspace-inventory race by placing mutable daemon records inside its candidate working directory; its retained failure named a disappearing `resolution.json.*.tmp` from another run. Those two existing scheduler fixtures now use a separate `root/work` candidate directory, preserving all assertions and deadlines. Remote failure teardown now stops its worker/controller before removing temporary state. The complete passing result above uses bounded file concurrency; no production timeout or evaluation budget was extended.

Dependencies are installed only inside this worktree. Ambient `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are removed from the test child process because the existing credential-name fixture expects a fixed set; no credential values are printed or changed in the user's environment. The seven skips cover Windows-specific checks and explicitly enabled Docker, node-RPC, or Gear interoperability canaries; the private 19-trial production fixture remains unavailable.

