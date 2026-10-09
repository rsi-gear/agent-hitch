# Evaluation preparation measurements — 2026-10-09

Repeated local Harbor tasks spend substantial time preparing identical inputs.
The changes reduce dataset payload reads, share immutable runtime installations,
reuse prepared images, and shorten shutdown of Harbor's default keepalive.
They do not share mutable task state or change scoring formulas.

The [aggregate measurements](eval-preparation-2026-10-09.json) include exact
values, runtime identities, evaluation IDs, measurement limitations, and SHA-256
digests of the local source archives. Raw trajectories, task payloads, and
credentials are not included. These are measurements of the development
versions, before transplanting the changes onto `dev` and hardening cancellation
cleanup during PR review. They are not fresh performance certification of the
final PR runtime.

## Environment and comparison boundaries

Measurements used a Linux x86_64 KVM host with 16 logical Intel Xeon Platinum
CPUs and approximately 61.4 GiB RAM, Node 22.22.1, Docker 29.1.3, and Harbor
0.21.0. Live evaluations used the same frozen 20 AutomationBench Marketing tasks,
DSH harness, and GPT-6 Luna subscription configuration, with concurrency 16.
The precise provider model snapshot was unresolved. The implementation contains
no benchmark-specific rules; synthetic regressions cover independent layouts,
datasets, build contexts, and harness artifacts.

Each comparison isolates a different development stage. Their percentages must
not be added or multiplied into a claimed overall speedup. Model workload,
filesystem cache state, and other activity on the shared host can affect elapsed
times. Per-task phases overlap across tasks and cannot be summed into batch wall
time.

## Dataset verification

A model-free replay brackets the original implementation with two optimized
runs. It exercises admission checks, native-descriptor lookup, score collection
checks, and the new final dataset sweep. All three runs have the same dataset
digest and descriptor results.

| Metric, 20 tasks | Original | Optimized, first | Optimized, second |
| --- | ---: | ---: | ---: |
| Logical dataset bytes read | 29,261,278,662 | 2,786,968,032 | 2,786,968,032 |
| Successful dataset file reads | 981,204 | 93,486 | 93,486 |
| Full verification replay, seconds | 403.82 | 31.46 | 48.34 |
| Collection portion, seconds | 389.99 | 8.20 | 11.85 |

Logical bytes decrease by **90.48%**. This is not a physical disk I/O counter or
an end-to-end evaluation speedup. Shared-host load affected timings; the stable
read counts are the stronger evidence. Payload reads grow linearly for this v1
collection path, while manifest parsing and task-set metadata checks still occur
per collection. There is no pathname/mtime cache. Resource v2 closure validation
and standalone full verification remain in place.

Reproduce with any standardized v1 dataset and a built original checkout:

```sh
npm run build
node dist/scripts/benchmark-dataset-verification.js \
  --dataset /absolute/v1-dataset \
  --baseline /absolute/original-hitch \
  --output /absolute/comparison.json
```

## Shared immutable runtime and dependencies

Four controlled batches ran `upload → shared → shared → upload`, each with 20
real bridge setups at concurrency 16. All 80 setups succeeded. Controller and
harness content identities and the base image were fixed. This experiment
contains no model, simulator, or verifier execution.

| Metric | Upload | Read-only snapshots |
| --- | ---: | ---: |
| Mean setup, seconds/task | 30.16 | 10.85 |
| Harness upload, seconds/task | 18.31 | 0 |
| Controller upload, seconds/task | 0.51 | 0 |
| Host worker/CLI CPU, core-seconds/batch | 194.25 | 109.59 |
| Batch wall time including create/cleanup, seconds | 111.76 | 40.84 |

Mean setup decreases by **64.0%** and measured host process CPU by **43.6%**.
The batch and per-task times exclude **10.26–12.35 seconds** to create and verify
the one-time snapshots. Host process CPU excludes dockerd/containerd. Existing
artifact validation and per-task Node extraction remain; they were approximately
unchanged. An earlier full live evaluation at this stage was slower overall
(755.01 versus 723.52 seconds) because other phases dominated. Sharing alone did
not establish an end-to-end gain.

## Image preparation and verifier lifecycle

This baseline already includes dataset and shared-runtime optimizations. Both
sides have warm dependency and Docker build-layer caches; the optimized side
additionally reuses the new prepared-image cache and manages Harbor's default
keepalive. Harness preparation occurred in advance.

| Metric | Baseline | Optimized warm run 1 | Optimized warm run 2 |
| --- | ---: | ---: | ---: |
| Full evaluation wall time, seconds | 514.14 | 399.95 | 372.14 |
| Candidate + sidecar image preparation, seconds/task | 39.54 | 3.62 | 3.17 |
| Environment setup including readiness, seconds/task | 67.67 | 33.21 | 29.52 |
| Verifier image preparation, seconds/task | 20.72 | 1.41 | 1.24 |
| Complete verifier phase, seconds/task | 65.42 | 22.66 | 20.96 |
| Verifier lifecycle excluding scoring body, seconds/task | 50.19 | 8.14 | 7.17 |
| Scoring body, seconds/task | 15.22 | 14.51 | 13.78 |
| Candidate stop signal to exit, seconds/container | 10.66 | 0.25 | 0.24 |
| Verifier stop signal to exit, seconds/container | 10.54 | 0.30 | 0.33 |
| Dockerd + containerd CPU, core-seconds | 1,316.93 | 342.92 | 334.41 |
| Whole-host disk writes, GiB | 19.91 | 4.66 | 4.68 |

Both optimized runs produced 20/20 valid executions. Wall time decreased by
**22.2–27.6%** in these runs; the final run's candidate and verifier image
preparation decreased by **92.0%** and **94.0%**. Scoring execution remains in a
separate verifier container. Whole-host writes and daemon CPU include unrelated
activity and cannot be attributed exclusively to this evaluation. Process and
container sampling can miss very short lifetimes.

The cold preparation-only run took **140.38 seconds** for 60 image preparations.
Two warm repeats took **17.67** and **17.61 seconds**, with 60/60 hits. There were
**60 distinct complete build contexts**: observed gains here are primarily reuse
across rounds. This implementation does not deduplicate shared subsets of
different contexts. Full-context hashing intentionally invalidates on changes to
unused or ignored files as well.

The final live run's 60 executed image IDs matched their preparation receipts.
Candidate and verifier mounts were checked. Average active agents increased
from 4.52 to 7.29, and average simultaneous model requests from 3.09 to 4.82;
these averages do not guarantee throughput at higher configured concurrency.

## Correctness evidence and limits

Regrading the same 20 saved pre-optimization snapshots produced identical
`reward.json`, `assertions.json`, and `process.json` outputs for all 20 tasks.
This isolates verifier behavior from new model trajectories. Unit and real Docker
fixtures additionally cover immutable input identities, cross-process build
deduplication, invalidation, eviction, failures, cancellation, isolated writable
state, role separation, prebuilt-image precedence, and preserved custom commands.

A complete Gear round also finished with 140/140 valid executions: 100 baseline,
12 local, and 28 physical bridge trials. The candidate was rejected by the bridge
objective; successful execution does not imply promotion or task success.

The old 100-task baseline scored 13/100; two optimized baselines scored 18/100 and
15/100. The second optimized baseline initially had one model transport failure;
that invalid slot was repaired, retaining the other 99 trials. The old run used
concurrency 8 and the optimized runs used 16. Seven tasks passed only in the old
run and failed in both optimized runs. These limited, differently concurrent
live samples do **not** establish score equivalence or prove that every
difference is model randomness. Matched-concurrency repeated comparisons remain
necessary for that conclusion.

## Opt-in behavior and tradeoffs

See [the storage and preparation guide](../resource-storage.zh-CN.md) for current
configuration. Dataset verification changes apply to the admitted v1 evaluation
path; runtime sharing, image caching, and managed keepalive are opt-in. Upload
remains the default runtime transport. Read-only runtime sharing requires local
Linux Docker and harnesses that do not modify their installation directory.

Image caching uses private host-local state and conservative supported inputs.
Unsupported Compose/Dockerfile features and explicit force builds retain the
original build path. Prepared images and evaluation snapshots are retained;
there is no automatic cache garbage collector. Mutable workspaces, credentials,
Node extraction, and verifier instances remain private. Repeated cancellation
must finish Docker process-group cleanup before releasing build locks.

Review found and fixed a case where the Docker CLI had exited but a descendant
still held its pipes: cancellation previously skipped cleanup when the leader
already had a return code. The new real-process regression waits for leader exit,
cancels a stubborn descendant, and verifies pipe closure before returning.
Output draining stays active during cleanup to avoid pipe backpressure deadlocks.

Review also replaced role-marker/suffix matching with the exact candidate session
derived from `TrialPaths`. A truncated verifier session can lose its role marker,
and a verifier step named `env` can resemble a candidate suffix. Regression tests
cover both cases, long trial names, and legitimate candidate names containing
`__verifier__`; real Docker checks confirm that verifier image contents and
mounts stay independent.
