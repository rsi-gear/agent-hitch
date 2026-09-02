# OSWorld runtime components — integration in progress

These are OSWorld package components, not a standalone runnable benchmark.
The authorized-task producer, Harbor lifecycle wiring, website provisioning,
fresh Hitch conversation supervisor and two real OSWorld
evaluations are still incomplete. The components below are separately tested;
they do not yet constitute an executable standard package.

`vm_owner.py` is PID 1 in a dedicated Harbor Compose VM service. It launches the
official QEMU entrypoint, waits for a real PNG from the guest screenshot server,
resets only the per-lease writable overlay/storage, and stops emulator children
and daemonized helpers. It uses no Docker socket or host-side VM allocator.
Harbor owns the service, named volumes and networks for its entire lifetime.
Container teardown remains the final cleanup mechanism if a hook crashes.

`vm_provider.py` supplies the `DesktopEnv` provider interface against that
service. It delegates task setup, observations and grading to the pinned
upstream SDK. During construction it substitutes the SDK's provider factory
under a lock and always restores it. An explicit VM path prevents the SDK from
allocating another VM. This requires one dedicated controller process per trial.

The future prepare hook calls `create_private_session('/control', hook_request)`
to atomically publish a fresh secret bound to `lease_id`, `epoch` and
`logical_trial_id`. The `/control` named volume is shared only by controller and
VM, read-only on the VM side. Candidate and guest filesystems must not mount it.
Controller calls to `/control` carry the token plus lease/epoch and a stable
request identity. Repeated successful or failed requests do not start a second
VM. Reusing an identity for a different operation fails. A closed owner cannot
restart; another trial requires fresh Harbor-owned services and volumes.

Compose assembly must have two separate networks:

| Service | Networks | Private mounts |
| --- | --- | --- |
| candidate `main` | tools | none |
| controller | tools, VM | `/control` writable; authorized tasks/assets |
| VM | VM | `/control` read-only; fresh `/storage` named volume |

The tool server is the only candidate-facing control interface. Do not publish
VM control, guest Python/CDP/VNC, or controller admin ports onto the host/tools
network. Place each website/database into the appropriate private namespace and
reset it with the VM. A guest can reach its network gateway, so the private VM
admin route also requires the secret; network placement alone is insufficient.

`Dockerfile.vm` consumes the already verified and extracted `System.qcow2`.
The official runtime image was resolved to
`happysixd/osworld-docker@sha256:0e6497a9295647cf05bf2b2af522fdd79bdeba2737595259cab310a3bcf6baa9`.
This is the digest observed during implementation, not a claim that Anthropic
used this historically. The upstream entrypoint creates `/boot.qcow2` with the
base as its QCOW2 backing file. Its default VM configuration is 4 cores, 4 GiB
RAM and a 32 GiB disk. Assembly must record all effective settings and allocate
container overhead separately; these defaults do not replace task-specific
resource requirements. KVM is required by default and unavailable KVM fails
preflight. Software emulation needs a separately declared profile, never a
silent fallback. Hash the built image after adding Python and the VM artifact.

`ManagedVMProvider` currently rejects custom guest-volume expansion and persisted
VM checkpoint export explicitly. The provider alone must not be advertised as
full OSWorld support.

Validation: `python3 test-support/osworld_vm_smoke.py` exercises real child
process start/stop, stale credentials/epochs, storage reset, base preservation,
and failure receipt idempotence with a synthetic readiness endpoint. This proves
process/lease behavior only. A booted official OSWorld guest and official task
reset/evaluate remain unverified until the matching inputs and worker exist.

## Native runner and candidate channel

`native_runner.run_native()` delegates to the unmodified
`lib_run_single.run_single_example()` from SDK commit
`d578d2d4e0dc82b43e270fdaa7fa89d9708cd154`. It checks the runner file's SHA256
before import. Preflight and execution failures close the channel and wake a
waiting prediction. The caller must supply the explicit upstream prediction-step
budget and own VM cleanup and the trial deadline. Native result files, including
`result.txt`, optional `result.json`, `phase_results.json`, trajectory and
recording, remain intact. Release-specific partial/strict normalization is still
pending; a rounded partial score is not sufficient evidence of strict success.

`AgentChannel` implements the SDK's `reset()` / `predict()` agent interface.
It makes no model requests. The native runner owns phase setup, gates, action
execution and final evaluation. One `predict()` consumes one native step even
when the accepted batch contains multiple actions. Empty batches retain the
native user-simulator path. Explicit action-batch and transport limits are part
of the declared profile, not implicit replacements for the upstream step budget.

The intended integration has two interfaces:

| Interface | Caller | Contract |
| --- | --- | --- |
| `management_state()` | Private supervisor | Pending generation, instruction, screenshot evidence reference and task date; never a candidate tool. |
| `bind_context(generation, run_id)` | Private supervisor | Bind a fresh Hitch run for this reset and obtain its phase token. A run ID cannot be reused across generations. |
| `observe(token)` | Candidate tool broker | Original PNG in `hitch-tool-result@1`, generation, observation sequence, instruction and optional native user response; otherwise `processing`. |
| `submit(token, sequence, request_id, response, actions)` | Candidate tool broker | Accept one validated batch for the observation; identical retries return the original receipt, conflicting retries fail. |
| `finish(status)` | Private supervisor | Close and revoke the binding; cancellation/failure wakes blocked `predict()`. |

Each native reset revokes the previous token and requires a different run ID.
The ID check is a fence, **not proof that a new model conversation was created**.
The pending supervisor must actually start a fresh Hitch run, retire the previous
candidate, bind the new run and record their relationship to the benchmark trial.
It must not forward prior-phase conversation history into the new run. The
transport below supplies HTTP authentication and private lease/epoch checks;
candidate termination and resource ownership remain responsibilities of the
assembly. Channel cancellation alone cannot
interrupt an action already executing inside the SDK.

`action_policy.py` validates the declared **graphical `computer_13`** profile
against the pinned SDK action definitions, checking their file SHA256 on load.
It accepts native flat/nested action objects and `WAIT` / `FAIL` / `DONE`, while
excluding the SDK's `EXECUTE` guest-bash action and raw Python strings. Unknown
fields, malformed coordinates, unsupported keys and non-finite numbers fail
before SDK execution. Coordinates use native pixels and upstream ranges
(1920 × 1080); the assembled profile must lock matching screenshot dimensions.
This action profile is an implementation choice, not a claim of Anthropic's
exact tool configuration.

Screenshots are stored as original PNG bytes with SHA256, and the private
`channel.jsonl` records observations, actions, bindings and terminal status.
Files are mode 0600 and tokens are omitted from the audit. The containing
directory must stay on controller-only storage and be sealed with the final
trial evidence. No accessibility tree, terminal observation, image resizing,
OCR or coordinate conversion is added.

Validation: `python3 test-support/osworld_channel_smoke.py` runs unmodified,
attributed native phase-runner functions against a synthetic environment. It
checks same-VM sequencing, phase gates, per-prediction batch budgets, stale
tokens/run IDs, idempotent submission, cancellation, screenshot preservation,
native action definitions and failure on a changed runner. The Apache-2.0
fixtures and source hashes are in `test-support/fixtures/osworld/`. This is
control-flow parity evidence; no official task, booted VM or real model is used.

## Candidate tools and private management transport

`controller_server.ControllerServer` runs two distinct listeners in the
controller service. Candidate HTTP exposes only `POST /call` with
`desktop.observe` and `desktop.submit`, using the generic `tool-server@1`
request envelope. Public tools and their JSON schemas are generated from the
same action-policy object that validates submissions. Screenshot dimensions
must equal the native coordinate space. There is no public bind/reset/evaluate,
administration or arbitrary proxy route.

The phase token authenticates each request. A native reset, failure or
cancellation revokes it; stale requests fail before reading a body and are
checked again at the channel operation. Input size, ambiguous JSON fields,
non-finite values and slow connections are bounded or rejected. The HTTP
listener permits at most 16 concurrent request workers and emits no request or
token logs. `public_endpoint` must match the locked tool binding and actual
listener port. Bind it to the private Compose service network; do not publish
it as a host port.

Management uses a mode-0600 Unix socket in a mode-0700 controller-only directory,
not another TCP endpoint. Each request authenticates the private session token,
lease ID and epoch. `state` reads the current channel state; `bind` assigns the
pending generation to a fresh run and returns its tool binding; `cancel` closes
the channel. Mutation receipts are idempotent, including rejected operations.
State reads are fresh and are not retained as receipts. An existing socket is
never adopted, and closing the server removes only its own socket.

`controller_client.py` is the private hook/supervisor client. It reads the
credential from a file and accepts the operation through stdin. For example,
inside the controller service:

```sh
python /opt/osworld-hitch/controller_client.py \
  --socket /run/hitch-private/control.sock --session /control/session.json <<'JSON'
{"request_id":"inspect_phase_0001","operation":"state","parameters":{}}
JSON
```

After preparing a new Hitch run with its own candidate workspace/runtime, the
supervisor invokes `bind` with `generation` and `run_id`. It uploads the returned
`binding` to that candidate's private tool-binding file before releasing its
model process to execute. Native session IDs and sealed per-phase run evidence
must confirm fresh conversations; run IDs alone are insufficient. Bind responses contain
the phase token: they must not be written into the lifecycle journal, model
prompt, result bundle or diagnostics. Private in-memory management receipts
also stay outside exported evidence. The model receives only its current
phase's instruction, observations and tool capabilities.

The current Harbor bridge prepares one tool binding before it assigns one
candidate run. The dynamic bind/start/retire loop above is **not wired into that
bridge yet**. The server cannot establish fresh model context by itself; it
requires that supervisor, the SDK execution thread, lifecycle hooks and the
authorized package assembly. Cancellation closes the channel, while the owning
supervisor must still stop the candidate and VM and seal the native outputs.

Validation: `python3 test-support/osworld_controller_smoke.py` uses real HTTP and
Unix sockets plus the existing Node tool client. Two synthetic phases verify
image bytes, distinct phase bindings, stale token/lease rejection, action retry
idempotence, cancellation and socket/thread cleanup. This runs no model or VM
and contributes zero real OSWorld task validations.

## Phase run storage

Hitch now accepts `benchmark_phase` run contexts with an eval parent,
`run_group_id` and `phase_index`. Each run seals its own native trajectory and
process outcome without a standalone benchmark observation. The generic runs
API can inspect and seal a group of consecutive phases with matching candidate
identity, distinct native sessions and verified bundle hashes. The group is
candidate evidence only; it does not publish a score or prove native completion.

The remaining supervisor must use a fresh candidate environment across native
resets and reinstall the runtime/tool binding before each model process. The
generic Harbor environment now provides `recycle_candidate_phase(phase_index)`
for this boundary (see below). VM and website state remain under the upstream
phase runner. The current one-bundle Harbor importer cannot publish these groups
yet; group import and reconciliation with native terminal/gate evidence remain
required.
See section 18 of `docs/provider-native-trajectory-comparison-spec.zh-CN.md`.

## Candidate container replacement

`integrations/harbor/hitch_candidate_recycle.py` is a trusted host component,
included in the controller runtime identity. It is not a candidate tool. The
supervisor must hold the trial lease, revoke the old phase token, finish/export
the old Hitch run, and only then call
`await environment.recycle_candidate_phase(phase_index)`. The method does not
validate those native/model preconditions, start a model, bind a token, or import
a phase bundle. No ordinary single-run trial invokes it automatically.

The method checks the Compose inventory and ownership labels, removes only
`main` (including its processes and writable layer), verifies its removal, and
atomically moves each Harbor log directory into the private host directory
`<trial>/hitch-candidate-phases/phase-NNNN/`. Fresh directories are mounted in a
replacement `main`; the old image's actual content ID is pinned with no build,
pull or dependency restart. The replacement's resource/configuration digest,
mounts and ownership must match. Every sidecar must retain its container ID,
image and start timestamp. The supervisor then reinstalls the harness/runtime,
creates the new run and uploads its new private tool binding before releasing
the next candidate.

Supported candidate mounts are fresh tmpfs, read-only binds disjoint from the
archive/log sources, and writable binds at Harbor's exact agent/verifier/artifact
log paths. Persistent volumes, extra writable host directories, shared log
mounts, symlinked sources, privileged containers and shared process namespaces
are rejected before retirement. This restricted contract fits an isolated CUA
client; arbitrary terminal task filesystem state must not be recycled this way.

An environment-only receipt records transitions and concrete container/image
identities. A completed call is idempotent while that replacement is current;
skipped phases, stale calls and failed/incomplete receipts cannot launch another
candidate. A failed operation requires the caller's whole-trial cleanup. The
archive is not a score, conversation reset proof, or native phase coverage proof.
It contains old run evidence but never a copy of Docker environment values.

Validation: `python3 test-support/harbor_candidate_recycle_smoke.py` covers
ownership, mount exposure, image/resource/configuration checks and failure/replay
gates. With the pinned Harbor 0.21.0 Python and a local
`node:22.23.0-bookworm-slim` image, run
`test-support/harbor_candidate_recycle_docker_canary.py` for two real Docker
replacements. It verifies old container removal, old log/writable-layer
invisibility, a stopped background writer, preserved sidecar state, and scoped
cleanup. It uses no model, VM or official OSWorld tasks.

## Preparing and executing one candidate phase

`HitchHarborAgent.prepare_phase(instruction=..., run_group_id=..., phase_index=...,
task_digest=..., remaining_timeout_ms=...)` reserves a fresh run ID without
starting a model. Call it after setup, then use `prepared.run_id` for the private
controller bind and upload that binding before calling
`await agent.run_phase(prepared, environment, phase_context)`. The handle is
immutable and can be consumed once by the creating agent. This API is separate
from the default single-run `run()` path; no standard package selects it yet.

The supervisor supplies the same frozen whole-task digest for each phase, even
when native instructions change. Preparation rejects reused/skipped phase
indices and task/candidate identity drift. Its monotonic deadline starts during
preparation, so private binding, uploads and proxy preflight consume the supplied
remaining whole-task budget. It never grants a fresh task budget per phase.
The CLI receives the reserved run ID and `benchmark_phase` context, with normal
sealing and no deferred benchmark observation. Unexpected emitted run IDs cannot
redirect the export to a different run. Process failures retain their diagnostics
and any successfully exported sealed bundle; they do not become task scores.

`copySealedPhaseRunBundle()` verifies the expected run/context/parent and original
index, copies every indexed file plus the original index, and verifies both
source and destination again. It preserves original bytes and digests, including
workspace, interaction and runtime evidence outside the old bridge's short file
list. A failed/partial destination is retained for diagnosis and never replaced
implicitly. The bridge stages this copy and publishes an external
`hitch-phase.complete.json` marker; inserting a marker into the sealed directory
would invalidate its index. Old phase files must be archived by the recycler
before another phase uses `/logs/agent`.

Validation: `test-support/harbor_phase_invocation_smoke.py` exercises the bridge
with stub Harbor I/O, including budget expiration during uploads, handle replay,
identity mismatch and export/process failures. `test/benchmark-phase-runs.test.ts`
executes actual Hitch runs with synthetic native harness processes, copies their
sealed phase bundles and verifies all file/index bytes plus identity/no-overwrite
gates. These tests do not run a model or OSWorld. Connecting native boundaries
to candidate cancellation, controller/agent supervision, fresh environment setup/binding orchestration and
whole-task assessment/import remain required.

## Cancelling a phase while retaining its evidence

After an authoritative native boundary, the supervisor may call
`await agent.request_phase_cancellation(prepared, environment,
reason="native_phase_reset")`. Other declared reasons are `native_task_finished`,
`task_budget_expired` and `cancelled`. The call returns a **request-only** receipt;
the supervisor must separately await the running `run_phase()` operation before
recycling. A normal cancelled process still raises `hitch_process_failed` through
the bridge, with its actual `hitch_status="cancelled"` and exported-bundle status
in metadata. The supervisor may only accept that combination after verifying the
native boundary and the complete bundle; it is not a success score.

The bridge uploads a private, run-scoped control configuration outside the run
bundle and passes its path via the internal `--internal-phase-control` option.
The CLI monitors the corresponding cancellation request, matching run ID and a
fresh 256-bit nonce, then aborts the existing executor through `AbortSignal`.
It does not terminate the Hitch CLI itself, allowing trajectory, workspace and
bundle sealing to finish. A request present before CLI start is also applied.
The executor catches cancellation arriving between process creation and abort
listener registration. Ordinary runs do not enable this control transport.

Configuration/request inputs are written with mode 0600. Validation requires
bounded regular files without group/other access; symlink, malformed, oversized
and stale requests cannot trigger cancellation.
The nonce stays in private agent memory/control files, outside the prepared
handle, argv, request record and run bundle. A candidate with root access inside
its own container can request its own cancellation. Thus cancellation status is
never proof of a native reset, gate, completion or grader result.

The host journal at `<trial>/hitch-phase-control/<run-id>.request.json` is outside
candidate log mounts. It records `prepared`, then `delivered` or `delivery_failed`,
without the nonce. Repeating the same delivered request while the phase is active
is idempotent; changing its reason or retrying an incomplete delivery is rejected.
The supervisor must impose a bounded shutdown/evidence-collection allowance. If
the run cannot seal, whole-trial cleanup and an invalid result are required; a
delivery receipt cannot substitute for evidence of process exit.

`test/phase-cancellation.test.ts` runs the actual Hitch CLI against a synthetic
native harness, checks stale requests, cancellation, valid native trajectory,
byte-preserving export and absence of the nonce from all bundle files. It also
tests cancellation during the launch-listener race and before launch. The bridge
I/O fixture checks host journaling, same-request replay, reason mismatch and
inactive-phase rejection. These are component tests, not real OSWorld validation;
native controller events are not yet wired to this API.
