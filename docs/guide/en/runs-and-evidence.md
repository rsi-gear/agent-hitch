# Read runs and evidence

Start with the run result, then examine the evidence needed to answer your question. Replace `RUN_ID`, `MESSAGE_ID`, and `CURSOR` below with values returned by Hitch.

## Find the run

```bash
hitch runs list --json
hitch runs inspect RUN_ID --json
```

Inspection reports the stored run and trajectory verification state. Check the status, requested and resolved harness, model identity, workspace, and result before comparing runs. A different model or starting workspace can explain different outcomes even when the harness version matches. See [model inference and evidence](model-inference.md#preserve-model-evidence) for endpoint configuration, self-hosted model versions, and the limits of model-name identity.

By default, records live under `~/.hitch/runs/RUN_ID/`. If you used `--root` or `HITCH_ROOT`, use that same root for inspection commands.

## Read a bounded trajectory

```bash
hitch trajectory project RUN_ID --profile analysis --json
hitch trajectory events RUN_ID \
  --types tool/call,tool/result \
  --limit 50 \
  --json
```

`project` produces a bounded analysis view. `events` filters at the source and returns a page with `next_cursor` and `eof`. For another page, pass the cursor unchanged:

```bash
hitch trajectory events RUN_ID --cursor CURSOR --limit 50 --json
```

The cursor retains the selection. Treat it as opaque. For field-level inspection with `--field`, you must supply an exact sequence window and the `canonical_sha256` returned by a prior bounded view. This prevents reading a field from a different underlying trajectory.

`hitch trajectory inspect RUN_ID --json` reads the full trajectory. Reserve it for explicit audits or small records; prefer the bounded commands in automation. Capture fidelity varies by harness. No trajectory may exist if startup failed before capture, and old references without a pinned canonical checksum cannot use the bounded views.

## Inspect evaluation evidence

```bash
hitch verifier inspect RUN_ID --json
```

For an evaluation trial, this exposes its observation, score channels, and available bounded verifier diagnostics. A regular local run may have no verifier result.

| Verifier status | Meaning |
| --- | --- |
| `complete` | A structured result and at least one supported test or log artifact exist. |
| `result_only` | The structured result exists, but those test/log artifacts were not retained. |
| `missing` | The run does not reference a structured verifier result. |
| `corrupt` | An identity, reference, JSON document, or checksum failed validation. |

A valid score of zero means the task earned zero. An invalid observation means its score cannot be trusted; it must not be counted as zero. See [evaluation results](evaluations.md) and the [verifier contract](../../verifier-evidence.md).

## Attach feedback

Choose an actual message ID from the trajectory before adding feedback:

```bash
hitch feedback put RUN_ID \
  --message MESSAGE_ID \
  --rating positive \
  --note "The answer identifies the correct test command"
hitch feedback list RUN_ID --json
```

Feedback is stored separately from the trajectory and is versioned. Updating feedback does not rewrite the captured conversation. Concurrent editors can use `--if-version` to reject stale writes.

## Use the machine interface

Inspection commands generally use `--json`. Execution commands use `--output json` for a final result or `--output jsonl` for events. When a command invoked with `--json` fails, read its stable JSON error envelope from stderr and check the process exit code. The [schemas](../../schemas) describe the versioned formats.

Next, [run a small evaluation](evaluations.md).
