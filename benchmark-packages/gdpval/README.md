# GDPval public rubric package

This producer imports a pinned `openai/gdpval` Parquet snapshot and downloads its
selected reference files from that same revision. Sample ranking is
`sha256(seed + NUL + task_id)` over the complete population, without replacement.
It records the seed, population digest, source revision and downloaded file
hashes. This implements a **local public-rubric protocol**, not GDPval-AA v2's
private judge panel, comparison pool or Elo.

```sh
python -m pip install pyarrow==21.0.0 toml==0.10.2
python benchmark-packages/gdpval/import.py \
  --parquet /absolute/gdpval/train.parquet --revision FULL_HF_COMMIT \
  --seed 20260902 --count 2 --judge-model gpt-5.4 \
  --out /absolute/packages/gdpval
hitch benchmark lock --package /absolute/packages/gdpval
hitch eval run --benchmark /absolute/packages/gdpval \
  --harness codex@version:0.145.0 --model gpt-5.4 \
  --pass-env HITCH_CODEX_AUTH_JSON
```

`HITCH_CODEX_AUTH_JSON` is the existing in-memory container credential handoff
described in `docs/benchmark-packages.md`. This package explicitly uses that
account for both candidate and judge, via Harbor verifier environment templates;
no credential bytes are put into the package, Docker build or task configuration.
The grader pins Codex CLI 0.145.0 and records the separately selected judge model,
prompt hash, events/usage and renderer version.

Only prompt and reference inputs enter the candidate image. Gold deliverables
and rubrics are confined to the separate verifier. The agent writes deliverables
under `/app/output`; Harbor exports that directory after stopping the candidate.
The verifier renders Office files to PDF/PNG and includes page images, extracted
text and (for xlsx) cell/formula contents in a structured criterion judgement.
It records criterion IDs, boolean decisions and cited evidence. Unknown file
renderers, oversized/truncated evidence, judge errors and malformed decisions
produce grading errors; they cannot become valid zero scores.

For weight `w_i` and criterion-condition truth `m_i`, the local score is
`clip(sum(w_i*m_i)/sum(max(w_i,0)), 0, 1)`. Negative criteria apply penalties when
their stated conditions are true. Strict success requires all positive
conditions and no negative conditions. Elo is not a per-task metric. Missing or
unopenable candidate deliverables are supplied to the rubric judge as findings.

Current renderers: Word/PowerPoint/Excel/OpenDocument/PDF, common raster images,
and text/CSV/JSON/HTML/XML/source text. Unsupported specialty formats require an
additional renderer before that task can receive a complete quality assessment.
Do not resample those tasks silently.

Sources: [official public dataset](https://huggingface.co/datasets/openai/gdpval),
[Codex structured output and image flags](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
