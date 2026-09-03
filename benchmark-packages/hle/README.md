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
hitch benchmark lock --package /packages/hle-no-tools
hitch eval run --benchmark-lock /packages/hle-no-tools/benchmark.lock.json \
  --harness model-call@git+file:///sources/agent-hitch#FULL_COMMITTED_REVISION \
  --model YOUR_RESPONSES_MODEL --pass-env OPENAI_API_KEY
```

The local source revision must contain `integrations/model-call/cli.js` matching
the trusted script bundled with the executing Hitch runtime. The adapter refuses
other script bytes and any agent arguments. The runner sends one Responses API
request with embedded native images, `tools=[]`, `tool_choice=none`, and no tool
executor, continuation or retry. Unsupported modalities fail explicitly. Its raw
provider response records model identity, usage and termination. API access uses
`OPENAI_API_KEY`; a ChatGPT Codex login is not substituted for an API credential.
An optional `OPENAI_BASE_URL` changes the candidate endpoint and must be included
in the effective runtime environment evidence.

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
Real candidate/judge execution still needs `OPENAI_API_KEY` and
`HLE_JUDGE_API_KEY`. Package validation and the earlier synthetic contracts add
no scored HLE trials. See `docs/benchmark-expansion-status.json` for identities.

Sources: [dataset](https://huggingface.co/datasets/cais/hle),
[official evaluation code](https://github.com/centerforaisafety/hle),
[Responses image inputs](https://developers.openai.com/api/docs/guides/images-vision).
