# Managed VM components — integration in progress

These are OSWorld package components, not a standalone runnable benchmark.
The authorized-task producer, controller tool server, website provisioning,
multi-phase task runner and two real OSWorld evaluations are still incomplete.

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
VM checkpoint export explicitly. Multiphase orchestration and bounded CUA action
mapping belong in the pending controller. The provider alone must not be
advertised as full OSWorld support.

Validation: `python3 test-support/osworld_vm_smoke.py` exercises real child
process start/stop, stale credentials/epochs, storage reset, base preservation,
and failure receipt idempotence with a synthetic readiness endpoint. This proves
process/lease behavior only. A booted official OSWorld guest and official task
reset/evaluate remain unverified until the matching inputs and worker exist.
