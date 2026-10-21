# Optional Codex judgement through CLIProxyAPI

JobBench and Harvey LAB accept `--judge-profile cliproxy-codex`. This is an
explicit, separately identified judge configuration. Omitting it retains the
existing JobBench provider, LAB upstream single/dual providers and LAB's
`openai-chat-completions` adapter. No candidate provider changes are needed.
The profile requires an explicit model and base URL and defaults to one worker.
LAB initially supports one proxy judge; its fallback filename matcher uses that
same model through the proxy, so it needs no Anthropic credential.

The independent service handles the user's Codex OAuth login. Hitch receives
only a separate proxy **client API key**, and only the separate verifier receives
that key. Nothing here reads or imports `~/.codex/auth.json`, SIWC tokens, or
other existing OAuth files. Quota and model availability are determined by the
account authenticated to the service; the adapter cannot verify subscription
billing or guarantee that a particular model is available.

## Start the independent service

The compatibility reference is CLIProxyAPI commit
[`ce07d189b3de2a39d37fd68ae093b102ce3aabee`](https://github.com/router-for-me/CLIProxyAPI/tree/ce07d189b3de2a39d37fd68ae093b102ce3aabee).
Its config uses the **v8 nested layout** in [config.example.yaml](config.example.yaml),
and its build uses Go 1.26 plus a C compiler. Keep this service and its private
config/auth directory outside a benchmark package, repository and candidate
build context. The following is a host-run service recipe; use an existing
private directory for `CLIPROXY_SERVICE`:

```sh
CLIPROXY_SERVICE="$HOME/.local/share/hitch-cliproxy-codex"
mkdir -p "$CLIPROXY_SERVICE/bin" "$CLIPROXY_SERVICE/auth"
git clone https://github.com/router-for-me/CLIProxyAPI.git "$CLIPROXY_SERVICE/source"
git -C "$CLIPROXY_SERVICE/source" checkout ce07d189b3de2a39d37fd68ae093b102ce3aabee
(cd "$CLIPROXY_SERVICE/source" && go build -o "$CLIPROXY_SERVICE/bin/CLIProxyAPI" ./cmd/server/)
cp benchmark-packages/cliproxy/config.example.yaml "$CLIPROXY_SERVICE/config.yaml"
chmod 700 "$CLIPROXY_SERVICE/auth"
chmod 600 "$CLIPROXY_SERVICE/config.yaml"
```

Replace `access.api-keys[0]` privately with a random client key. The example's
`oauth.auth-dir` points to the dedicated directory created above. Keep **only your
Codex login** there. Do not add paid API provider entries, other provider logins,
or ambiguous model aliases: model names must route exclusively to Codex. If
using an alias, make it unique to this Codex-only service. The proxy controls
routing, and Hitch cannot prove the selected backend from a model name alone.

Log in manually, then start the server with the same config. Device login prints
a URL/code for the account owner to complete; no OAuth callback port is needed:

```sh
"$CLIPROXY_SERVICE/bin/CLIProxyAPI" --config "$CLIPROXY_SERVICE/config.yaml" --codex-device-login
"$CLIPROXY_SERVICE/bin/CLIProxyAPI" --config "$CLIPROXY_SERVICE/config.yaml"
```

The usual `--codex-login` browser OAuth flow is also supported by this revision.
Run it interactively yourself if device login is unavailable for your account.
The example disables management, automatic image-generation tools and request
logging. Application/error logs can still contain sensitive task diagnostics;
keep them private. Retry rounds are disabled in the service so benchmark retries
remain bounded. Credentials and tokens stay on this service, never in the verifier.

## Make the endpoint reachable from the verifier

For a shared or remote worker, use a private **HTTPS** endpoint reachable from its
verifier containers, such as `https://judge.internal.example/v1`. Use a trusted
TLS certificate and either enable `server.tls` or terminate TLS at your existing
reverse proxy. Do not disable certificate verification. This works without
special Docker hostname assumptions.

For local **Docker Desktop**, the host-run service in the example listens on
`0.0.0.0:8317`. The container endpoint is
`http://host.docker.internal:8317/v1`, with explicit `--judge-allow-http` at import.
The host smoke endpoint can be `http://127.0.0.1:8317/v1`.
`127.0.0.1` **inside a verifier container** points at that container and cannot
reach the host-run service. Bind the service to a private interface/firewall
scope appropriate for the selected topology.

On **Linux Docker**, `host.docker.internal` is not automatically present. It
requires `--add-host=host.docker.internal:host-gateway` on each verifier container
or the equivalent supported worker configuration. This importer does not add
that Docker option. If the worker cannot add it, use a reachable host/private IP
or the HTTPS topology above and verify connectivity before importing. A Docker
smoke with an explicit mapping can test reachability, but does not configure
Hitch's subsequently created verifier containers.

## Smoke and import

Supply the private proxy client key through your secret manager under
`HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY` and/or
`HITCH_LAB_JUDGE_CLIPROXY_API_KEY` in the worker's launching environment.
These are independent of candidate `OPENAI_API_KEY`. Never use `--pass-env` for
these dedicated judge variables. The package contains an endpoint and a verifier
credential template, not the key value. A missing key or endpoint fails explicitly;
there is no fallback to a paid OpenAI/xAI/Anthropic endpoint.

Run a tiny real request after login, selecting a model actually available on your
Codex account. This consumes that service's model quota and prints only transport
provenance, never credentials:

```sh
python3 benchmark-packages/cliproxy/smoke.py \
  --base-url http://127.0.0.1:8317/v1 --allow-http \
  --model YOUR_CODEX_MODEL \
  --api-key-env HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY
```

Run the same smoke **from the verifier's network** against the endpoint that
will be locked into the package. A standalone Linux connectivity check can use:

```sh
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e HITCH_JOBBENCH_JUDGE_CLIPROXY_API_KEY \
  -v "$PWD/benchmark-packages:/checks:ro" python:3.12-slim \
  python /checks/cliproxy/smoke.py \
  --base-url http://host.docker.internal:8317/v1 --allow-http \
  --model YOUR_CODEX_MODEL
```

With the pinned upstream sources already acquired as described in each producer:

```sh
python3 benchmark-packages/jobbench/import.py \
  --source /sources/job-bench-eval --snapshot /sources/jobbench-data \
  --dataset-revision d43a66575635da0d3f6cb9a20976dc1a60f3ffc9 \
  --task main--biostatisticians--task1 \
  --judge-profile cliproxy-codex --judge-model YOUR_CODEX_MODEL \
  --judge-base-url http://host.docker.internal:8317/v1 --judge-allow-http \
  --out /packages/jobbench-codex
python3 benchmark-packages/lab/import.py --source /sources/harvey-labs \
  --task corporate-ma/compare-closing-checklist-against-ma-agreement \
  --judge-profile cliproxy-codex --judges YOUR_CODEX_MODEL \
  --judge-base-url http://host.docker.internal:8317/v1 --judge-allow-http \
  --judge-reasoning-effort high --out /packages/lab-codex
hitch benchmark validate --package /packages/jobbench-codex
hitch benchmark compile --package /packages/jobbench-codex --out /datasets/jobbench-codex
hitch benchmark validate --package /packages/lab-codex
hitch benchmark compile --package /packages/lab-codex --out /datasets/lab-codex
```

Use the ordinary `hitch eval run` and `hitch eval rerun ... --type verifier-only`
commands from each producer's README. A resident/remote worker needs the private
proxy client key in its own launch environment and a reachable endpoint. No
remote OAuth distribution or automatic login is added. Explicit `--judge-workers`
and `--parallel` still override the new profile's low default concurrency.

## Scoring and compatibility boundaries

Both profiles use `/v1/responses` through a stdlib client. They require a completed
response, one completed assistant text message, no refusals or tool output, and
valid JSON matching the requested schema. HTTP failures, interrupted bodies,
incomplete Responses (even with HTTP 200), malformed JSON and invalid matcher
keys/filenames produce no reward. Stale rewards are cleared before regrading.
Original prompts, rubric contents, artifact extraction and score aggregation are
retained. JobBench's original judge runs in its own subprocess via a transport
facade; system/developer/user order and text/image URLs are preserved. LAB inherits
its original prompt loader/parser and verdict schema, including reasoning before
verdict. Its matcher retains the original prompt, schema, 500-character previews
and matching decisions; a scoped client facade replaces only the API call.

The reviewed Codex translator removes temperature and token caps and converts its
upstream request to a stream with `store=false`. The client requests a nonstream
aggregate from the proxy, omits those ineffective controls and records this
limitation in `judge-provenance.json`; it does not claim the official temperature
or output cap is effective. Optional LAB reasoning effort is a request, subject
to the proxy/model's effective settings. The recorded proxy commit is a
compatibility reference, not a claim about a running service's installed build.

Report proxy model/profile/endpoint and these generation-control differences with
scores. This is a substituted judge configuration, and LAB still uses Hitch's
terminal/open-network harness. It does not establish official leaderboard parity.
Offline HTTP tests cover import, compilation, both runtime paths, fallback
matching, credential isolation/redaction, artifact regrade and failure gates.
Real OAuth login, live account/quota routing and Docker connectivity must be
checked in the deployment environment with the smoke above.
