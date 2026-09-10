# Local and remote model inference

Choose the Harness and the inference service separately. `--harness` selects the agent program; `--model` selects its model. Hitch can forward requests to an existing API, manage SGLang on the local host, or use a registered remote model node.

This chapter describes the managed inference features in Hitch 0.2.10. Before that version is published to npm, [use the current dev build](#use-the-current-dev-build).

```text
Hitch → Harness on the host or in a task container → model API
                                                   ├─ hosted provider
                                                   ├─ your remote inference server
                                                   ├─ your local inference server
                                                   └─ Hitch-managed SGLang, local or remote
```

## Choose where inference runs

| Setup | What you configure | Who manages inference resources |
| --- | --- | --- |
| Hosted model API | A provider-supported model ID and authentication | The API provider |
| Self-hosted remote service | A reachable service URL, compatible API, served model ID, and authentication | Your inference deployment |
| Self-hosted local service | A local engine, loaded model, and a Harness-compatible endpoint | You, independently of Hitch |
| Hitch-managed local SGLang | An imported checkpoint and CPU/CUDA selection | Hitch's daemon and local resource ledger |
| Hitch-managed remote model node | An imported model, node binding, and exact GPU/inference lock | Hitch coordinates the service; the model node owns its GPU allocation |

The location of the model is independent of where the agent's tools execute. A local Harness can call a remote model; a Docker evaluation can call a model on its host. The evaluation flag `--provider local-docker` selects an execution provider, not an LLM provider.

`local/<name>` is Hitch's selector for an imported, managed model. With `--model-node-file`, that model runs on the bound node. The `local/` prefix does not mean the GPU must be in the submitting computer.

## Call a remote model API

Complete [Quick Start](quickstart.md), including authentication and a clean repository. With Codex, use saved CLI login or supply `CODEX_API_KEY` through your normal secret manager for non-interactive execution. See [Codex automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation).

Replace `MODEL_ID` with a model available to your account and accepted by the selected Harness:

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --model MODEL_ID \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m \
  --output json
```

Hitch does not translate model names between adapters. Codex receives its own model ID; DeepSeek Harness interprets `provider/model` using a configured provider row, and OpenCode uses its native provider/model selection. Omitting `--model` leaves selection to the Harness's configuration. Neither a provider prefix nor a model name configures a new server URL by itself.

## Run managed SGLang locally

Use a complete Hugging Face safetensors checkpoint already on disk, including its configuration and tokenizer. `models add` imports and hashes it; it does not download weights. GGUF files, incomplete checkpoints, and models requiring arbitrary remote code are not accepted by this path. Replace the checkpoint path and run from a clean target Git repository:

```bash
hitch models add /models/coder-checkpoint --name coder
hitch run \
  --harness codex@version:0.145.0 \
  --model local/coder \
  --device cuda \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m \
  --output json
```

Hitch resolves the model, pins the serving runtime and inference configuration, starts its daemon and SGLang when needed, and gives the Harness a private model route. No cloud model login or manually supplied endpoint is needed for this managed route.

`--device` defaults to `auto`; select `cpu` or `cuda` explicitly when comparing backends. The local Docker runtime currently targets **Linux/amd64 with an Intel Xeon AMX CPU or one compatible NVIDIA CUDA GPU**. CUDA also needs working GPU container support. macOS/Metal, ordinary non-AMX desktop CPUs, and multi-GPU execution are outside this local preview's support. Unsupported hardware fails preflight and does not fall back to a cloud model. The local Docker runtime remains a preview with its full hardware release gate pending; see the [local-inference implementation status](../../local-model-inference-spec.zh-CN.md).

Managed Codex inference requires **`codex@version:0.145.0`** and a model type with a configured tool parser. The Quick Start's older Codex pin is for its external API example. `model-call` provides a text-only path; `training-tool` has a separate Chat Completions binding described in [training integration](../../slime-training-binding.zh-CN.md). This does not establish support for every Harness or every SGLang-compatible model.

Optional preparation and inspection commands are:

```bash
hitch local doctor --device cuda --json
hitch local prepare local/coder --device cuda --profile baseline --json
hitch models inspect local/coder --verify --json
hitch local status --json
```

Doctor checks host eligibility; prepare starts and probes the serving path. First preparation can download digest-pinned runtime images. `--offline` prevents that runtime download and requires the cache to be ready; it does not disable network access for the agent's tools or verifier.

After [Harbor setup](evaluations.md), the same model selector works for a local Docker evaluation. Run from the Hitch source checkout containing the guide's example task:

```bash
hitch eval run --daemon \
  --dataset docs/guide/examples \
  --harness codex@version:0.145.0 \
  --model local/coder \
  --device cuda \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 --max-concurrent 1 \
  --timeout 5m --setup-timeout 15m \
  --output json
```

The permission argument applies to this trusted task container. Hitch provides the container's managed model route and credential automatically; keep endpoint overrides and cloud credentials out of this managed configuration.

## Use a managed remote model node

Use this path when your checkpoint should run on a remote GPU while the Harness or Harbor task runs elsewhere. The node must already have Gear's `gear_training.node` protocol v2, SGLang, a configured Python environment, and a usable single CUDA GPU. A plain OpenAI-compatible URL cannot act as this node. Node provisioning and the tested deployment boundary are described in [Gear / Slime integration](../../slime-training-binding.zh-CN.md).

Obtain these files from the node operator or your Gear deployment:

| File | Contents |
| --- | --- |
| `CONNECTION.json` | Schema 2 registration: `binding` plus `connection` containing SSH host alias, Python command, absolute node config path, and local/node gateway ports |
| `BINDING.json` | Only the frozen binding: `schema_version`, `node_id`, `generation`, `runtime_digest`, and `launcher: "process"` |
| `SNAPSHOT_REF.json` | Optional reference to a complete HF checkpoint already in the node's content-addressed store: `uri: "cas:sha256:…"`, matching `digest`, and `mediaType: "application/json"` |

Use the node's observed identities, not invented digests. SSH must work non-interactively for the daemon's user. Hitch probes the registered node and rejects a changed generation, runtime, or missing process capability. The [binding schema](../../schemas/model-node-binding.schema.json) defines its exact fields.

```bash
hitch model-node register --file CONNECTION.json --json
hitch model-node inspect --file BINDING.json --json
hitch models add-node SNAPSHOT_REF.json \
  --model-node-file BINDING.json --name coder --json
hitch models inspect local/coder --verify \
  --model-node-file BINDING.json --json
```

If the checkpoint is on the controller instead, use `hitch models add /models/coder-checkpoint --name coder` in place of `add-node`; Hitch transfers the required model content during remote preparation. `add-node` keeps an existing node snapshot in place without downloading its weights to the controller.

Next select an actual GPU UUID from node inspection and freeze the plan:

```bash
hitch local plan local/coder \
  --harness codex@version:0.145.0 \
  --gpu GPU-UUID \
  --model-node-file BINDING.json \
  --offline --json
```

Replace `GPU-UUID` with the observed UUID. Copy the returned `lock.inference_id`, including `sha256:` and all 64 hexadecimal digits, into the next command in place of `sha256:INFERENCE_DIGEST`. Planning validates and seals configuration; it does not launch a candidate task or prove that the model can generate.

```bash
hitch run \
  --harness codex@version:0.145.0 \
  --model local/coder \
  --model-node-file BINDING.json \
  --inference sha256:INFERENCE_DIGEST \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m --output json
```

For an evaluation, replace `--device cuda` in the managed evaluation example above with those same `--model-node-file` and `--inference` arguments. An exact lock already fixes the device and profile; do not combine it with an explicit `--device cuda` or `--local-profile` override. This keeps Harbor local while inference runs remotely; remote Harbor workers are a separate feature with additional admission requirements. The [recorded single-GPU acceptance](../../slime-training-binding.zh-CN.md#历史实机验收) covers a frozen local-Harbor/remote-model deployment, not all hardware, remote workers, or host-reboot recovery.

## Use an existing local service

First install and start your chosen inference engine and load a model that fits its available memory. Check its API protocol, model name, context capacity, streaming, and tool-call support before starting an agent. A successful text completion alone does not establish an agent tool loop.

For a local Ollama installation, select a model already available locally, then pass Codex's local-provider arguments through Hitch:

```bash
ollama list
hitch run \
  --harness codex@version:0.92.0 \
  --model LOCAL_MODEL_ID \
  --agent-arg --oss \
  --agent-arg --local-provider \
  --agent-arg ollama \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m \
  --output json
```

Replace `LOCAL_MODEL_ID` with the installed model's exact name. Select a locally served model, not an Ollama cloud model. Non-interactive Codex needs an explicit local provider; this example does not provision the engine or checkpoint through Hitch. See [Codex local providers](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers) and [Ollama's Codex integration](https://docs.ollama.com/integrations/codex) for engine setup and context requirements.

## Connect a custom endpoint

For SGLang, vLLM, a remote GPU server, or an API gateway, configure the Harness's endpoint explicitly. The Codex example below requires a **Responses API** endpoint with the model and tool support needed by the task. An endpoint implementing only `/v1/chat/completions` cannot satisfy this example merely by changing its URL. Engine setup is documented by [SGLang](https://docs.sglang.io/docs/basic_usage/openai_api), [SGLang tool parsing](https://docs.sglang.io/docs/advanced_features/tool_parser), and [vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/).

Assume your service is already listening at `http://127.0.0.1:8000/v1`. Set `MODEL_API_KEY` in the launching environment to the token accepted by that service, and replace `SERVED_MODEL_ID` with its served model name:

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --model SERVED_MODEL_ID \
  --agent-arg -c \
  --agent-arg 'model_provider="hitch_endpoint"' \
  --agent-arg -c \
  --agent-arg 'model_providers.hitch_endpoint={name="Inference",base_url="http://127.0.0.1:8000/v1",wire_api="responses",env_key="MODEL_API_KEY"}' \
  --workspace-mode worktree \
  --prompt "Summarize this repository without changing files." \
  --timeout 5m \
  --output json
```

The repeated `--agent-arg` entries forward individual arguments to Codex; each quoted TOML assignment stays one argument. Only the credential's environment-variable name appears in the configuration. If your local service deliberately requires no authentication, omit `env_key` instead of supplying a real cloud credential. For a remote service, replace the base URL with its actual HTTPS endpoint and use its authentication.

These provider keys are Codex settings, not universal Hitch flags. Claude Code, Pi, OpenCode, and DeepSeek Harness use their own provider configuration. Check `hitch inspect HARNESS --json` and the selected Harness version's documentation; an unknown adapter endpoint/capture capability does not certify a particular custom service. See the [Codex provider reference](https://learn.chatgpt.com/docs/config-file/config-reference) for the configuration contract.

## Reach the model from a Docker evaluation

For externally managed endpoints, inside a task container `127.0.0.1` points to that container. The URL that works for a host-side run may therefore fail in Harbor. Hitch-managed local and node inference instead supply their own container route.

| Where the service runs | Address used by the task container |
| --- | --- |
| Hosted API or remote inference server | Its reachable HTTPS endpoint |
| Docker Desktop host | Usually `host.docker.internal`, with the service port and API prefix |
| Linux Docker Engine host | An explicitly reachable host address, or a configured `host-gateway` mapping |
| Another worker or machine | An address reachable from that worker's task network, not the submitting laptop's loopback |

Docker Desktop provides the [host DNS name](https://docs.docker.com/desktop/features/networking/networking-how-tos/#connect-a-container-to-a-service-on-the-host). Linux Engine supports an explicit [host-gateway mapping](https://docs.docker.com/reference/cli/dockerd/#configure-host-gateway-ip). Hitch does not add a general-purpose Linux mapping for every arbitrary model endpoint. Configure the task's permitted network topology and verify reachability from it; a service bound only to host loopback may need a reachable interface. Keep the endpoint within the intended access boundary.

For Docker Desktop, after completing [evaluation setup](evaluations.md), use the following from the source checkout. The daemon must already have `MODEL_API_KEY` in its environment, and the service must be reachable from the task container:

```bash
hitch eval run --daemon \
  --dataset docs/guide/examples \
  --harness codex@version:0.92.0 \
  --model SERVED_MODEL_ID \
  --pass-env MODEL_API_KEY \
  --agent-arg -c \
  --agent-arg 'model_provider="hitch_endpoint"' \
  --agent-arg -c \
  --agent-arg 'model_providers.hitch_endpoint={name="Inference",base_url="http://host.docker.internal:8000/v1",wire_api="responses",env_key="MODEL_API_KEY"}' \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 \
  --max-concurrent 1 \
  --timeout 5m \
  --setup-timeout 15m \
  --output json
```

The permission argument is scoped to this trusted task container. For a remote model, change the base URL; for a direct evaluation with no daemon owning the root, omit `--daemon`. Container environments do not automatically inherit your host login or provider files. `--pass-env` explicitly forwards named variables for evaluations; ordinary host runs use their launching process environment and do not accept that flag.

## Account for daemon and inference capacity

Start the daemon after configuring the environment needed by the Harness. Exporting a new token in another shell does not update an existing daemon. To change its environment, first finish or cancel active work, then restart with the same root and resource settings.

| Inference path | How to budget parallel work |
| --- | --- |
| Managed local Docker | Reserve capacity for the inference service plus task containers. Service CPU, RAM, GPU, disk, and container reservations share the daemon's resource ledger. |
| Managed remote node | The node enforces model process/GPU ownership. The controller still budgets its tasks; its local GPU inventory does not represent the remote node. |
| External API or self-started engine | Model resources and request queues are outside Hitch's ledger. Allow for server memory, rate limits, and queue capacity yourself. |

Trials with a matching inference lock and permitted cache scope can share one loaded service and its reservation. The default `baseline` profile disables prefix caching; `--local-profile throughput` opts into greater request concurrency and Radix caching. It changes the inference identity. Task concurrency (`--max-concurrent`) and inference concurrency are separate limits: more trials can mean more queueing rather than more throughput.

An older running daemon may lack GPU or ephemeral-disk capacity. Finish or cancel its work before restarting with suitable `--capacity-gpus` and `--capacity-ephemeral-disk-mib` settings. Follow [daemon scheduling](daemon.md) when sizing the remaining task budget.

## Recover and release managed services

Use `hitch local status --json` to find service IDs. `hitch local stop SERVICE_ID --json` stops an idle service; active leases prevent a normal stop. `--force` can interrupt work, so cancel the owning run/evaluation first when that is your intention. `daemon stop` also cancels active work; it is not a pause command.

Recovery verifies ownership before reusing or releasing resources. Local Docker service recovery cleans up confirmed orphan containers; an interrupted token stream is not resumed. For a managed node in the same generation, supported recovery can reattach the original process and gateway only when the saved execution, ownership, and lease evidence match. Node unreachability alone does not prove that its GPU is free.

After a node OS reboot, register its current generation's connection and explicitly reconcile an old service:

```bash
hitch model-node register --file CURRENT_CONNECTION.json --json
hitch model-node recover-service SERVICE_ID \
  --file CURRENT_BINDING.json --json
hitch local inspect-service SERVICE_ID --json
```

This requires the node's archived ownership and physical release evidence. It releases the old allocation without reloading weights for the old task; missing evidence leaves ownership unresolved. Service recovery does not replace [run/evaluation recovery](daemon.md). See [model service recovery](../../slime-training-binding.zh-CN.md#模型服务恢复) for the exact supported boundaries.

## Preserve model evidence

Inspect the final run with `hitch runs inspect RUN_ID --json`. Preserve the requested and effective model identifiers, Harness version, non-secret endpoint configuration, sampling settings, and available usage evidence. For a self-hosted model, also retain checkpoint, tokenizer/template, quantization, and serving-runtime versions; a mutable server alias alone cannot identify the weights.

Ordinary runs accept `--model-identity-file` for structured identity metadata. It does not configure an endpoint or load a checkpoint, and the eval CLI does not accept that flag. Do not mark an external identity resolved merely because the server echoed a model name.

Managed inference saves `model_id`, `runtime_id`, `inference_id`, the exact lock, and execution observations. A remote node also binds its node ID, generation, and runtime digest. Use `local/sha256:…` and `--inference sha256:…` from saved evidence when you need an exact model and configuration; a friendly alias can be reassigned. See [runs and evidence](runs-and-evidence.md).

## Diagnose a connection problem

| Symptom | What to check |
| --- | --- |
| Authentication fails | The variable or saved login expected by this Harness, and whether it reaches the daemon/container |
| Model not found | The exact served model ID and the Harness's provider selection syntax |
| `/responses` returns 404 | API protocol and base path; Chat Completions compatibility alone is insufficient |
| Works on the host, fails in Docker | Container loopback, DNS, service bind address, port, and task network policy |
| Text works, tools fail | Model chat template, tool parser, Responses/tool-call support, and context budget |
| Timeouts under parallel load | Inference queue depth, KV-cache/memory pressure, provider rate limits, and trial concurrency |
| `models`, `local`, or `model-node` is unknown | An older CLI is running; check the source revision and installed executable, then rebuild current dev |
| Managed inference rejects a Harness | Use the supported exact Harness version and required tool protocol/parser |
| Node runtime/generation mismatch | Inspect and register the actual node; preserve the old binding for existing work and reconcile its resource ownership |
| GPU remains reserved after failure | Inspect service/lease evidence; a dead daemon or unreachable node does not prove physical release |

## Use the current dev build

If your installation predates these integrations, build a separate dev checkout with Node.js 22+:

```bash
git clone --branch dev https://github.com/rsi-gear/agent-hitch.git hitch-dev
cd hitch-dev
npm ci
npm run build
npm link
hitch --version
git rev-parse HEAD
```

`npm link` makes this checkout's CLI available as `hitch`; check that your shell resolves it before following the managed examples. Record the Git commit as well as the package version. You can call `node /absolute/path/to/hitch-dev/dist/bin/hitch.js` directly if you prefer not to change the global CLI.
