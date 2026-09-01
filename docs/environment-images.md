# Environment image service

Hitch's environment image service turns an explicit Docker build context into
an immutable, verified manifest before backend execution. Fixed task,
Verifier, and Compose registry references can be resolved before backend
execution and injected into Harbor as immutable digest references. Build
contexts are prebuilt when every Dockerfile base is digest-pinned. The Harbor
overlay injects the resulting immutable local config digest and uses Compose's
`!reset` merge tag to remove the original main-service build stanza.

The service hashes every regular context file (path, content digest, executable
bit), the Dockerfile, non-secret build arguments, platform, target, immutable
base-image digests, and secret names. Secret values are passed to BuildKit only
through `--secret id=NAME,env=NAME`; they are not included in cache keys,
manifests, build records, or errors.

Builds are serialized by a persistent cache-key lock under `locks/builds/`.
After acquiring the lock, every caller rechecks the stored manifest and probes
the actual local image identity. Ten independent service instances requesting
the same key therefore produce one BuildKit invocation. Successful manifests
are promoted under `store/environment-images/sha256/`; bounded build state is
stored separately under `store/build-records/sha256/`.

`BuildSlotAdmission` reserves `build_slots` in the same global resource ledger
used by evals while keeping `container_slots` independent. The default build
reservation is one build slot and no trial container slot. Operators can pass a
larger CPU/memory build vector when their builder needs it.

`DockerBuildKitBuilder` uses `docker buildx build --load`, a metadata file for
the output manifest/config digests, and `docker image inspect` for platform and
cache-hit verification. Optional registry cache references are derived from
the service cache key under an operator-controlled prefix; user input cannot
select an arbitrary cache tag.

`npm run canary:buildkit-secrets` performs a real, offline-capable Docker
canary against a locally available base image. It rotates a BuildKit secret,
requires the second build to reuse cache without changing the config digest,
and scans the saved image plus exported local or inline cache evidence for both
secret values. `HITCH_DOCKER_CANARY_BASE` and
`HITCH_DOCKER_CANARY_PLATFORM` select a different preloaded base/platform.

`DockerRegistryResolver` resolves both mutable tags and explicit digest
references through a platform-specific pull and local OCI identity probe. The
persisted manifest always uses a `repository@sha256:...` reference; an explicit
input digest must match exactly, and the resolved OS/architecture plus config
digest are verified before promotion. A later request for a mutable tag still
resolves the tag again, so a moved tag creates a new content identity instead
of returning a stale tag-based cache entry.

Eval planning discovers fixed `docker_image` and Compose `image` references,
persists successful resolutions in work-item `image_refs`, and persists every
fallback reason separately. `prebuild-preferred` can fall back; a
`prebuild-required` request fails before Harbor starts if any service cannot be
prebuilt. Harbor's final Compose overlay replaces only exact discovered image
references and the same mapping is reused by infrastructure retries.
Before a planned work item starts Harbor, every referenced global manifest is
reloaded and matched against the immutable plan. Each imported or diagnostic
run then embeds the uses and full, de-duplicated manifests in
`environment/image.manifest.json`; the sealed bundle index records their OCI
digests together with provider/worker/lease and requested/observed resources.
Owned Harbor environments retain containers until the fenced Hitch reaper runs.
The resource observer records Docker's configured image reference and config
digest, and a planned immutable image is accepted only when that config digest
was actually observed during the trial.

`npm run canary:docker-images` starts three ownership-labeled containers with
distinct main, sidecar, and separate-Verifier config digests. It runs the real
Docker observer, verifies every planned digest, and proves a forged Verifier
digest fails closed. The command builds from a temporary export of the selected
local base, so it does not require registry access.

Every Hitch-built image carries root-id and cache-key labels. Eval planning
writes a provisional image-reference record under a global reference fence
before the execution plan is published. `hitch images gc` is a dry run by
default; `--apply` is required to remove anything. GC holds the same fence and
retains images referenced by non-terminal evals, self-consistent sealed bundle
indexes, or explicit `hitch images pin` records. A local build tag is eligible
only after its config digest, root-id label, and cache-key label all match the
stored manifest. Registry-owned images are never deleted. The default minimum
age is 24 hours and can be changed with `--minimum-age`.

Successful, failed, and in-progress records have a stable `build_<id>` index.
An authenticated daemon exposes them at `GET /v1/builds/{build-id}` together
with the verified manifest when one has been promoted.

Any unresolved or unsupported build-context path remains explicitly
`backend-build`; it is never described as prebuilt.
