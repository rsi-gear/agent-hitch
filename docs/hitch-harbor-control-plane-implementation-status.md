# Harbor control-plane implementation status

This is the evidence tracker for
`hitch-harbor-control-plane-spec.zh-CN.md`. A row is **implemented** only when
the repository contains both an implementation and a test that exercises the
specified behavior. `npm run check` is necessary but does not by itself prove
that a missing requirement exists.

Last audited: 2026-09-01 on branch `codex/harbor-control-plane`.

## Stage status

| Spec area | Status | Current evidence | Remaining work |
| --- | --- | --- | --- |
| Stage 0: contracts and compatibility | Partial | Strict eval submission input/persisted execution-policy/control/execution-plan/lease/worker/provider-status/local-provider-record/supervisor-exit/environment-image/build-record/bundle/rerun-operation schemas; provider and image contracts; direct Harbor fixtures; architecture checker with `images` boundary | Interaction, remote-provider protocol and training-candidate schemas/capabilities |
| Stage 1: daemon eval and durable queue | Partial | `/v1/evals`, status/events/cancel/rerun, idempotency, persisted control and rerun queues, monotonic planning/preparing/running/finalizing states, active lease and queued/terminal work lists, shared resource ledger, work-item DRR, provider-aware live-process recovery and terminal collection; explicit `collect-only` imports complete late results from their original work/epoch without Candidate execution, capacity reservation or collision locks; startup recovery and owned-resource reaping complete before new dispatch | Complete transition crash matrix |
| Stage 2: vector scheduling and sharding | Partial | Atomic CPU/memory/container/build ledger, local task slots, cross-eval DRR, per-work-item task mutex, ordered same-task attempts, heartbeat-renewed execution leases with epoch fencing and recoverable resource-epoch history, opaque fallback; normalized submission execution policy is immutable, idempotency-bound and controls provider, max parallelism and default trial reservation; task TOML and Compose hard limits are validated through Harbor, conflicting declarations reserve the larger value, and per-field source/estimated evidence is persisted; main, separate Verifier, Compose sidecars and provider egress overhead form the admitted reservation; Harbor main and sidecar hard limits are applied separately; an ownership-fenced Docker observer seals requested/enforced resources plus bounded peak-memory/OOM/exit evidence or explicit unavailability in `execution.json`; a Harbor Docker environment labels every controlled Compose service/network/volume; the double-inspect, lease-locked reaper runs at startup and after work release | GPU dimension, cumulative CPU-time sampling and live-Docker accounting canary; image GC remains Stage 3 |
| Stage 3: environment image service | Partial | Strict context hashing/manifest/store/build records and indexed build API; cross-instance keyed locks; 10-way single-invocation test; Docker BuildKit metadata/platform probes; mutable registry tag to immutable digest resolution; explicit digest/platform verification; derived registry cache refs; independent global build-slot lane | Harbor/Compose discovery, Dockerfile base-image resolution, digest overlay and live-container verification, image GC |
| Stage 4: execution providers | Partial | Provider interface; `/v1/workers` status/heartbeat/capacity; local-docker plan/offer/cancel/recover/release boundary; PID + process-start identity; detached supervisor/direct-file stdio; daemon reattach, heartbeat, terminal collection and resume; ownership-fenced Docker resource discovery and terminal observation | Remote registration/transport and worker selection |
| Stage 5: model capture and data candidates | Missing | Provider-native trajectory and sealed Result Bundle index already exist | Proxy/hybrid capture, interaction store/redaction, capture policy gate, bundle interaction refs and read-only training-candidate exporter |

## Acceptance evidence

| Acceptance requirement | Status | Evidence or contradiction |
| --- | --- | --- |
| Daemon submit/query/follow/cancel/rerun/recover | Partial | Eval and typed rerun APIs, durable queues, event streams, live local-process reattach, terminal collection, pending-work resume, and zero-execution `collect-only` late-result import are tested | Full transition crash matrix and remote-provider recovery remain |
| Global reservations across evals | Implemented | Known local tasks acquire atomic per-work-item vector permits through shared DRR; opaque datasets retain one conservative coarse allocation |
| `max_concurrent` bounded by all resources | Partial | Submission `execution.max_parallelism` is bounded by request `max_concurrent`; its immutable `default_trial` enters admission, plan and `submission-default` field evidence; logical admission then uses per-task CPU/memory/container totals derived from validated task/Compose declarations, conservative defaults, separate Verifier containers and provider sidecars; Harbor main and sidecar hard limits are applied separately and unrepresentable main limits fail closed; execution evidence distinguishes sampled peak-memory/OOM/exit fields from unavailable CPU time | GPU admission, cumulative CPU-time sampling and live-Docker load evidence remain |
| Different tasks parallel; same-task attempts mutexed | Implemented | Planned execution and dispatcher tests cover parallel different tasks, ordered attempts and cross-eval collision keys |
| Same image build deduplicated | Partial | Ten independent image-service instances sharing one root produce one BuildKit invocation and persistent cache hits | Eval planning does not yet request environment images |
| Harbor remains semantic authority | Implemented | Backend keeps Harbor dataset/environment/Verifier behavior and imports its result evidence |
| Verifier-only retry never reruns Candidate | Implemented | Dedicated verifier retry path and negative tests cover exhausted retries |
| Crash recovery creates no duplicate authoritative run | Partial | A `SIGKILL` integration test proves one Candidate start across daemon replacement, epoch reissue, original-process collection and resume; ambiguous work still fails closed | Crash injection at every transition and remote-worker duplicate delivery remain |
| Reaper only deletes owned resources | Implemented | Unit/smoke tests cover all-service Compose labeling, external-resource exclusion, exact root/provider/eval/work/lease/resource-epoch matching, terminal-state checks, deletion ordering, second-inspect TOCTOU fencing and negative cases; the reaper never issues image/global prune commands |
| Harness artifact/controller runtime are not bypassed | Implemented | Every eval resolves immutable artifact/runtime identities and validates them before Harbor handoff |
| Every sealed run has a verified bundle index | Implemented | Run finalization creates the index and mutation tests verify it fails closed |
| Model proxy optional/off-compatible | Missing | No proxy/capture policy implementation exists |
| Credentials absent from new records/caches | Partial | Explicit pass-env allowlist exists; image/capture/provider records and comprehensive secret-scanning tests do not |
| Legacy direct eval/history readable | Implemented | Direct eval and compatibility plan/rerun tests remain active |
| Full repository checks pass | Implemented | `npm run check`; this row must be refreshed after every implementation change |

## Required test gaps

- Cross-domain Docker canary proving the same task can run concurrently on two
  truly independent collision domains.
- Daemon crash injection at every transition listed in Spec section 25.3.
- Live-Docker canary for Compose labels and cleanup across a real daemon crash.
- Malicious remote-worker paths and duplicate event delivery (stale lease epoch
  mutation is covered locally).
- Capture redaction for standard and custom secret headers.
- Fixed-machine load/canary acceptance from sections 25.5 and 25.6.

Update this document in the same commit that closes any row. Do not change a
row to **implemented** based only on a type definition, an unexercised code
path, or a green unrelated test suite.
