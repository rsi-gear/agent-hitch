# OSWorld release and sample resolution

`resolve-release.py` prepares the exact release components and a fixed random
sample from the official **public file inventory**. It uses Python 3.9+ and the
standard library. This is provenance preparation; the desktop/VM executor and
the two real scored trials remain incomplete.

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

Remaining execution work follows section 9.5 of
`docs/hitch-benchmark-eval-spec.zh-CN.md`: a managed VM and website namespace,
lease/fencing and cleanup, native screenshot/action bridge, official task
reset/evaluate, and release-specific partial/strict metrics. Candidate access
must exclude task setup/evaluator code. Only an actual Hitch run plus official
evaluator evidence can satisfy the real two-task validation requirement.

## Native screenshot transport

The generic `tool-server@1` bridge supports `hitch-tool-result@1` image responses.
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
evidence. The future OSWorld controller must retain the original screenshots
and action sequence in its own sealed artifacts. Tests currently prove transport
and byte preservation against a synthetic HTTP server; they do **not** prove an
OSWorld VM run or candidate screenshot understanding.

## Pinned SDK integration constraints

Code review of `d578d2d4e0dc82b43e270fdaa7fa89d9708cd154` identified these
requirements for the remaining executor:

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
  on the same environment. A one-shot reset/evaluate wrapper must reject a
  multi-phase task until this behavior is implemented and compared.
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
