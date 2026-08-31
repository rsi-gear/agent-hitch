# Environment image service

Hitch's environment image service turns an explicit Docker build context into
an immutable, verified manifest before backend execution. It is additive: the
current Harbor adapter still uses its compatibility backend-build path until a
version-specific digest-overlay canary is available.

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

Not yet wired into eval execution:

- Harbor task/Compose environment discovery and immutable base-image
  resolution;
- version-canary-backed replacement of a Harbor build stanza with a digest;
- post-start verification of the actual trial container image digest;
- image reference GC.

Successful, failed, and in-progress records have a stable `build_<id>` index.
An authenticated daemon exposes them at `GET /v1/builds/{build-id}` together
with the verified manifest when one has been promoted.

Until those are implemented, status and result records must describe the
existing path as `backend-build`, not `prebuilt`.
