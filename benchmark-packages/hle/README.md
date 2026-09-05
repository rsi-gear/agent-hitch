# HLE public dataset producer

`import.py` consumes an **authorized** `cais/hle` test Parquet plus a clean,
commit-pinned checkout of `centerforaisafety/hle`. It selects from the complete
membership with `sha256(seed + NUL + id)` ranking before inspecting questions.
It requires `pyarrow==21.0.0` and `toml==0.10.2`. It does not acquire gated data
or accept access terms. Do not use evaluation questions for training.

```sh
python benchmark-packages/hle/import.py \
  --parquet /authorized/hle-test.parquet \
  --revision 5a81a4c7271a2a2a312b9a690f0c2fde837e4c29 \
  --grader-source /sources/hle \
  --grader-revision 73ae974b1844c3ffa64c3f4343d9f1f259575700 \
  --profile no-tools --seed 20260902 --count 2 --out /packages/hle-no-tools
hitch benchmark compile --package /packages/hle-no-tools \
  --out /datasets/hle-no-tools
hitch eval run --dataset /datasets/hle-no-tools \
  --harness model-call@git+file:///sources/agent-hitch#FULL_COMMITTED_REVISION \
  --model YOUR_RESPONSES_MODEL --pass-env OPENAI_API_KEY
```

The compiled standard dataset maps the official binary `correct` metric to
`total_score`. HLE does not declare process-score or feedback channels.

The local source revision must contain `integrations/model-call/cli.js` matching
the trusted script bundled with the executing Hitch runtime. The adapter refuses
other script bytes and any agent arguments. The runner sends one Responses API
request with embedded native images, `tools=[]`, `tool_choice=none`, and no tool
executor, continuation or retry. Unsupported modalities fail explicitly. Its raw
provider response records model identity, usage and termination. API access uses
`OPENAI_API_KEY`; a ChatGPT Codex login is not substituted for an API credential.
An optional `OPENAI_BASE_URL` changes the candidate endpoint and must be included
in the effective runtime environment evidence.

For the authorized DeepSeek API configuration, map the local `.env` value into
the child worker's `OPENAI_API_KEY` and `HLE_JUDGE_API_KEY` environment variables;
set `OPENAI_BASE_URL=https://api.deepseek.com/`. Do not print, commit or put the
key into profile files. Generate a new named package with:

```sh
# Add these flags to import.py; keep the original Parquet, seed and task count.
--judge-model deepseek-v4-flash --judge-api responses \
--judge-base-url https://api.deepseek.com/ --judge-schema-message \
--profile-name hle-public-no-tools-deepseek-schema-guided
```

Run it with `--model deepseek-v4-flash --pass-env OPENAI_API_KEY
--pass-env OPENAI_BASE_URL`. Only the candidate key/base URL are passed to the
candidate. The separate verifier resolves `HLE_JUDGE_API_KEY`. Both transports
keep the original judge prompt and extraction schema; the Responses variant
sends that schema in `text.format`. The endpoint, API and model are locked in
the package, and the profile marks a substituted judge. Redirects, incomplete
judge outputs, refusal/actions and wrong field types are errors, never scores.
Do not assume a provider enforces the declared schema: a real DeepSeek response
returned JSON null where the upstream schema requires a string, which local
validation correctly rejected. `--judge-schema-message` explicitly adds the
format-only `system-json-schema@1` instruction; it repeats the same schema and
requires strings to remain strings. The original user judge prompt stays byte
identical. This is a separate locked profile, never a coercion of returned nulls
or an in-place change to an earlier package. Provider model aliases are mutable; retain
returned model and usage as observations, without claiming a snapshot revision.

The worker preserves the final answer from Hitch's result, outside candidate
storage, and restores it into the separate verifier after artifact transfer.
Gold answers only enter `tests/`. The producer extracts the original system
prompt and judge prompt via AST from the exact upstream commit. The verifier
uses the official structured extraction/equivalence schema and defaults to the
upstream `o3-mini-2025-01-31` judge. Set `HLE_JUDGE_API_KEY` in the host worker
environment: Harbor resolves it into the verifier only; **do not** pass it to the
candidate with `--pass-env`. An unavailable judge or malformed output is an
invalid trial, never an incorrect-answer score.

`--profile with-tools` uses the same questions and grader through the terminal
driver. It currently requires the Codex image-capable harness and exposes public
network/shell tools. Image questions retain the original image file and instruct
the harness to inspect it natively. This is a named Hitch tool configuration,
not Anthropic's unpublished tool harness. Both profiles record their token/time
budgets; their scores must be reported separately. The explicit token ceiling
applies to the single-request profile; with-tools uses the task's wall budget.

Source-file SHA256, dataset/grader revisions and sample membership are recorded.
The caller must supply the correct authorized Parquet for that revision; an
asserted revision alone is not a cryptographic upstream dataset attestation.

The authorized real Parquet was acquired on 2026-09-03 at the pinned revision;
its SHA256 matches the upstream LFS identity. Both profiles were imported from
the complete 2,500-row membership using the same fixed two-task selection, and
both passed `hitch benchmark lock` and `hitch benchmark validate`. Their private
packages and acquisition receipts remain under `.hitch/benchmark-expansion/`.
DeepSeek credentials have since been supplied through the local environment,
and the same two tasks have real candidate/judge execution evidence. Consult
`docs/benchmark-expansion-status.json` for final validity and regrade records;
package validation and synthetic contracts alone add no scored HLE trials.

Sources: [dataset](https://huggingface.co/datasets/cais/hle),
[official evaluation code](https://github.com/centerforaisafety/hle),
[Responses image inputs](https://developers.openai.com/api/docs/guides/images-vision),
[DeepSeek Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/).
