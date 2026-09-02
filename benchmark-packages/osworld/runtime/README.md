# OSWorld runtime components — integration in progress

These are OSWorld package components, not a standalone runnable benchmark.
The authorized-task producer, full Compose assembly, website
provisioning, release-specific metric mapping and two real OSWorld evaluations
are still incomplete. Harbor hooks and the fresh Hitch conversation supervisor
have component tests. The components below are separately tested;
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

The lifecycle prepare implementation calls `create_private_session('/control', hook_request)`
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
The supervisor must actually start a fresh Hitch run, retire the previous
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

The supervisor uses a fresh candidate environment across native
resets and reinstalls the runtime/tool binding before each model process. The
generic Harbor environment now provides `recycle_candidate_phase(phase_index)`
for this boundary (see below). VM and website state remain under the upstream
phase runner. The native-phase importer checks the complete controller audit,
candidate replacement receipts and all sealed phase bundles before publishing
one whole-task assessment. Ordinary single-run import remains separate.
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
immutable and can be consumed once by the creating agent. Standard packages with
`driver.config.native_phases` select the supervisor from `run()`; the supervisor
uses this per-phase API internally.

The supervisor supplies the same frozen whole-task digest for each phase, even
when native instructions change. Preparation rejects reused/skipped phase
indices and task/candidate identity drift. Its monotonic deadline starts during
preparation, so private binding, uploads and proxy preflight consume the supplied
remaining whole-task budget. It never grants a fresh task budget per phase.
The CLI receives the reserved run ID and `benchmark_phase` context, with normal
sealing and no deferred benchmark observation. Unexpected emitted run IDs cannot
redirect the export to a different run. Process failures retain their diagnostics
and any successfully exported sealed bundle; they do not become task scores.

`copySealedPhaseRunBundle()` verifies the expected run/context/parent, harness revision and original
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
gates. These tests do not run a model or OSWorld. The supervisor below connects
these APIs; standard-package selection and whole-task assessment/import also have
synthetic tests, described below.

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
inactive-phase rejection. These are component tests, not real OSWorld validation.

## Native phase supervisor API

`integrations/harbor/hitch_phase_supervisor.py` now connects the private controller,
candidate phase API and environment recycler. Its trusted host entry point is:

```python
from hitch_phase_supervisor import NativePhaseSupervisor

# After the initial environment/controller prepare and agent.setup(). These
# values come from a locked package/profile, not candidate tool output.
evidence = await NativePhaseSupervisor(
    agent, environment,
    controller={"service": "controller", "argv": [
        "python", "/opt/osworld/controller_client.py",
        "--socket", "/private/control.sock", "--session", "/private/session.json",
    ]},
    binding={"endpoint": "http://controller:8765/", "tools": locked_tools},
    task_digest=frozen_task_digest,
    timeout_ms=remaining_whole_task_ms,
    shutdown_timeout_ms=30_000,
).run()
```

The standard Harbor `run()` path selects this API only for a locked native-phase
tool-server task. A compatible frozen controller runtime and a lease are required.
The OSWorld authorized task producer, full VM/website lifecycle assembly and real
task validation remain incomplete; this example alone is not a runnable OSWorld
package.

The controller command accepts `{request_id, operation, parameters}` on stdin and
prints just its JSON output; `controller_client.py` authenticates privately.
`state` returns `{state, generation, sequence, run_id, prediction,
task_current_date}`. Generations must advance consecutively and sequences cannot
regress. A new `context_required` prediction has no binding. Its instruction,
including an empty string, and date are preserved in the candidate prompt.
`bind` must return exactly the locked endpoint/schema and a new phase token.
Only the token's private file is uploaded to the candidate; replies are never
copied into the host supervision journal.

Each authoritative reset/completion cancels the active candidate through Hitch
and awaits its exported sealed run. A cancellation receipt or quiet model alone
cannot advance the phase. A model that exits while another prediction still
needs an answer fails the trial; no extra conversation is invented within a phase.
`sdk_executing` allows native action evaluation to finish after normal model exit.
Control protocol v1 records wall-clock expiry as failure. Protocol v2 can ask the
private native runner to finish grading through the deadline adapter described
below; it never submits a synthetic DONE action.

At intermediate boundaries the old container is retired and its log directories
archived before host-side `inspectSealedPhaseRunBundle` checks every indexed file,
context, parent, harness revision, trajectory, native session and execution
interval. Then runtime setup and a fresh binding precede the next model. At the
last boundary, `stop_service("main")` also triggers the normal final snapshot;
it does not create an unused replacement container. Evidence requires consistent
harness/model identity, distinct native session IDs and non-overlapping runs.

`<trial>/hitch-native-phases/supervision.json` is private host evidence with
`candidate-evidence-only` scope. It records all observed boundaries and bundle
references, never scores or tool credentials. Failed delivery, exit, replacement,
inspection or native state initiates private cancellation and whole-trial cleanup.
The journal records whether cleanup is still required. A supervisor is single-use
and refuses to adopt an existing evidence directory. Lease-owner cleanup remains
necessary if teardown itself fails. The trial importer independently checks the
native controller audit and final grading files before accepting the group.

Validation: `test-support/harbor_phase_supervisor_smoke.py` combines the pinned
native phase functions, actual private Unix/HTTP RPC, actual Hitch CLI cancellation
and byte-preserved sealed bundles. The harness is synthetic; candidate containers
and setup are represented by a local directory adapter. Cases cover two phases,
gate termination, early model exit, schema/state errors, task budget exhaustion,
recycle failure, uncertain cancellation delivery and reused native sessions. This does not prove a full Docker/VM
deployment, and adds no official OSWorld task acceptance.

## Standard package and whole-task assessment

Declare the existing tool-server endpoint/schema/service and add:

```json
{
  "native_phases": {
    "protocol": "hitch-native-phase-control@1",
    "argv": ["python", "/opt/osworld/controller_client.py", "--socket", "/private/control.sock", "--session", "/private/session.json"],
    "audit_path": "/evidence/channel.jsonl",
    "shutdown_timeout_ms": 30000
  }
}
```

This fragment belongs to `driver.config`. Both task requirements and profile tool
policy must grant `native-phases@1`, `native-image-input` and
`tool-result-images@1`, in addition to the normal Compose/tool-server capabilities.
The task declares `/evidence` among its controller submission paths. The private
prepare hook returns `{"ready":true,"native_phases_ready":true}` inside its normal
hook `output`; it must omit static tool bindings or return an empty list. The
supervisor alone binds a reserved run ID and uploads the resulting phase token.

Compiler `harbor-package@4` retains the original source task and candidate time
budget. Its compiled Harbor outer agent timeout adds
`3 * collection_timeout_ms + 2 * cleanup_grace_ms` for final cancellation/export,
host inspection, snapshot and teardown. This outer guard cannot increase the
candidate deadline. Phase shutdown is limited to the profile collection allowance
and at most 600,000 ms. Intermediate setup, binding and execution consume the same
whole-task deadline. Protocol v1 retains its original invalid-on-wall-clock-expiry
behavior. Protocol v2 has a separate, bounded native finalization allowance.

`src/evals/native-phase-evidence.ts` verifies the frozen source and compiled trees,
all original run identities/bundle bytes, every native generation and prediction,
screenshot hashes, matching private run bindings and final `completed` event.
Retirement receipts must form an unbroken chain of fresh candidate containers with
unchanged image/configuration/ownership and preserved sidecars. A truncated audit,
foreign binding, missing phase or changed receipt cannot settle a valid trial.
The independent verifier's metric membership, ranges, source task ID, task digest,
metric map and Harbor primary reward must agree. A valid zero is retained.

The resulting trial reference has exactly one candidate form: `run_id` for an
ordinary task, or `run_group: {run_group_id, digest}` plus mandatory
`assessment: {id, digest}` for a native-phase task. A group counts once per task
and attempt. It never invents a representative run ID or gives each phase the
whole-task grade. Original bundles remain byte-for-byte sealed under `runs/`.

Whole-task evidence is stored under
`evals/<eval>/assessments/<assessment>/evidence/`: original controller artifacts
and verifier files, supervision/lifecycle records, candidate replacement receipts,
resource/image evidence and per-phase interaction capture. `assessment.json`
commits the group reference, observation, metric contract and evidence tree digest.
Readers recheck the assessment, all group members and native evidence. Replayed
imports reuse the same assessment only when source evidence is unchanged; partial
uncommitted destinations are retained for diagnosis rather than overwritten.

The separate `eval/publication.json` receipt and eval progress can be recovered
from a committed assessment after an interrupted publication. Recovery validates
the complete evidence before settling the trial. `collect-only` recognizes the
group reference; verifier-only regrade and the remote single-bundle transport
currently reject groups explicitly.

Validation: `test/native-phase-assessment.test.ts` imports two actual Hitch runs
with synthetic harness output as one task, keeps zero reward and original bundle
bytes, replays the import, recovers a missing publication receipt, and rejects
truncated/misbound/tampered evidence. The supervisor smoke test invokes standard
`HitchHarborAgent.run()` for both two-phase and gate-completion cases. These are
contract tests with synthetic task/controller evidence; no official OSWorld task
or model score is claimed.

## Native final-state grading at a deadline

Select `hitch-native-phase-control@2` in the same `native_phases` object and add
`finalization_timeout_ms`, bounded by the profile's collection allowance. This
limits the entire post-deadline stop, seal, native grading and snapshot operation. The
prepare hook must also return `native_deadline_ready: true`. The controller must
use both `ControllerServer(..., native_deadline=True)` and
`run_native(..., finalize_on_budget=True)`; announcing readiness without the
matching runner will fail at finalization. The compiled Harbor watchdog reserves
`4 * collection_timeout_ms + 2 * cleanup_grace_ms` beyond the source agent budget.
Model execution still consumes only the original shared task deadline.

The host supervisor checks its monotonic deadline, journals elapsed time, and
calls private `expire_budget`. The channel atomically revokes the candidate tool
token, records generation/sequence/binding plus any unfinished prediction or
submitted-but-not-consumed batch, and wakes the native loop. Candidate HTTP tools
cannot call this operation. While the SDK grades, the management state is
`finalizing`; `completed` is written only after native result persistence.

`deadline_runner.py` checks the exact upstream `lib_run_single.py` SHA256 before
adapting two prediction loops, two action call sites and the phase loop. It adds
budget checks and catches only the private `CandidateBudgetExpired` exception at
those loop boundaries. This returns control to the original evaluator, gate,
partial-score accumulation and result-writing code. It does not append DONE,
FAIL, ASK_USER or invented candidate output. No new action starts after the
controller expiration fence; an already executing action is allowed to settle.
The next phase cannot start a candidate after expiry. Ordinary runtime/evaluator
errors still fail the trial.

This is an explicitly identified Hitch control-flow adaptation, not a claim that
the upstream runner natively supports wall-clock finalization. The source file is
not edited and its module globals are not patched. The adapter compiles isolated
copies of the two entry functions; `deadline-adapter.json` and the returned runner
metadata contain the original source, adapter and transformed AST hashes. The
package snapshot must include this native result directory in its controller
artifacts. Single-task result dictionaries and multi-phase result files retain
their original contents and scoring semantics; strict score derivation remains a
separate release/task contract.

After expiration, the supervisor allows only bounded candidate sealing and native
grading, then stops/snapshots the candidate environment. If the last candidate was
already retired during a phase transition, its archived bundle remains the final
group member and the fresh unused replacement is stopped. No empty or duplicate
candidate run is invented. An unbound native phase at the end may appear in the
audit, but every phase with a candidate binding must have a verified group member.
Expiry before any candidate evidence exists, missing bundles, ordinary candidate
failure, grader failure or an exhausted collection allowance remain invalid.

The importer accepts a final `timed_out` process only with protocol v2, the frozen
task deadline, a completed private finalization receipt and the matching complete
native audit. The process status stays `timed_out` in its original bundle; the
whole-task observation belongs to the assessment. Extra actions after the budget
event, a missing binding or a mismatched receipt are rejected.

Validation uses the exact Apache-2.0 upstream source fixture (see its provenance
and license under `test-support/fixtures/osworld/`). Tests cover normal/gated
parity, pending-prediction expiry, interruption within a submitted action batch,
second-phase expiry, raw single-task results, real Hitch CLI timeout and private
RPC, expiry during candidate replacement, and native evaluator failure. Import
tests keep zero reward and the original timed-out bundle, accept the archived
last candidate with an unbound native tail, and reject altered deadline evidence.
These tests use synthetic environments, harness output and graders. Official VM,
authorized task/assets, website lifecycle and real two-task validation remain
outstanding.

## Controller process and Harbor lifecycle

`controller_lifecycle.py --config /config/controller.json` must be PID 1 in the
dedicated controller service, with a fresh private directory. It owns one
`native_worker.py` subprocess and its descendants. The service entrypoint must
invoke Python directly, without a shell wrapper or `init: true`. The worker
loads the task through the pinned SDK task loader, uses `create_desktop_env`,
and calls `run_native`. Candidate tools stay in that child; lifecycle requests
use a separate mode-0600 Unix socket and never become public tools.

The producer must generate a frozen `osworld-controller@1` JSON configuration
with exactly these fields. All paths are absolute container paths. The identity
and budget values below must be derived from the frozen package/profile; there
are no guessed defaults for an official leaderboard setting.

| Fields | Required value / constraint |
| --- | --- |
| `protocol` | `osworld-controller@1` |
| `task_id`, `source_task_id` | Package task ID; native filename ID such as `task_031` (not an assumed SDK task object's internal ID) |
| `profile_digest`, `task_sha256` | Exact `sha256:` identities from the frozen producer output |
| `sdk_root`, `sdk_commit` | Read-only SDK root; `d578d2d4e0dc82b43e270fdaa7fa89d9708cd154` |
| `task_path` | Verified authorized file ending in `<source_task_id>.py` |
| `assets_directory` | Existing read-only local snapshot of the authorized release assets; worker explicitly sets `OSWORLD_FILE_BASE_URL` to this path before loading the task |
| `private_root` | Fresh private directory, e.g. `/private/runtime`, mode 0700 |
| `session_directory` | Controller/VM-only volume, e.g. `/control`; candidate and guest must not mount it |
| `evidence_directory`, `cache_directory` | Separate fresh writable roots, e.g. `/evidence` and `/cache` |
| `max_steps` | Native prediction-step budget, integer 1–100000; not an action count |
| `max_actions_per_turn`, `max_text_bytes` | Declared channel limits, 1–256 and 1–1048576 |
| `max_artifact_bytes` | Exact package submission limit, 1–107374182400 |
| `prepare_timeout_sec`, `shutdown_timeout_sec` | Explicit component limits, 1–3600 and 1–600 |
| `sleep_after_execution` | Declared native action delay, 0–60 seconds |
| `native_deadline` | Boolean; true only with the declared native-control v2 profile |
| `public_endpoint` | Explicit private service URL, e.g. `http://controller:8765/` |
| `website_host_suffix` | Explicit namespace of the separately provisioned private websites; set before importing the SDK |
| `client_password_file` | Null to use the SDK's public evaluation default, or a private mounted file outside writable roots |

The loader hashes the exact config bytes and verifies the task file plus four
pinned SDK core files. Action definitions and the native runner have their
existing independent checks. Writable roots cannot overlap each other, source
paths, the config or password file. These checks do **not** establish membership
in the gated release manifest or validate the full SDK/dependency tree: the
authorized producer still has to verify release membership, assets, full source
and runtime image digests. Use a read-only image/source mount at execution time.

Each `task.hitch.json.lifecycle` phase targets `service:controller` and invokes:

```text
python /opt/osworld/lifecycle_client.py --socket /private/runtime/lifecycle.sock --timeout-sec <phase-client-limit>
```

The ordinary Harbor hook envelope arrives on stdin. The client returns exactly
`{schema_version, request_id, status, output}`. Task/profile, lease, epoch and
logical trial must match. Successful and failed calls retain their request
digest and response; replay never starts another SDK. Conflicting identities,
concurrent duplicates, phase reordering and adoption of an old private directory
fail. Cleanup can interrupt prepare; a late observation cannot reopen the owner.

| Phase | Behavior and successful output |
| --- | --- |
| `prepare` | Publish the private session, create fresh evidence/cache, start SDK; wait for generation 1's actual pending observation and matching config digest. Return `ready`, `native_phases_ready`, `native_deadline_ready`; no candidate binding. |
| `quiesce` | Require native completion and persisted worker metadata. Stop/reap SDK and adopted helpers before returning `quiesced: true`. Missing grading/completion or a crash cannot be turned into success. |
| `snapshot` | Require quiescence; hash regular files only, reject symlinks/hardlinks/special files, enforce byte/file limits, write `snapshot.json`, and return the exact submission path and total bytes including the manifest. |
| `cleanup` | Revoke active tools, stop/reap SDK, call the lease-bound VM close endpoint. Return `cleaned: true` only after both stops are confirmed. Persist failure types even if VM closure throws; never persist exception messages or credentials. |

Lifecycle receipts and SDK stdout/stderr remain private. Evidence contains
`channel/channel.jsonl`, original screenshots, `native/` raw SDK results,
`native-execution.json` and `snapshot.json`. The snapshot lists pre-manifest files
with size/hash and binds config/task/trial identity; Harbor independently
collects and hashes the final directory. A manifest alone is not a valid score.

Configure native-phase private argv separately:

```text
python /opt/osworld/controller_client.py --socket /private/runtime/phase.sock --session /control/session.json
```

Set its `audit_path` to `/evidence/channel/channel.jsonl`; declare controller
artifact source `/evidence` in the Harbor task and the same path in the package
submission. The original whole-task candidate deadline remains in the profile.
For component shutdown limit S, allow at least `3*S + 18` seconds plus transport
margin for worst-case cleanup (private cancellation, TERM/KILL, helper reaping
and VM close), and prepare limit plus that margin for failed-prepare cleanup.
Collection must cover native completion waiting, child shutdown, and hashing all
allowed artifacts. Set hook client and Harbor/profile timeouts consistently;
exhaustion fails the trial and Harbor service teardown is the final fallback.
Website namespace provisioning/reset must also fit the profile; this component
does not provision websites merely by setting their suffix.

Validation: `python3 test-support/osworld_lifecycle_smoke.py` runs 10 cases using
real owned processes, Unix/HTTP transports, the hook CLI and `BenchmarkSession`.
It checks observation readiness, late worker writes included only after exit,
snapshot bytes/digests, receipt replay, stale leases, config mismatch, failures,
cleanup during prepare, forced kill, linked evidence and private credentials.
`test-support/osworld_lifecycle_pid1_canary.py` additionally runs as PID 1 in a
disposable Linux container, verifies adoption and reaping of a daemonized helper,
and confirms snapshot follows child shutdown. The SDK task/VM/grader are
synthetic in these tests. No official guest boot, website reset or authorized
OSWorld task has been validated by them.

## Building the controller image

`../prepare-controller.py` exports all 1086 regular files from SDK commit
`d578d2d4e0dc82b43e270fdaa7fa89d9708cd154`, checks the pinned tree and each Git
blob, and records SHA256, byte length and mode. It copies the package runtime
separately and publishes a fresh context with `source-manifest.json`. Local
worktree edits, untracked files, credentials and Git configuration are excluded.
The `desktop_env/server` gitlink is recorded but not initialized: the guest
server is supplied by the separately verified official VM image.

```sh
python3 benchmark-packages/osworld/prepare-controller.py \
  --sdk-checkout /path/to/OSWorld-V2 \
  --out /path/to/new-controller-context
docker build --platform linux/amd64 \
  -f /path/to/new-controller-context/runtime/Dockerfile.controller \
  -t local-osworld-controller /path/to/new-controller-context
```

`Dockerfile.controller` pins Python 3.12 and uv to resolved image digests. It
installs the upstream base dependencies with `uv sync --locked`, preserving the
upstream `pyproject.toml` and `uv.lock` bytes and excluding optional legacy/full
extras. This follows the [uv Docker guidance](https://docs.astral.sh/uv/guides/integration/docker/).
The installed Python and Debian package inventories are retained in `/opt/`.
Debian repositories and isolated Python build dependencies can change between
builds, so a rebuild is not promised to be byte-identical: resolve and freeze the
**resulting image digest** for each benchmark package. Additional dependencies
needed by an authorized task must become another explicit image/profile.

The image entrypoint verifies all SDK/runtime files, modes and Python package
versions before `exec` preserves PID 1 for the lifecycle owner. Its configuration
must use `/opt/osworld-sdk`. `--verify-image` runs only the integrity check and
does not start a task. Source directories and `/opt/venv` should remain read-only
at runtime; private, session, evidence, cache and working directories need
separate writable storage. No host Docker socket is required inside this image.

The worker sets both the private website namespace and local asset base before
SDK imports. It supplies the original runner's `sleep_after_execution` and the
original result logger's `result_dir`; summary records remain under
`native/summary/results.json`. An evaluator result alone does not make the
worker completed: native logging, recording download and persistence must finish
first. Private failure status includes exception type and frame locations, not
exception messages, credentials or candidate-visible diagnostics.

`python3 test-support/osworld_sdk_container_canary.py --image <image-id> --output
<new-receipt.json>` exercises the production image entrypoint and worker with
the installed SDK loader/environment and declared deadline adapter over the
byte-pinned runner source. It uses a synthetic
task, a mock guest/control endpoint in a network-disabled container and a scripted
DONE submission; there is no model or real VM. The SDK's 60-second preparation
sleep is retained. The canary checks native result/summary persistence, image
identity, local asset resolution, quiescence, snapshot and VM-close transport.
It is an integration gate, not either of the two selected official OSWorld tasks.
