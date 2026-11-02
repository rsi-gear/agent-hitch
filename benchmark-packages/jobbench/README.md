# JobBench producer

This independent producer emits Package v1, which `hitch benchmark compile`
turns into an ordinary Harbor dataset. No benchmark-specific Hitch dispatch is
needed. It uses the official Harbor renderer, `verify.py`, `judge.py`, artifact
readers, calculation runtime and rubric JSON from a clean pinned source checkout.
Renderer code and every `__file__` resource are loaded from a temporary tree of
the requested commit's exact tracked Git blobs, without checkout filters or
`export-ignore` omissions. Ignored local files cannot enter imports or verifier
inputs. Symlinks, submodules and unsafe/nonportable Git paths are rejected;
imports and temporary files are restored/removed even if rendering fails.
The optional upstream `[task]` package identity table is removed so Harbor uses
the flat task directory consistently as its task name; original configuration is
retained as a transformation source. The candidate receives the original public task folder; rubrics, task cards and
hidden search references are withheld. Final files are exported from
`/workspace/output` to a separate verifier and retained for artifact-only regrade.

The importer needs Python >=3.9 and no external Python packages. Execution needs
Docker, Linux/amd64 images, the current Hitch Harbor 0.21 runtime, and public
network access for image/package downloads, candidate model calls, the judge,
and tasks that require live research. Agent search/browser support depends on
the selected harness. The official source targets Harbor 0.22.0; its schema 1.4,
separate verifier and artifact configuration have been parsed by Harbor 0.21.0,
but container execution has not been verified in this change.

## One task: acquire, import, validate and compile

The pinned code revision is `660b33a86ed032559df0b2fdc1ad38cf7ceb83f3`.
The public HF dataset revision checked here is
`d43a66575635da0d3f6cb9a20976dc1a60f3ffc9`. Acquire a complete split for random
sampling or coverage reporting; this example downloads its raw task inputs and
rubrics without the hidden search references:

```sh
git clone https://github.com/Job-Bench/job-bench-eval.git /sources/job-bench-eval
git -C /sources/job-bench-eval checkout 660b33a86ed032559df0b2fdc1ad38cf7ceb83f3
uv run --with huggingface-hub==0.34.0 python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="JobBench/job-bench", repo_type="dataset",
    revision="d43a66575635da0d3f6cb9a20976dc1a60f3ffc9",
    local_dir="/sources/jobbench-data",
    allow_patterns=["dataset/*/task*/task_folder/**",
                    "dataset/*/task*/RUBRICS.json",
                    "dataset/*/task*/task_card.md"],
)
PY
python3 benchmark-packages/jobbench/import.py \
  --source /sources/job-bench-eval \
  --snapshot /sources/jobbench-data \
  --dataset-revision d43a66575635da0d3f6cb9a20976dc1a60f3ffc9 \
  --task main--biostatisticians--task1 --out /packages/jobbench-one
hitch benchmark validate --package /packages/jobbench-one
hitch benchmark compile --package /packages/jobbench-one \
  --out /datasets/jobbench-one
```

Omit `--task` and use `--seed 20261019 --count N` to rank the entire provided
snapshot split by `sha256(seed + NUL + task ID)` before reading task contents.
`--task` is repeatable and records explicit selection. `--split easy` reads
`dataset_easy` instead; download its corresponding raw paths first. The pinned
upstream release describes 65 main and 63 easy tasks; the importer does not
hardcode these counts. Membership and its digest describe the provided snapshot,
so a partial download cannot establish complete-split coverage. A caller-supplied
HF revision alone does not attest the downloaded bytes to that commit; selected
source-file hashes are recorded. Keep acquisition receipts when verifying those
hashes against HF blob/LFS metadata. Imports refuse existing output directories
and fail on missing required inputs or unsafe source paths.

## Independent candidate and judge configuration

Set the candidate's own provider key in the launching process and set the
separate judge key as `HITCH_JOBBENCH_JUDGE_API_KEY`, through your existing secret
manager or shell environment. Supply values at runtime; never put them in a
package, profile, Dockerfile or build argument. **Do not pass the dedicated judge
variable with `--pass-env`**: that option gives values to the candidate. The task's
verifier-only template maps the dedicated host variable to `JUDGE_API_KEY` after
the candidate exits. Known provider variables such as `OPENAI_API_KEY` may be
passed to the candidate automatically; keep judge keys under the dedicated name.

```sh
# OPENAI_API_KEY and HITCH_JOBBENCH_JUDGE_API_KEY are already set privately.
hitch eval run --dataset /datasets/jobbench-one \
  --harness codex@version:0.145.0 --model YOUR_CANDIDATE_MODEL \
  --pass-env OPENAI_API_KEY
# Replace EVAL_ID with the returned evaluation ID.
hitch eval inspect EVAL_ID --json
hitch eval rerun EVAL_ID --task main--biostatisticians--task1 \
  --type verifier-only
```

Candidate and judge calls incur their providers' charges. The default judge is
upstream `grok-4.3` at `https://api.x.ai/v1`. `--judge-model`, `--judge-base-url` and
`--judge-workers` lock a different judge configuration into a new package; a
substituted judge must be reported with its scores. Judge credentials are local
worker environment inputs, not dataset contents. The supported recipe above is
local direct execution; a resident worker must be launched with the required
dedicated variables in its own environment. Remote credential binding has not
been added or validated by this producer.

## Scores, failures and evidence

The official judge awards a block's full weight only when all its criteria pass.
Each task's `round(earned / maximum, 4)` reward maps to `total_score`; Hitch takes
the task macro mean. Multiply by 100 to report the percentage. A complete main
result needs one valid observation for each main task. Missing or failed
judgements must not be silently excluded and presented as a full result. The
unweighted rubric pass rate stays in the official details, and no process score
is fabricated.

An empty submission retains the official valid zero behavior without an API
call. API errors, malformed responses, invalid/nonfinite rewards and unsafe
artifacts fail verification and leave no valid reward. The wrapper calls the
original verifier without changing its extraction or rubric behavior and removes
credential values from its logs on both success and failure. `judge-details.json`,
rubric logs, extraction diagnostics, the original and transformed test scripts,
source hashes and transformation records remain available for audit. Regrade
uses retained output and the same frozen verifier; it executes no candidate and
can make new paid judge calls. Missing retained artifacts cause an explicit
regrade error.

The offline tests exercise the original renderer/verifier with deterministic
provider stand-ins through import, Package validation and standard compilation.
The real one-task HF import and Harbor 0.21 parsing passed; no image build,
candidate call, paid judge call or real container regrade was performed. See
[acceptance evidence](../../docs/evidence/jobbench-lab-producers-2026-10-19.json).

Sources: [official Harbor route](https://github.com/Job-Bench/job-bench-eval/blob/660b33a86ed032559df0b2fdc1ad38cf7ceb83f3/harbor/README.md),
[scoring](https://github.com/Job-Bench/job-bench-eval/blob/660b33a86ed032559df0b2fdc1ad38cf7ceb83f3/README.md#scoring).
