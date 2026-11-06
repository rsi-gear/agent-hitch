# DeepSeek Flash 1017 integration evidence — 2026-10-28

Five official API probes passed: Chat text, image understanding, tool invocation,
tool-result replay with the native assistant history, and Responses text. Requests
used `deepseek-flash` with thinking enabled and high reasoning effort. Text/image
responses contained reasoning fields; tool steps may legitimately report none.
The [sanitized record](deepseek-flash-1017-2026-10-28.json) retains timestamps,
returned models, usage and request/response hashes, without keys or reasoning text.

A real Hitch → DSH `0.2.1-rc.2` file-tool run succeeded:
`run_566114397f034d8ab9d85655b616522f`. The candidate wrote and read a synthetic
file and returned the required final text. Hitch sealed a `provider_native`
trajectory; the native session is v4 and records `deepseek-official`,
`deepseek-flash`, and `reasoningEffort: high`. It required no DSH session-format fix.
This is a local integration smoke, not a Harbor score or a Marketing benchmark.

The OSWorld v1 provider rejects the new alias locally and permits images only
for the historical vision alias. The new independent v2 profile enables
thinking/high and canonical Flash image inputs. Seven offline transport/profile
tests cover history preservation, token mapping, effort selection, legacy
compatibility and invalid replies. Official OSWorld tasks and the installed-SDK
synthetic canary have not been rerun by this evidence record.

1017 attribution follows the [official current alias mapping](https://api-docs.deepseek.com/quick_start/agent_integrations/).
The requested and returned alias is mutable; these observations do not establish
an immutable checkpoint identity. Existing JobBench/LAB Flash smoke results are
historical evidence and are not relabelled or included in a new benchmark total.

Validation: typecheck, build, architecture and documentation checks passed, as did
all seven offline transport/profile tests. The complete serialized regression
reported 997 tests: 977 passed, 5 failed and 15 skipped. The failures were the
host-model-proxy recovery assertion and four remote-verifier scoring timeouts.
An isolated rerun of the four remote-verifier cases passed the success and
generation-cleanup cases; invalid and release-lost still timed out. These results
remain unresolved, so this change is submitted as a draft rather than claiming a
fully passing suite. No Docker permissions were changed and no scored Harbor or
Marketing run was executed.
