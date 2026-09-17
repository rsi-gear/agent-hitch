# Verifier evidence

Hitch exposes run-centered verifier evidence without requiring callers to read
the Hitch state directory or Harbor job directories:

```bash
hitch verifier inspect <run-id> --json
hitch verifier artifact <run-id> <name> --offset 0 --limit 65536 --json
```

The response follows
[`verifier-evidence.schema.json`](schemas/verifier-evidence.schema.json). It
contains the run's benchmark observation, normalized score channels, optional
structured process/feedback evidence, and any available bounded verifier
diagnostics. `reward: 0` remains a valid observation and is never treated as
missing.

For a standardized benchmark dataset, `reward.json` contains required
`reward`/`total_score` values and may contain `process_score`. `reward` is the
Harbor compatibility alias and must equal `total_score`. A benchmark with no
process metric, such as a total-only Terminal-Bench task, does not acquire a
synthetic process score. Older reward-only tasks are exposed as a total score
with `normalization: "legacy-reward"`.

When `process_score` is present, the verifier must also produce a schema-valid
`process.json` with the same score. `feedback.json` is independently optional.
Hitch validates component counts, weighted process aggregation, stable unique
component IDs, and feedback component references before an observation can be
valid. The inspector reports retained files under `structured_artifacts` with
their byte count and digest.

Verifier status has four values:

- `complete`: a structured result and at least one CTRF/stdout/stderr artifact
  exist;
- `result_only`: the structured result exists, but no CTRF/stdout/stderr
  artifact was retained. Structured infrastructure/retry diagnostics may still
  be present;
- `missing`: no structured verifier result is referenced by the run;
- `corrupt`: an evidence ref, identity, JSON document, or digest failed closed.

## Diagnostic retention

During Harbor trial import, Hitch copies the following files into the immutable
run bundle when available:

```text
verifier/ctrf.json
verifier/test-stdout.txt
verifier/test-stderr.txt
verifier/stdout.txt
verifier/stderr.txt
verifier/diagnostics.json
```

It separately collects only these schema-aware structured files:

```text
verifier/process.json
verifier/feedback.json
```

They have independent size limits and fail closed if unsafe, oversized, or
inconsistent with `reward.json`. Other verifier files are not exposed merely
because they exist in the Harbor output directory.

Persistence and inspection have separate limits. New imports sanitize each
recognized artifact and persist the complete sanitized value up to a 16 MiB
per-artifact hard cap. The 64 KiB bound applies to the inline `inspect` preview
and to each artifact page, not to the persisted artifact. Import callers may
lower the persistence cap through `verifierDiagnosticsMaxBytes`, but cannot
raise it above 16 MiB.

New `verifier/diagnostics.json` sidecars use schema version 2. Stored artifact
entries record the raw source size and digest and the complete sanitized size
and digest. The sidecar also records the applied hard cap and explicit `losses`.
An artifact whose source or sanitized form exceeds the cap is recorded with
`loss_reason: "persistence_limit_exceeded"`. Invalid `ctrf.json` is recorded
with `loss_reason: "invalid_json"`. Hitch does not persist a misleading partial
artifact for either case.

Artifacts are owner-only, credential/provider redaction runs before
persistence, and inspection applies credential and absolute-path redaction
again using the current environment. Public artifact byte counts and digests
describe the sanitized content available to inspection before its final output
excerpt. The response contains only fixed artifact names and run/eval/trial
identities—never Hitch, Harbor, or workspace absolute paths.

Older run bundles remain readable. A run that has only
`verifier/result.json` returns `result_only`; legacy verifier files already
inside the run bundle are bounded and validated at inspection time.

## Read a complete artifact in pages

Use the artifact command when an inline preview has `truncated: true` or when a
consumer needs the complete persisted value:

```bash
hitch verifier artifact RUN_ID ctrf.json \
  --offset 0 \
  --limit 65536 \
  --sha256 sha256:FULL_SANITIZED_DIGEST \
  --json
```

The response follows
[`verifier-diagnostic-page.schema.json`](schemas/verifier-diagnostic-page.schema.json).
`offset` and `next_offset` are UTF-8 byte offsets. `--limit` accepts 4 through
65536 bytes. Continue with `next_offset` until `eof` is true. Supplying the
artifact `sha256` from the first response or from `verifier inspect` provides a
version fence: Hitch rejects the request if the available sanitized artifact
has changed.

The command accepts only `ctrf.json`, `test-stdout.txt`, `test-stderr.txt`,
`stdout.txt`, and `stderr.txt`. `artifact.source_complete` distinguishes a
bounded page from permanent source loss. When it is false, `loss_reason` is one
of `persistence_limit_exceeded`, `invalid_json`, or `legacy_truncated`, and the
page is an empty terminal page. An inline `truncated: true` by itself may only
mean that a complete artifact needs more pages.

## Repair legacy truncated diagnostics

Historical schema-version-1 sidecars may contain only the old head/tail
excerpt. If the original local Harbor trial directory still exists, an
operator can import the complete diagnostics into a separate immutable
supplement:

```bash
hitch verifier repair RUN_ID --json
hitch verifier repair RUN_ID \
  --source harbor/attempt-0001/job/TRIAL_ID \
  --json
```

Automatic source selection checks only the run's two known legacy Harbor
locations, `harbor/job/TRIAL_ID` and
`harbor/attempt-NNNN/job/TRIAL_ID`, relative to the parent eval directory. It
requires exactly one existing location. `--source` must select one of those
exact eval-relative locations; absolute paths, traversal, symlinks, and an
unrelated trial are rejected.

Repair is available only when a sealed run has a schema-version-1 diagnostic
index with at least one truncated entry. Hitch requires every raw source size
and digest to match the identities already sealed in that index, requires the
recaptured schema-version-2 set to be complete, and rechecks the original
bundle and diagnostic index before publication. Legacy indexes that report
`known-credential-value-v1` redactions are rejected because retired credential
values cannot be reproduced safely.

The repair never changes the sealed run, its bundle index, observation, result,
or score. It publishes under
`derived/verifier-diagnostics/RUN_ID/ORIGINAL_INDEX_DIGEST/`; `repair.json`
binds the parent trial, original bundle digest, bundle-index digest, original
diagnostic-index digest, raw artifact identities, source location, and repaired
diagnostic-index digest. Reads verify those identities and the repaired
artifact digests before using the supplement. A repeated matching request
returns `already_repaired`; a run with complete diagnostics returns
`not_needed`; conflicting or tampered evidence fails closed. Schema-version-2
source losses are explicit but are not repaired by this legacy command.
