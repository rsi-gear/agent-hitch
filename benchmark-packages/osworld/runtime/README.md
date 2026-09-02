# OSWorld runtime components — integration in progress

These are OSWorld package components, not a standalone runnable benchmark.
The authorized-task producer, authenticated controller tool server, website
provisioning, fresh Hitch conversation supervisor and two real OSWorld
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
It must not forward prior-phase conversation history into the new run. HTTP
authentication, lease/epoch checks, candidate termination and resource ownership
remain responsibilities of that assembly. Channel cancellation alone cannot
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
