# Environment image service

Hitch's environment image service turns an explicit Docker build context into
an immutable, verified manifest before backend execution. Fixed task,
Verifier, and Compose registry references can be resolved before backend
execution and injected into Harbor as immutable digest references. Build
contexts keep their compatibility backend-build path until a safe build-stanza
replacement and version canary are available.

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

Remaining work:

- Dockerfile base-image resolution and BuildKit planning for discovered build
  contexts;
- version-canary-backed removal of a Harbor/Compose build stanza after a
  successful prebuild;
- post-start verification of the actual trial container image digest;
- image reference GC.

Successful, failed, and in-progress records have a stable `build_<id>` index.
An authenticated daemon exposes them at `GET /v1/builds/{build-id}` together
with the verified manifest when one has been promoted.

Any unresolved or build-context path remains explicitly `backend-build`; it is
never described as prebuilt.
