# Building the release VM image

The August benchmark manifest specifies the Ubuntu ZIP by both byte size and
SHA256. The currently resolved `v2026.06.24` tag points to a later repository
commit whose original ZIP filename has different contents. Resolving that tag
alone is therefore insufficient.

| Identity | Value |
| --- | --- |
| Benchmark release | `osworld-v2-2026.08.08` |
| SDK manifest commit | `d578d2d4e0dc82b43e270fdaa7fa89d9708cd154` |
| Required archive bytes | `14189763267` |
| Required archive SHA256 | `eb737ae70b49849e24af407de6a518439a23de05a8497096a948334ce0a909aa` |
| Matching historical dataset commit | `8213366932c553e5fe758d0f2c8c8b81ffc3be8c` |
| Archive filename at that commit | `osworld-v2-ubuntu-x86.qcow2.zip` |
| Sole ZIP member | `osworld-v2-ubuntu-x86.qcow2` |
| Expanded QCOW2 file bytes | `27402633216` |

The [release manifest](https://github.com/xlang-ai/OSWorld-V2/blob/d578d2d4e0dc82b43e270fdaa7fa89d9708cd154/benchmark_releases/osworld-v2-2026.08.08.json)
is authoritative for the archive digest. The
[historical dataset revision](https://huggingface.co/datasets/xlangai/v2-image/tree/8213366932c553e5fe758d0f2c8c8b81ffc3be8c)
contains an LFS pointer with that exact size and digest. Metadata is a source
selection check; downloaded bytes must still pass the full SHA256 check.

During investigation, tag `v2026.06.24` resolved to
`555126d3180e5e4605150cc916638e57883fed4a`. At that revision, the original filename
has SHA256 `f53ac2da4f40578def348c45d02c9f3209e3deedd451d194c46c94be585a1bb5`
and length `13995873636`; the release-matching bytes are retained under
`osworld-v2-ubuntu-x86.before-20260716T053042Z-repo-update.qcow2.zip`.
The build uses the historical commit and original filename, preserving the
benchmark's required bytes. It never accepts the newer file by name alone.

Create a fresh build context containing `artifact.zip`, `vm_owner.py`,
`vm_artifact.py`, and `Dockerfile.vm`. Download `artifact.zip` from:

[Immutable VM archive](https://huggingface.co/datasets/xlangai/v2-image/resolve/8213366932c553e5fe758d0f2c8c8b81ffc3be8c/osworld-v2-ubuntu-x86.qcow2.zip)

Copy `runtime/vm_owner.py`, `vm_artifact.py` and `runtime/Dockerfile.vm` from this
package into that context. Exclude temporary downloads and unrelated files with
a `.dockerignore`. Use a downloader that verifies HTTP range/length responses
when resuming, then build:

```sh
docker build --platform linux/amd64 \
  -f /path/to/context/Dockerfile.vm \
  -t local-osworld-vm /path/to/context
```

The `vm-runtime` build target can be prepared before the archive is available.
The default final target mounts `artifact.zip` read-only through BuildKit,
hashes the entire archive, checks the exact member name/count/size/type, verifies
the ZIP CRC while extracting, and publishes a read-only `/System.qcow2`.
The archive does not become an image layer. Zero extents are written sparsely;
the SHA256 covers every logical output byte. Failed publication removes the
extractor's own partial outputs.

The extractor rejects encrypted disks, external backing files and QCOW2 v3
external data-file features. `/hitch-vm/vm-artifact.json` records the source,
archive identity, extracted file hash/size and QCOW2 header identity.
`/hitch-vm/qemu-image-info.json` retains the actual `qemu-img info` result.
The recorded virtual disk size is distinct from the QCOW2 file size and from
the upstream runtime's `DISK_SIZE` setting. The runtime does not shrink an
existing larger disk when that setting is smaller.

The base runtime remains fixed at
`happysixd/osworld-docker@sha256:0e6497a9295647cf05bf2b2af522fdd79bdeba2737595259cab310a3bcf6baa9`.
The owner forces `MONITOR=none` and `SERIAL=stdio` on every launch. The upstream
entrypoint otherwise opens an extra unauthenticated monitor listener, which
must not bypass the lease-bound control API. Container environment overrides
cannot re-enable that listener. Image defaults also declare these settings.
Python installation uses Debian packages, so freeze the resulting final image
identity for a task package; repeated builds are not promised to be identical.
Retain enough host/Docker storage for the archive, expanded disk and image
export. Do not resize or replace the source disk to make a task fit.

`python3 test-support/osworld_vm_artifact_smoke.py` verifies hashing, member and
disk dependency rejection, exact output preservation and failed-publication
cleanup using small synthetic archives. A successful build proves artifact
assembly. Guest boot/reset, website trust, authorized tasks/assets and official
scoring still require their own execution evidence.

## Real guest component canary

```sh
python3 test-support/osworld_vm_container_canary.py \
  --image <immutable-local-image-id> \
  --acceleration tcg \
  --boot-timeout 900 \
  --network-policy isolated \
  --output /path/to/new-vm-canary.json
```

Select `kvm` on a worker with the appropriate device; select `tcg` explicitly
for software emulation. The canary uses a 4 CPU / 4 GiB guest in a container
limited to 4 CPUs / 5 GiB, with a fresh private network, lease volume and
writable storage. Ensure available memory and CPU headroom for other running
workloads. It publishes no host ports and mounts no Docker socket.
`isolated` creates an internal network with no external egress; `egress` uses a
dedicated bridge with outbound access. The policy and actual network setting
are recorded. Results from different network policies must stay separate.

The production PID-1 owner must return a real guest PNG. The canary then writes
one generated marker under the guest's `/tmp`, resets through the owner's
private control API, verifies the marker is absent, and obtains another PNG.
After closing the VM, it checks the overlay's backing file/virtual size, hashes
the entire immutable base again, and verifies QEMU has exited. Cleanup attempts
all owned resources even if diagnostic collection fails, then checks that no
containers, volumes or networks remain under the canary's unique label.
The canary also checks that the upstream monitor port is closed.

The receipt records actual image identity, resource/acceleration settings,
boot/reset timings, raw screenshot dimensions/digests, base preservation and
cleanup. TCG timing is not a claim about hardware-accelerated benchmark speed.
This has no candidate, authorized task or official evaluator; its real scored
task count remains zero. Initial guest resolution is recorded as observed;
the complete SDK/task setup must still satisfy the declared screenshot profile.
`passed` covers guest API boot/reset and resource ownership. It does not assert
that a desktop session or application is usable. `desktop_readiness_verified`
remains false: retain and inspect the PNGs, and verify the actual task's setup
and graphical interaction separately. Do not resize a screenshot to satisfy
the declared coordinate profile.

The local controlled-image canary completed on 2026-09-03 with TCG and the
`egress` policy. Initial API boot took 211.95 seconds and reset took 207.48
seconds. The guest marker disappeared after reset, the full base SHA256 was
unchanged, QEMU exited, and all owned containers/volumes/networks were removed.
The two retained 1280 × 800 screenshots were visually inspected: the first
shows a black display with an X-shaped cursor, and the reset image is black.
These images do not establish a usable 1920 × 1080 task desktop. The original
receipt is preserved; a separate visual-review record links its digest and
both screenshot digests. See `docs/benchmark-expansion-status.json` for the
local evidence paths and exact image identity.
