# AutomationBench public source adapter

This directory is an independent package producer. It imports no Hitch modules.
It exports a self-contained Harbor task dataset plus `benchmark.adapter.json`.
The result can be moved outside this repository and run through Hitch's ordinary
dataset path; no benchmark-specific Hitch controller is involved.

The producer runs upstream task generation in a Docker worker with no network,
using the exact Git commit and `uv.lock`. Dependency installation occurs during
the explicit image build. The selected source files, license, adapter source,
original messages, official task contract hashes, tool schemas and dependency
lock are preserved in the output. The adapter refuses an existing output path.

```sh
node benchmark-packages/automationbench/import.mjs \
  --source https://github.com/zapier/AutomationBench.git \
  --ref 4a8e1061254004d9dac807054eed33fad7d1ff14 \
  --task sales.update_contact_phone \
  --task sales.advance_opportunity_stage \
  --out /absolute/path/automationbench-public

hitch eval run --dataset /absolute/path/automationbench-public \
  --harness codex@version:0.145.0 --model gpt-5.4 \
  --attempts 1 --max-concurrent 1 --pass-env OPENAI_API_KEY
```

`--task` accepts upstream `info.task_name` values. The `simple` domain is excluded.
The examples are a two-task public subset, not a full benchmark score or a
reproduction of the private leaderboard.

The toolset is upstream `api`: `AutomationBenchEnv.setup_state` and
`update_tool_args` initialize and route calls to the official functions. The
separate verifier invokes upstream `partial_credit` and
`task_completed_correctly`, preserving the assertion registry's default strict
behavior. It writes `task_completed_correctly` as `total_score`,
`partial_credit` as the optional `process_score`, and the assertion outcomes as
`process.json` components. AutomationBench has no native feedback channel, so
it does not write `feedback.json`. Grader exceptions fail verification rather
than becoming a zero reward.

The candidate uses a generic shell CLI to call the tool server. This is an
adapted harness interaction profile: original messages are rendered with role
headings, and Hitch adds tool invocation instructions. It does not claim to
reproduce upstream model-native function calling or its turn budget. Each task
has a 600-second candidate budget. The public/open network profile is explicit;
this version does not claim an enforced model-endpoint-only network.

Each trial uses ordinary Docker Compose task services. The candidate-facing
`main` image contains only the generic call client and tool schema; the private
task row, upstream runtime, and simulator stay in a task-owned `simulator`
sidecar. The sidecar writes an atomic `/evidence/snapshot.json` after every tool
call to its own filesystem. After the agent exits, Harbor stops `main`, collects
the task-declared artifact directly from `service = "simulator"`, and mounts it
into the fresh verifier container. The candidate cannot read or write the
snapshot. There are no host ports, shared evidence volumes, Hitch lifecycle
hooks, or real SaaS credentials. Snapshots contain the final world and ordered
tool audit.

See [the implementation guide](../../docs/benchmark-packages.md) for the generic
contract and credential handoff.
