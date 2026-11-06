# Titanic benchmark producer

This source example compiles downloaded Titanic CSV files into three ordinary
Hitch resource v2 datasets. It requires no changes to benchmark dispatch and does
not download data or submit predictions to Kaggle.

Build Hitch first. Prepare a Linux runtime image with Python >=3.10, the exact
versions in `runtime/requirements.txt`, Node >=22 and the fixed DSH carrier's
runtime prerequisites. `runtime/Dockerfile` adds the Python dependencies,
libseccomp2, and a root-owned `/opt/kaggle-runtime` chroot template to such a base.
Publish the image and use its **platform manifest digest**, not a mutable tag.
The execution host must support Linux chroot and seccomp and reserve UID/GID
65532 for the constrained pipeline subprocess. The candidate container's trusted
runner starts as root; the Python subprocess does not. The trusted DSH runtime
has model egress, while the Python worker's seccomp rules deny network access.
The separate verifier uses Harbor's `no-network` policy.

Configure the image's transport in Hitch's resource host as documented in
[`docs/resource-storage.zh-CN.md`](../../docs/resource-storage.zh-CN.md). The
producer uses `agent-hitch/resources` and requires a built checkout or installed
package exposing that public API.

```sh
node benchmark-packages/kaggle/import.mjs \
  --source /absolute/titanic-csv \
  --out /absolute/new-titanic-tasks \
  --root /absolute/hitch-state \
  --base-image registry.example/runtime@sha256:PLATFORM_MANIFEST \
  --platform linux/amd64
```

The source directory must contain `train.csv`, `test.csv`, and
`gender_submission.csv`. Real Titanic input requires 891 training and 418 test
rows. `--synthetic` accepts smaller contract fixtures and identifies the
competition as `titanic-synthetic`; these files are not competition submissions.

The command prints JSON with `competition`, `competitionDigest`, `seed`,
`heldOut`, `finalization`, and dataset digests. The output directory must not
exist. It is published atomically only after all datasets have been sealed.
All input leases are released after import; sealed task roots retain their CAS
inputs. Failed import can conservatively leave durable task pins, inspectable
through Hitch's existing resource cleanup tools.

`competition.json` records the original file hashes, exact split IDs, task-plan
hashes, runtime image, dependency versions and producer source identity. Data is
split deterministically by label and ID-derived hash order. Defaults are seed 42,
20% promotion holdout and five development folds. Changing any split or runtime
setting creates a new identity. Paths do not participate in semantic digests.

Each fold gets its own task and fresh container. Candidate resource bindings
provide `/data/train.csv`, `/data/predict.csv` (no target column), and
`/data/task.json`. Expected IDs/labels are bound only to the separate verifier's
`/tests/private`. The source task descriptors do not contain those data files.
The finalization task receives all labeled training rows; its verifier has test
IDs only and never treats the sample submission's guesses as true labels.

The fixed Gear carrier must expose only `run_pipeline`. It writes
`/output/predictions.csv` and trusted `/output/receipt.json`, which task artifacts
carry into the verifier at those same paths and into the run's output manifest
as `output/predictions.csv` and `output/receipt.json`.

Receipt protocol `kaggle-pipeline-receipt@1` binds `candidate_commit`,
`pipeline_digest`, `task_digest`, `seed`, `input_digests.train/predict`,
`exit_code`, `status`, and (on success) `predictions_sha256`. The task digest
is SHA-256 of UTF-8 JSON sorted by keys without whitespace, omitting its own
`task_digest` property. The outer Harbor task digest remains independent and
includes all descriptors/resources. A receipt is only trusted with the carrier's
process isolation and protected output ownership; candidate-written receipt
bytes alone do not prove which code ran.

The scorer parses CSV only. It validates exact columns, all expected IDs once,
binary labels, source receipt and prediction digest. Valid zero accuracy stays
a complete valid observation. Confirmed invalid predictions produce standard
`total_score=0`, `valid_output=0`, `completed=0`, with **no fabricated accuracy**;
the verifier exits normally. Both output files absent (no pipeline tool call) is
also a task failure; predictions present without their receipt is evidence loss.
A protected receipt reporting `infrastructure_error`, malformed
receipt, wrong task/input/source identity, or missing/tampered predictions after
a completed receipt instead raises an infrastructure error. Corrupt private
reference data also raises; verifier retries clear old rewards before scoring.
Infrastructure failure cannot be converted to a candidate zero. Finalization
returns output validity without accuracy. All tasks omit process_score.

Development and held-out datasets declare identical raw-metric contracts. Gear
should optimize `total_score` with `valid_output >= 1`, rather than make missing
accuracy on an invalid-output task a required optimization input. Development's
task macro average is mean-fold accuracy, not pooled OOF accuracy. Promotion
holdout used repeatedly for selection is not an untouched final test.

Run offline tests:

```sh
python3 -m unittest discover -s benchmark-packages/kaggle/tests -v
npm run build
node --test benchmark-packages/kaggle/tests/producer.test.mjs benchmark-packages/kaggle/tests/analysis-mlebench.test.mjs
```

The latter uses real resource CAS/materialization with a test OCI provider.
It also runs actual scorer outputs through Hitch's standard score and observation
conversion, including legal zero accuracy and invalid predictions with no accuracy.
Both suites also run through `npm test`. Worker CSV regressions cover both
analysis protocol versions with fixture subprocess results; they do not exercise
Linux chroot or seccomp. The sealed-runtime test checks the shipped worker hashes
against the entrypoint's manifest digest.
To additionally validate all generated task descriptors against an installed Harbor
schema (Python 3.12+), set `KAGGLE_HARBOR_PYTHON=/path/to/harbor-venv/bin/python`
when running the Node suite. That optional test imports Harbor's actual
`TaskConfig`; it does not substitute a schema model.
`tests/reward_fixture.py --out NEW_DIRECTORY` emits the same synthetic scorer
cases as JSON for downstream Gear conversion tests.
These tests do not claim Docker isolation, a paid model rollout, or actual Kaggle
submission. Those require the separately documented Gear end-to-end canary.
