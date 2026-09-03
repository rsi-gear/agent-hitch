# OSWorld fixed-sample benchmark package

The fixed-sample producer is now available as `assemble.py`; see
[ASSEMBLY.md](ASSEMBLY.md) for inputs, image identities, service isolation,
DeepSeek configuration and offline scalar grading. The executable package has
completed one real scored task: Task031 returned `native_score=0.14285714285714285`
with a verified snapshot, sealed candidate and valid Hitch assessment. Task095
is running in the same v6 evaluation. Current receipts and acceptance counts are
in [the status file](../../docs/benchmark-expansion-status.json).

`resolve-release.py` prepares the exact release components and a fixed random
sample from the official **public file inventory**. It uses Python 3.9+ and the
standard library. This command prepares provenance; `assemble.py` supplies the
desktop/VM execution package. Resolving or compiling inputs alone does not count
as a scored trial.

```sh
python benchmark-packages/osworld/resolve-release.py \
  --release osworld-v2-2026.08.08 --seed 20260902 --count 2 \
  --out /absolute/osworld-selection
```

The output contains the official release manifest, component API metadata and
`selection-lock.json`. GitHub code and website tags and Hugging Face task/asset
tags are resolved to full commits. Task membership must match the release's
108-task count; duplicate or incomplete inventories fail. Sampling ranks
`sha256(seed + NUL + task_id)` over the complete inventory and never replaces a
failed or unavailable task. An existing output directory is never overwritten.

For seed `20260902`, the 2026.08.08 release selects **task_031** and **task_095**.
The resolved task revision is `3736efa55d9d5dc78f57e873ef78886663e41200`, and the
asset revision is `acad110ef3136405f95434b54862bf9066176c2a`. These differ from
floating `main`; later execution must use the locked revisions.

The file inventory is public metadata. Task bodies and complete assets are
separately gated. Once authorized inputs are available, the producer must verify
`manifests/task_hashes.json` against the release's SHA256, then verify the selected
Python classes against that manifest. Public membership resolution alone does
not attest to task contents and is not execution evidence.

Authorized access was established on 2026-09-03. The pinned hash manifest and
both selected task classes now pass the official release/hash checks. The
`task_031` asset subtree and its literal state-file asset references were acquired
from the pinned asset revision. The assembled package's Task031 run has since
verified a usable desktop, the original task inputs, native grading and Hitch
result publication.
The selected `task_095` also declares an LLM user simulator (`gpt-4o`) and remote
media discovery; its controller credentials and runtime dependencies must be
configured through the declared DeepSeek substitution profile without changing
the original task definition. Private inputs and receipts stay
under `.hitch/benchmark-expansion/`; only identities/status belong in Git.

The execution contract follows section 9.5 of
`docs/hitch-benchmark-eval-spec.zh-CN.md`: a managed VM and website namespace,
lease/fencing and cleanup, native screenshot/action bridge, official task
reset/evaluate, and release-specific partial/strict metrics. Candidate access
must exclude task setup/evaluator code. Only an actual Hitch run plus official
evaluator evidence can satisfy the real two-task validation requirement.

The [managed VM components](runtime/README.md) now provide process ownership,
private lease-bound control, writable-state reset and an upstream DesktopEnv
provider. Synthetic process tests pass both locally and as PID 1 in a Linux
container. The SDK agent channel now preserves native phase resets, gates and
prediction-step accounting in a synthetic parity test. A separate canary initially
verified only guest screenshot-API boot/reset; its black screenshots did not
establish a usable desktop. The later Task031 evaluation completed the assembled
VM/controller/website path and native scoring. Its 45 predictions and accepted
`FAIL` action produced a valid partial score; a failure action does not bypass the
native evaluator. See the status file for both historical diagnostics and
scored-trial evidence. The generic fresh-conversation supervisor and whole-task
assessment importer are connected through the standard native-phase package entry.

The controller transport component exposes only `desktop.observe` and
`desktop.submit` over authenticated HTTP. Lease-fenced management uses a private
Unix socket. Its tests exercise actual HTTP/Unix sockets and the Node image
client across synthetic phase changes. The Harbor bridge now connects dynamic
candidate bind/start/retire and verifies the full native audit at import. Optional
control protocol v2 also supports bounded final-state grading at a task deadline;
see the runtime README for its explicit SDK adaptation and evidence contract.

## Native screenshot transport

The generic `tool-server@1` bridge supports `hitch-tool-result@1` image responses.
Its wire schema is `docs/schemas/benchmark-tool-result-v1.schema.json`.
Declare both `tool-result-images@1` and `native-image-input` in task requirements
and the profile's allowed capabilities. Currently the native-image agent path
requires the Codex harness. A server can return:

```json
{
  "protocol": "hitch-tool-result@1",
  "content": [
    {"type": "text", "text": "Observation 7; desktop 1920 × 1080"},
    {"type": "image", "mimeType": "image/png", "data": "<canonical base64>"}
  ]
}
```

The CLI writes the original bytes to a fresh private temporary directory and
returns each image's absolute path, MIME type, byte count and SHA256. Candidate
instructions tell the agent to open the files using its native image tool.
There is no OCR, resizing, remote URL fetch, or server-supplied output path.
Existing responses without the explicit envelope are preserved unchanged.
PNG/JPEG/WebP are supported, with eight images per response, 4 MiB per image
and a 16 MiB wire response limit. Unsupported or malformed images fail the tool
call. HTTP redirects fail instead of forwarding a session token.

These temporary files are candidate observations, not trusted final scoring
evidence. `runtime/agent_channel.py` retains original screenshots and the action
sequence on private controller storage; assembly must seal these artifacts.
Tests currently prove transport
and byte preservation against a synthetic HTTP server; they do **not** prove an
OSWorld VM run or candidate screenshot understanding. The separate
`writeDesktopBenchmarkFixture()` helper in `test-support/desktop-benchmark-fixture.ts`
creates a synthetic one-click visual canary for the actual Hitch/Codex path;
its results must be reported separately from OSWorld acceptance.

The actual Hitch canary `eval_672fce9c3b374b7d8eff13d51b3f179c` completed with
one valid trial and reward `1`. Codex 0.145.0 / gpt-5.4 received the screenshot
file and clicked `(235, 90)` once; the isolated verifier checked the click and
the exported controller screenshot's SHA256. All four lifecycle hooks completed.
The native CLI log did not emit a separate image-viewer invocation, so this is
evidence of successful screenshot/action/scoring transport, not complete
observation of the model's image-reading call. See
`docs/benchmark-expansion-status.json` for run and artifact references.

## Pinned SDK integration constraints

Code review of `d578d2d4e0dc82b43e270fdaa7fa89d9708cd154` identified these
requirements for the executor:

- Load authorized classes through `task_loader.load_task_from_file()` on the
  controller, then `DesktopEnv.reset(task_config=task)`. The candidate must never
  receive the task module or evaluator assets.
- `DesktopEnv.step(action, pause=2)` returns observation, intermediate reward,
  done and info. Intermediate reward is not the final benchmark score.
  Screenshot-only profiles must not expose the default accessibility tree or
  arbitrary Python execution channel. Map the bounded action vocabulary to the
  upstream controller and preserve `WAIT`/`DONE`/`FAIL` semantics.
- `DesktopEnv.evaluate()` may return a float or a dictionary. Preserve the
  complete dictionary and use the release/task's documented score semantics.
  Do not invent a strict-success field from a rounded partial score.
- Detect `get_phases()` before running a task. The upstream multi-phase runner
  performs sequential setup, action budgets, phase evaluation and early gates
  on the same environment. `native_runner.py` now delegates to that pinned
  runner, and the channel parity test covers its multi-phase behavior. The
  supervisor creates a fresh candidate conversation on each native reset and
  requires retired-container receipts; different run IDs alone do not establish
  this. The validated Task031 run contains one candidate phase; the synthetic
  multi-phase tests remain separate evidence for reset and replacement behavior.
- The stock Docker provider launches its own container and allocates host ports.
  Calling it unchanged would bypass Hitch's resource ownership. The managed
  provider must own the VM and website namespace under the trial lease, fence
  stale sessions, and clean both after failure/cancellation. Do not put the
  host Docker socket in the candidate container.
- The release fixes the 14,189,763,267-byte QCOW2 archive by SHA256, but names
  `happysixd/osworld-docker` without a digest. Resolve and lock the runtime image
  digest before execution, and record KVM availability and effective resources.

Sources: [official setup](https://github.com/xlang-ai/OSWorld-V2),
[release manifest](https://github.com/xlang-ai/OSWorld-V2/blob/main/benchmark_releases/osworld-v2-2026.08.08.json),
[task access](https://huggingface.co/datasets/xlangai/osworld_v2_tasks),
[asset access](https://huggingface.co/datasets/xlangai/osworld_v2_assets_gated).
