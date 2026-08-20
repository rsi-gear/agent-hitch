# Hitch 0.2 Implementation — Pinned Baselines and Fixtures

Status: implementation record for `docs/hitch-0.2-development-spec.md` (Phase 0).

## 1. Pinned baselines

| Component | Baseline | Notes |
| --- | --- | --- |
| Hitch | `dev@c42ef93` (reviewed), implementation on `dev` | The spec's reviewed baseline. |
| DeepSeek Harness (DSH) contract | `141eb6fef83422698aef7a981029e843e8161534` | Pinned in `src/trajectories/contract.ts` (`CONTRACT_COMMIT`). Trajectory format, session header/event shapes, path encoding, and message-feedback semantics are pinned to this exact commit. |
| DSH session format version | `0` | `SESSION_FORMAT_VERSION` in `src/trajectories/contract.ts`. |
| DSH JSONL mode | `compression: none`, `packChunks: false` | Raw uncompressed JSONL per spec §5.2. No Zstandard frames or packed chunk rows in V1. |
| Gear | not yet pinned | Gear integration (spec §7) is Phase 5 and blocked by the registered overlay repository decision (spec §12.1). |

The DSH contract was re-checked against the pinned commit's sources:

- `packages/core/session/src/types.ts` — `SessionHeader`, `SessionEvent` envelope, `SurfaceEventType`, `SurfaceOp`.
- `packages/session/session-persistence-jsonl/README.md` — on-disk layout, project/session directory encoding, raw JSONL mode.
- `packages/feedback/message-feedback/README.md` — sidecar row identity, version semantics, business failures.
- `packages/llm/llm/src/message.ts` — `UserMessage` / `AssistantMessage` / `ToolResultMessage` shapes used by projected events.

## 2. Fixtures

Deterministic fixtures live under `test-support/`:

| Fixture | Purpose |
| --- | --- |
| `writeFakeCodex` | Deterministic Codex-like adapter with configurable delay/exit/split-reply; used by engine, scheduler, daemon, registry tests. |
| `writeFakePi` / `fakePiSource` | Deterministic Pi adapter (structured JSON, session id, usage, tool events); used by artifacts and engine tests. |
| `writeFakeOpenCode` | Deterministic OpenCode adapter (text + step_finish usage). |
| `writeFakeDeepseek` | Deterministic plain-text DSH headless output for the minimal-fidelity trajectory. |
| `writeFakeNpm` | Fake npm registry view/install for version resolution and artifact preparation. |
| `writeFakeHarbor` / `writeFakePython` / `writeFakeDocker` | Fake Harbor backend, Python venv, and Docker for eval tooling tests. |
| `forceRemove` | Removes trees containing read-only controller runtime bundles (promoted payloads are 0555/0444). |

## 4. Controller runtime payload layout

The runtime allowlist is the execution closure the Harbor bridge actually
runs — `dist/` is a TypeScript build detail, not a public ABI. The manifest
(schema `"2"`) declares the CLI entrypoint, which participates in the identity
hash and is executed relative to the upload root:

```text
package.json
dist/bin/   (compiled CLI entrypoint)
dist/src/   (compiled modules)
```

`dist/scripts/` (release tooling), `dist/test/`, and `dist/test-support/`
(build-time artifacts) are excluded, so editing a release checker never changes
a controller `runtime_id`, and a checkout runtime and an npm-installed runtime
hash to the same `runtime_id` (spec §4.4, §11.1).

The manifest shape (schema v2):

```text
{
  schema_version: "2",
  runtime_id: <sha256 of canonical { schema_version, node_range, entrypoints, files }>,
  node_range: ">=22",
  entrypoints: { cli: { path: "dist/bin/hitch.js", launcher: "node" } },
  files: [...],
  created_at: <descriptive, excluded from identity>
}
```

The Harbor Python bridge reads `manifest.json`, validates that the declared CLI
entrypoint is a non-absolute, non-traversing file in the declared `files` set,
uploads `<bundle>/payload` (a package root with `dist/`) to `/opt/hitch`, and
executes `/opt/hitch/<entrypoint>`. The bundle root's `manifest.json` and the
host cache path are host-side bookkeeping and are not identity (spec §4.2).

Verification enforces the content-addressed binding: the recomputed canonical
manifest digest must equal both the manifest's declared `runtime_id` and the
cache directory id, so a runtime id can never be rebound to a different
payload (spec §4.4, §11.1).

Planned-but-blocked fixtures (spec §10 Phase 0 / §12):

- **Deterministic mock model**: a fake model endpoint for DSH headless is only
  meaningful once DSH `--events jsonl` lands (blocker §12.2). The plain-text
  fixture (`writeFakeDeepseek`) covers today's wire contract.
- **Known tool-call fixture**: structured tool-call fixture exists via the
  Codex/Pi fake adapters; a native DSH tool-call fixture awaits the DSH event PR.
- **Minimal overlay repository fixture**: a `dsh-evolving` overlay repo fixture
  is blocked on the registered overlay repository decision (§12.1).

## 3. Source links checked at the pinned checkout

Every spec §13 reference was verified resolvable at the pinned DSH commit:

- `packages/core/session/src/types.ts` — session event types ✓
- `packages/session/session-persistence-jsonl/README.md` — JSONL persistence ✓
- `packages/feedback/message-feedback/README.md` — message feedback ✓
- `packages/bundle/headless/src/index.ts` — headless runner (plain text output; no `--events jsonl` yet, confirming blocker §12.2) ✓
