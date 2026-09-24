# Opt-in resource adapter

The existing `import.mjs` and v4 datasets remain unchanged. `resources.mjs`
accepts an existing, verified v4 public-source dataset and explicit task IDs.

```sh
node benchmark-packages/automationbench/resources.mjs prepare-runtime --legacy /v4 --out /new/runtime-context --root /hitch --task marketing-ad_performance_review
```

Build this context once for `linux/amd64` and publish it to a registry you control.
The script never publishes. Record the platform manifest digest and configure
Hitch transport for both that runtime and an immutable candidate Python base.
The runtime recipe, source CAS, uv lock, upstream revision and image config are
distinct evidence. `prepare-runtime` creates a durable rebuild-input pin.

```sh
node benchmark-packages/automationbench/resources.mjs import --legacy /v4 --out /new/v5 --root /hitch --task marketing-ad_performance_review --recipe /new/runtime-context/recipe.json --runtime-image registry/runtime@sha256:PLATFORM_MANIFEST --candidate-image registry/python@sha256:PLATFORM_MANIFEST
```

Import verifies every selected v4 task, every shared runtime source against the
recipe and the source bytes inside the actual runtime image. It preserves task
instructions, simulator state, verifier, raw metric and scoring contracts.
Candidate, simulator and verifier have disjoint contexts. The new dataset has a
new identity. Existing v4 experiments must continue using their original refs.

See `docs/resource-storage.zh-CN.md` for supported backend limits, cache-only
offline requirements, explicit legacy export, pins, budgets and GC.
