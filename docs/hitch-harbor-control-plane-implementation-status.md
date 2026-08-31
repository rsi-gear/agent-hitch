# Harbor control-plane implementation status

This is the evidence tracker for
`hitch-harbor-control-plane-spec.zh-CN.md`. A row is **implemented** only when
the repository contains both an implementation and a test that exercises the
specified behavior. `npm run check` is necessary but does not by itself prove
that a missing requirement exists.

Last audited: 2026-08-31 on branch `codex/harbor-control-plane`.

## Stage status

| Spec area | Status | Current evidence | Remaining work |
| --- | --- | --- | --- |
| Stage 0: contracts and compatibility | Partial | Strict eval submission/control/execution-plan/lease/worker/provider-status/local-provider-record/bundle/rerun-operation schemas; provider contract types; direct Harbor fixtures; architecture checker | Execution policy, environment image, interaction, remote-provider protocol and training-candidate schemas/capabilities |
| Stage 1: daemon eval and durable queue | Partial | `/v1/evals`, status/events/cancel/rerun, idempotency, persisted control and rerun queues, shared resource ledger, work-item DRR, ambiguous-execution recovery | Complete control states/work-item lists and provider-aware recovery |
| Stage 2: vector scheduling and sharding | Partial | Atomic CPU/memory/container/build ledger, local task slots, cross-eval DRR, per-work-item task mutex, ordered same-task attempts, heartbeat-renewed execution leases with epoch fencing, opaque fallback | Provider-driven lease recovery integration, Docker labels/reaper, resource derivation and hard limits |
| Stage 3: environment image service | Missing | Harbor still owns its existing environment build path | Image resolver/manifest/store, keyed BuildKit execution, registry cache, digest overlay/verification and image GC |
| Stage 4: execution providers | Partial | Provider interface; `/v1/workers` status/heartbeat/capacity; local-docker plan/offer/cancel/recover/release boundary; PID + process-start identity records and probes; crash-surviving direct-file child stdio and terminal reconciliation | Daemon reattach/collection orchestration, Docker resource discovery, remote registration/transport and worker selection |
| Stage 5: model capture and data candidates | Missing | Provider-native trajectory and sealed Result Bundle index already exist | Proxy/hybrid capture, interaction store/redaction, capture policy gate, bundle interaction refs and read-only training-candidate exporter |

## Acceptance evidence

| Acceptance requirement | Status | Evidence or contradiction |
| --- | --- | --- |
| Daemon submit/query/follow/cancel/rerun/recover | Partial | Eval and typed rerun APIs, durable queues, event streams and restart classification tests exist; active physical execution cannot yet be reattached or collected |
| Global reservations across evals | Implemented | Known local tasks acquire atomic per-work-item vector permits through shared DRR; opaque datasets retain one conservative coarse allocation |
| `max_concurrent` bounded by all resources | Partial | Logical admission is bounded; Docker/cgroup hard limits and task-declared resource derivation are absent |
| Different tasks parallel; same-task attempts mutexed | Implemented | Planned execution and dispatcher tests cover parallel different tasks, ordered attempts and cross-eval collision keys |
| Same image build deduplicated | Missing | Harness artifacts are content-addressed; benchmark environment images are not managed by an image service |
| Harbor remains semantic authority | Implemented | Backend keeps Harbor dataset/environment/Verifier behavior and imports its result evidence |
| Verifier-only retry never reruns Candidate | Implemented | Dedicated verifier retry path and negative tests cover exhausted retries |
| Crash recovery creates no duplicate authoritative run | Partial | Ambiguous work is failed without replay; reissued/lost leases increment epoch; stale mutations fail closed; local provider probes PID + start identity | Daemon provider reattach and terminal collection are absent |
| Reaper only deletes owned resources | Missing | No Docker ownership-label reaper exists |
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
- Ten concurrent requests for one image produce one BuildKit invocation.
- Docker label ownership and reaper negative tests.
- Malicious remote-worker paths and duplicate event delivery (stale lease epoch
  mutation is covered locally).
- Capture redaction for standard and custom secret headers.
- Fixed-machine load/canary acceptance from sections 25.5 and 25.6.

Update this document in the same commit that closes any row. Do not change a
row to **implemented** based only on a type definition, an unexercised code
path, or a green unrelated test suite.
