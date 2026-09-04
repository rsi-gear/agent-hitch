# Verifier evidence

Hitch exposes run-centered verifier evidence without requiring callers to read
the Hitch state directory or Harbor job directories:

```bash
hitch verifier inspect <run-id> --json
```

The response follows
[`verifier-evidence.schema.json`](schemas/verifier-evidence.schema.json). It
contains the run's benchmark observation, structured verifier result, and any
available bounded verifier diagnostics. `reward: 0` remains a valid
observation and is never treated as missing.

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

Each artifact has an independent byte budget (64 KiB by default). Small files
are retained in full; large files retain a head and tail excerpt. The sidecar
records source, complete-redacted-content, and stored-excerpt digests and byte
counts. Import callers may override the per-artifact budget through
`verifierDiagnosticsMaxBytes`.

Artifacts are owner-only, credential/provider redaction runs before
persistence, and inspection applies credential and absolute-path redaction
again using the current environment. Public artifact byte counts and digests
describe the sanitized content available to inspection before its final output
excerpt. The response contains only fixed artifact names and run/eval/trial
identities—never Hitch, Harbor, or workspace absolute paths.

Older run bundles remain readable. A run that has only
`verifier/result.json` returns `result_only`; legacy verifier files already
inside the run bundle are bounded and validated at inspection time.
