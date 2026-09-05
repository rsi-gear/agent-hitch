# OSWorld fixed-sample assembly

`assemble.py` produces a `hitch-benchmark@1` package for the authorized fixed
samples `task_031` and `task_095`. It verifies the 108-task release hash manifest,
recomputes SHA256 ranking with seed `20260902`, and rejects changed membership.
It currently supports these two task classes, not every OSWorld class.
Generated packages contain restricted sources and must stay under `.hitch/`.

```sh
python3 benchmark-packages/osworld/assemble.py \
  --sdk-root /path/to/pinned/osworld-v2 \
  --web-root /path/to/pinned/osworld-web \
  --tasks-root /path/to/authorized/task-revision \
  --task-hash-manifest /path/to/authorized/task-revision/manifests/task_hashes.json \
  --assets-root /path/to/authorized/asset-revision \
  --asset-receipts /path/to/selected-assets.json /path/to/state-assets.json \
  --images /path/to/deployment-images.json \
  --max-steps 100 --agent-timeout-sec 7200 \
  --out /path/to/fresh/package
hitch benchmark validate --package /path/to/fresh/package
hitch benchmark compile --package /path/to/fresh/package \
  --out /path/to/fresh/compiled-dataset
hitch eval run --dataset /path/to/fresh/compiled-dataset \
  --harness codex@version:0.145.0 --model gpt-5.4
```

These prediction/time budgets are explicit Hitch validation settings, not an
Anthropic harness reproduction. Each submitted batch consumes one prediction.
Task instructions, dates, screenshot dimensions, setup and evaluation use the
pinned native SDK; the DeepSeek judge/user-simulator substitution is separately
named. Candidate exhaustion uses the declared native deadline adapter.

The candidate guide is copied into each task instruction and hashed in the
profile. It requires an accepted native `DONE` or `FAIL` submission before the
candidate ends its final response. A plain conversational exit leaves the native
episode open and remains a protocol failure, without a score. The guide also
explains that typing sends keystrokes and that an accepted action is only queued;
it does not change the upstream action, command timeout or task budgets.
The native phase supervisor passes these locked task instructions into every
fresh candidate alongside the current native instruction and date. Use a host
controller runtime that includes this forwarding fix; older frozen runtimes
discarded the static task instructions when starting native phases.
The guide also distinguishes the tool-client container from the desktop VM:
task files and desktop applications are accessed through native desktop actions.
Host-side phase inspection loads the verified runtime's
`payload/dist/src/runs/phase-bundle.js`; the runtime cache root itself has no
`dist/` directory.

The Harbor environment start guard is explicitly 1,800 seconds, matching the
profile's setup allowance. Harbor includes the native prepare hook inside
`environment.start()`; its default 600-second guard would cancel a legitimate
1,500-second native preparation before the candidate starts. This outer guard
does not extend the candidate's 7,200-second budget or add preparation retries.

For an explicitly selected TCG image, `--screenshot-http-timeout-sec 120`
creates a separately named `-tcg-http-120s` profile. The default is 10 seconds
and uses the original SDK method. The custom transport replaces only the
controller instance's screenshot request and is reapplied when native reset
creates a new controller. It retains three attempts, five-second retry sleeps,
the SDK image validator and `None` on exhaustion. It does not change action
budgets, native setup/evaluation or the candidate's total time allowance.
HTTP waits use Requests' timeout semantics, not a new overall trial deadline.
Other HTTP methods and the nonblocking candidate tool channel are untouched.
The setting is frozen in the profile and per-task config; native execution
and offline score receipts must agree. Use new image/package identities when
selecting this runtime; previously frozen packages retain their old behavior.

## Images and credentials

The image JSON has exactly five top-level fields:

- `protocol`: `osworld-deployment-images@1`.
- `scope`: `portable` accepts `repo@sha256:…`; `host-local` also accepts installed
  Docker config IDs `sha256:…`, which cannot be fetched on another machine.
- `vm_acceleration`: explicit `kvm` or `tcg`, with no automatic fallback.
- `vm_cpu_model`: an explicit QEMU model name, such as `Nehalem`.
- `images`: `controller`, `vm`, `teamchat_backend`, `teamchat_frontend`, `proxy`;
  each has `reference` and `platform`. Non-VM services use `linux/amd64`; the VM
  additionally supports the explicit `linux/arm64`/TCG experimental profile.

Build the controller with `prepare-controller.py` and `Dockerfile.controller`.
The VM uses the verified release archive with `Dockerfile.vm`, or the explicit
ARM host recipe `Dockerfile.vm-arm64`. Preserve built image identities and
package inventories. Host-local images use backend image handling, not registry
prebuild resolution. Preserve mixed service architectures in Compose/profile.

Only the controller receives `DEEPSEEK_API_KEY` from the host process. Load
`.env` there without printing or serializing its values. Package files contain
only the variable reference. Settings come from `deepseek-profile.json`.
The separate offline verifier requires no API key.

## Services and data

| Service | Networks | Responsibility |
|---|---|---|
| `main` | `tools` | Candidate harness and phase-local logs |
| `controller` | `tools`, `vm` | Private task/assets, SDK, key, phase/lifecycle sockets |
| `vm` | `vm`, `egress` | 4 vCPU / 4 GiB guest, 5 GiB container, disposable overlay |
| TeamChat backend/frontend | `web` | Fresh application state; task 031 only |
| `web_proxy` | `web`, `vm` | Static routes without Docker socket; task 031 only |
| `assets` | `vm` | Read-only visible files; task 031 only |

`vm` and `web` are internal networks. No service publishes host ports.
The candidate mounts no task/evaluator files or controller/VM credentials.
Private control credentials and mutable state use per-project named volumes.
Main waits for controller readiness; the controller waits for the VM owner's
control API. Guest boot occurs during prepare.

The managed VM provider resolves `vm` to a single private IPv4 address before
returning the SDK's guest endpoints. Chrome DevTools rejects DNS service names
in its HTTP Host header, even when the same service IP works. Resolution is
repeated after reset; ambiguous, loopback, link-local and public addresses are
rejected. The control endpoint remains the private named service. No Chrome
security flags or native task launch commands are changed.

Prepare accepts an already existing **empty** evidence/cache directory because
Docker creates named-volume mount points before process startup. It rejects
linked directories and any previous contents, applies private permissions,
then starts the worker. A populated volume is never silently reused or cleared.

Task 031 state asset URLs are rebased to `http://assets.trial.hitch.test`.
Original/transformed state, acquisition hashes and a transformation manifest
are retained. HTTP serves only `state-mirror/public`; private state and task
code are never mounted there. Task 095's runtime media downloads and native
source-hash checks remain unchanged.

## Grading and acceptance

The native SDK evaluates the VM before the controller quiesces and seals the
evidence inventory. `runtime/grade.py` checks the inventory, controller config,
task/SDK identities, completed candidate channel, model audit and native final
score. Failed or missing evidence produces an error and no reward. Hitch also
validates lifecycle and phase/run bindings.

The metric is `native_score`, a scalar in `[0,1]` reduced by task macro mean.
Task 095 rounds partial credit to two decimal places, so a returned `1.0` is
not converted into a derived strict-success claim. `native-score.json` records
`strict_success: null` and `candidate_executes: false`.
The standard compiler maps `native_score` to `total_score`. Although it can be
fractional, it is OSWorld's final task metric, not a process score; OSWorld does
not declare process-score or feedback channels.

Assembly, API probes and boot canaries do not count as scored tasks. Acceptance
requires both original samples to finish through Hitch with sealed candidate
evidence and a valid assessment. Valid zero counts; infrastructure failure does
not. Task031 completed this path on 2026-09-03 with
`native_score=0.14285714285714285`; Task095 completed in the same v6 evaluation
with `native_score=0`. Both canonical assessments, exported snapshots and sealed
candidate bundles were independently verified, so acceptance is **2/2**. The
original samples and budgets were unchanged. Each real task used one candidate
phase; synthetic tests cover multi-phase replacement. The named DeepSeek and
TCG/screenshot-HTTP120 profile is not an Anthropic score reproduction. Task095's
native input failure is preserved with its unresolved cause. All owned trial
containers, networks and volumes were cleared after verification. See
[the status file](../../docs/benchmark-expansion-status.json) for identities,
receipts and limitations.
