# Harvey LAB producer

This independent producer converts a clean commit-pinned Harvey LAB checkout
into Package v1 terminal tasks and then an ordinary compiled Harbor dataset.
Each candidate gets its original instructions and public documents under
`/workspace/documents`; it writes final files under `/workspace/output`.
Only commit-tracked documents and source files are copied, excluding ignored
local credential files. Original rubric-bearing `task.json` and official `lab_core` evaluation code are
available only to a separate verifier. No Hitch benchmark dispatch changes are
required.

This is a **Hitch terminal/open-network profile**. The official reference harness
uses a sandbox with `--network=none`, its own tools, skills and agent loop. Those
harness differences affect comparability; this producer does not claim reference
harness or leaderboard parity. It preserves official rubric evaluation, file
matching, document extraction and all-pass aggregation. The candidate image
reuses public upstream sandbox tooling with a pinned base; no rubric or full
`lab_core` enters its build context. Office library apt/pip/npm resolution remains
as authored upstream; frozen verifier `uv.lock`, Pandoc 3.11's checked installer,
and image build observations identify the verifier and effective images.

The importer requires Python >=3.9, Git and no external Python packages.
Execution needs Docker, Linux/amd64, image/build downloads, model API access and
public verifier network. The verifier uses Python 3.12 and the original locked
`lab_core` dependencies. Candidate model calls and judge calls have independent
costs. For the upstream and Chat profiles, filename matching may add a paid Anthropic
call even with a single OpenAI, Google or Mistral judge.

## One task: import, validate and compile

The checked code/data revision is
`e9b1f9f4dc25576f9a020d857e3e3a6420834dc3`. A sparse checkout can materialize the
selected task's documents while retaining complete Git-tree task membership:

```sh
git clone --filter=blob:none --no-checkout \
  https://github.com/harveyai/harvey-labs.git /sources/harvey-labs
git -C /sources/harvey-labs sparse-checkout init --cone
git -C /sources/harvey-labs sparse-checkout set lab_core \
  tasks/antitrust-competition/analyze-antitrust-hsr-strategy
git -C /sources/harvey-labs checkout e9b1f9f4dc25576f9a020d857e3e3a6420834dc3
python3 benchmark-packages/lab/import.py --source /sources/harvey-labs \
  --task antitrust-competition/analyze-antitrust-hsr-strategy \
  --out /packages/lab-one
hitch benchmark validate --package /packages/lab-one
hitch benchmark compile --package /packages/lab-one --out /datasets/lab-one
```

Nested source IDs remain unchanged in `source_task_id`; bounded readable task
IDs plus a source-ID digest are used for Harbor directories. The source manifest
records both. Omit `--task` and use `--seed 20261019 --count N` for deterministic
SHA256 ranking from the complete pinned Git-tree population (2,010 task JSONs in
the checked revision), before opening task content. Selected files must be
materialized; a sparse checkout with missing selected files fails instead of
resampling. A complete run needs all selected task inputs, including shared
corpora, and one valid result per task.

`docs_dir` paths such as `../../dms` are resolved inside the pinned repository and
copied as public document inputs. Expand a sparse checkout to include that shared
corpus before import. An empty inline `instructions` value retains the upstream
`instructions.md` fallback. Missing documents/instructions, symlinks, dirty source
checkouts and wrong revisions fail explicitly. Rubric JSON bytes and criterion
options, including DOCX redlines, are preserved. No filename or missing-file
substitution is introduced by the producer.

## Independent candidate and judge credentials

Put candidate credentials under its provider's normal environment name. Put judge
credentials only under dedicated host names: `HITCH_LAB_JUDGE_ANTHROPIC_API_KEY`,
`HITCH_LAB_JUDGE_OPENAI_API_KEY`, `HITCH_LAB_JUDGE_GOOGLE_API_KEY`, and/or
`HITCH_LAB_JUDGE_MISTRAL_API_KEY`. These are resolved into provider variables only
inside the verifier. **Never pass these dedicated variables with `--pass-env`**;
that option exposes values to the candidate. Known provider variables are also
passed to candidates automatically, so a dedicated judge key should not be stored
under a normal candidate provider name. Keys stay out of packages and builds;
the wrapper removes their exact values from diagnostic logs and score reasoning.

The upstream default pair is read from the pinned `run_eval.py`:
`claude-sonnet-4-6` and `gpt-5.5`. It requires dedicated Anthropic and OpenAI keys.
Use `--judges gpt-5.5` at import for a separately identified single-judge package,
or `--judges MODEL_A MODEL_B` for a custom pair. For the upstream and Chat profiles, the official fallback filename
matcher uses `claude-sonnet-4-6`; provide the dedicated Anthropic key if
that fallback can be needed. A missing or failed matcher is an invalid
verification, while a genuinely missing deliverable is evaluated under the
original rubric's missing-file behavior. The default OpenAI/Anthropic endpoints
can be changed using dedicated `HITCH_LAB_JUDGE_OPENAI_BASE_URL` and
`HITCH_LAB_JUDGE_ANTHROPIC_BASE_URL` host variables; record substitutions when
reporting results. Model aliases and live provider endpoints remain mutable.

```sh
# Candidate OPENAI_API_KEY plus dedicated judge keys are already set privately.
hitch eval run --dataset /datasets/lab-one \
  --harness codex@version:0.145.0 --model YOUR_CANDIDATE_MODEL \
  --pass-env OPENAI_API_KEY
hitch eval inspect EVAL_ID --json
# Copy the actual flat ID from source-manifest.json or the compile output.
hitch eval rerun EVAL_ID --task COMPILED_TASK_ID --type verifier-only
```

### Explicit OpenAI-compatible Chat Completions judge

For a provider whose model name is not recognized by upstream detection, opt in
at import rather than disguising its model ID:

```sh
python3 benchmark-packages/lab/import.py --source /sources/harvey-labs \
  --task corporate-ma/compare-closing-checklist-against-ma-agreement \
  --judges deepseek-flash --judge-api openai-chat-completions \
  --judge-reasoning-effort high --parallel 3 --out /packages/lab-custom-single
```

Set `HITCH_LAB_JUDGE_OPENAI_API_KEY` and
`HITCH_LAB_JUDGE_OPENAI_BASE_URL=https://api.deepseek.com` privately in the
verifier's launching environment. They are not candidate `--pass-env` entries.
The custom transport initially supports **one judge only**. It is a separately
identified single-judge configuration, not the standard Sonnet/GPT dual profile.
Omitting `--judge-api` keeps upstream provider detection, requests and scoring;
`--judge-reasoning-effort` is accepted only for the explicit Chat transport.

The adapter inherits the official `Judge.evaluate_from_file` and `_parse_json`,
formats the original template with the same variables, and passes the object to
the original `evaluate_run`. It sends the official 64,000-token output cap and
uses JSON-object mode on the first attempt with the upstream-style plain JSON
fallback. Optional `reasoning_effort` is recorded as requested configuration;
effective effort is provider-dependent. It requires exactly one nonempty text
choice with `finish_reason=stop` and a valid pass/fail verdict. Truncation,
refusals, tool calls, API and parsing failures invalidate verification, while a
valid fail remains a scored zero. Transport/model/endpoint settings are retained
in verifier provenance. Upstream prompts, rubric JSON, extraction, filename
matching and all-pass aggregation are unchanged.

The fallback filename matcher still requires the separate Anthropic credential.
Exact filenames and upstream extension/fuzzy matching do not need that call;
if fallback matching is required but cannot run, verification fails explicitly.
No custom matcher or silent missing-file substitution is introduced.

The recipe is for local direct execution. Resident workers need the judge
variables in their own launching environment; remote verifier credential binding
has not been implemented or validated here. A verifier-only regrade uses retained
output and the frozen task/evaluator, makes no candidate call, and may make paid
judge/matching calls. Missing retained evidence causes an error.

## Optional Codex quota through CLIProxyAPI

Use `--judge-profile cliproxy-codex` with one explicit `--judges MODEL` and
`--judge-base-url`. This profile defaults to one parallel request and uses only
`HITCH_LAB_JUDGE_CLIPROXY_API_KEY` in the separate verifier. HTTP additionally
requires `--judge-allow-http`. Its Responses adapter uses the official verdict
schema, and the official fallback filename matcher uses the same Codex model
through a scoped transport adapter, requiring no Anthropic key. It cannot be
combined with the Chat adapter or two judges. See the
[service, login, Docker topology and smoke recipe](../cliproxy/README.md)
for the pinned proxy config and generation-control/comparability limitations.

## Score and evidence contract

`lab_all_pass` maps to `total_score`: a single judge's official binary `score`,
or official `dual_all_pass_rate` (0, 0.5 or 1) for two judges. The benchmark result
is the task macro mean. `lab_criterion_pass` preserves the criterion pass fraction
(single or official `dual_criterion_pass`) as an auxiliary raw metric. It is not
a process score. Single/custom judge profiles must be reported separately.

The bridge directly calls `evaluate_run` or `evaluate_run_dual`.

The raw response must satisfy the official schema before scoring supplies any
default: exactly a `verdict` of `pass`/`fail` and a string `reasoning`. This gate
applies to upstream single and both dual judges as well as the custom transport;
`{}`, missing fields, extra fields and wrong types leave no reward. The scoped
Judge subclass is restored after grading; official vendor code, prompts and dual
aggregation remain unchanged. A valid `fail` still produces its official zero.

Any `n_grading_errors`, invalid verdict, incomplete membership, inconsistent all-pass
aggregate or swallowed filename-matcher API/parsing failure invalidates
verification and leaves no reward. Absent/empty output is passed to the original
scorer as missing evidence, not replaced with an invented score; unreadable
files retain the official extraction text for rubric evaluation. Unsafe artifacts
are rejected before any judge. Per-judge `scores_*.json`, `scores_dual.json`,
judge diagnostics, source hashes and transformation records remain verifier
evidence. Failed regrades clear stale reward and score files.

Offline tests use original evaluation/scoring functions with deterministic fake
providers and cover the complete import/validate/compile path, auxiliary versus
primary score, missing files and failure gates. The original acceptance check on 2026-10-19 passed real single-task import,
Package validation, compilation and Harbor 0.21 task parsing. Docker was
unavailable in that check, so it ran no images, real candidates/judges or
container regrades and established no scored benchmark observations. The Chat
transport regressions use deterministic SDK fakes; any live deployment evidence
must separately identify its model, endpoint, judge profile and harness. See
[acceptance evidence](../../docs/evidence/jobbench-lab-producers-2026-10-19.json).

Sources: [official tutorial](https://github.com/harveyai/harvey-labs/blob/e9b1f9f4dc25576f9a020d857e3e3a6420834dc3/docs/tutorial.md),
[official scoring methodology](https://github.com/harveyai/harvey-labs/blob/e9b1f9f4dc25576f9a020d857e3e3a6420834dc3/docs/eval-strategies.md).
