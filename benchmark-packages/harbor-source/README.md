# Native Harbor benchmarks

This independent producer resolves a Harbor Hub release, samples its **complete**
membership with `sha256(seed + NUL + task_name)` ranking, and downloads tasks by
their immutable content hashes. It verifies each downloaded tree using Harbor's
own `Packager.compute_content_hash`. The same producer supports Terminal-Bench
4.0 and Terminal-Bench-Science 0.1; there is no benchmark dispatch in Hitch core.

Use Python 3.12+ with `harbor==0.21.0` and Docker:

```sh
python benchmark-packages/harbor-source/import.py \
  --dataset terminal-bench/terminal-bench@4.0.0 \
  --seed 20260902 --count 2 --out /absolute/packages/terminal-bench
python benchmark-packages/harbor-source/import.py \
  --dataset terminal-bench-science/terminal-bench-science@0.1.0 \
  --seed 20260902 --count 2 --out /absolute/packages/science
hitch benchmark lock --package /absolute/packages/terminal-bench
hitch eval run --benchmark-lock /absolute/packages/terminal-bench/benchmark.lock.json \
  --harness codex@version:0.145.0 --model gpt-5.4
```

The source manifest preserves full registry membership, release hash, task hashes,
seed, selection, image resolutions and transformations. `--metadata FILE` reuses
frozen Harbor `DatasetMetadata`; optional `--source DIR` consumes an already
downloaded export and still verifies its hashes. Existing output directories are
never overwritten. Failed imports retain their selection for diagnosis.

Original instructions, tests and solutions are retained. Harbor's model migrates
legacy task configuration to schema 1.4; Docker bases and Compose images are
resolved to digests. Every changed file has its original stored in `source-files`
and linked in the transformation manifest. Native verifier collection commands,
timeouts, network policies and resource requests are retained. Shared verifiers
keep their original live-workspace semantics; separate verifiers keep their
declared artifacts. `grading.kind=harbor` accepts original reward.txt or
reward.json using Harbor's JSON-first precedence and maps the selected metric.

Do not replace an inconvenient random draw. GPU/memory requirements are part of
the selected tasks. Use a suitable worker or record the missing run. A two-task
canary is a public subset, not a full leaderboard result.

Sources: [Terminal-Bench run instructions](https://www.tbench.ai/run),
[Science run instructions](https://www.terminal-bench-science.ai/run).
