# 本地与远程模型推理

Harness 和推理服务需要分别选择。`--harness` 选择智能体程序，`--model` 选择模型。Hitch 可以调用已有 API、管理本机 SGLang，也可以使用已注册的远程模型节点。

本章对应 Hitch 0.2.10 的托管推理功能。在该版本发布到 npm 前，请[使用当前 dev 构建](#使用当前-dev-构建)。

```text
Hitch → 宿主机或任务容器中的 Harness → 模型 API
                                      ├─ 云模型服务
                                      ├─ 自建远程推理服务
                                      ├─ 自建本地推理服务
                                      └─ Hitch 托管 SGLang：本机或远程节点
```

## 选择推理位置

| 场景 | 需要配置什么 | 谁管理推理资源 |
| --- | --- | --- |
| 云模型 API | Provider 支持的模型 ID 和认证 | API 服务商 |
| 自建远程服务 | 可达的服务地址、兼容协议、服务端模型名和认证 | 你的推理部署 |
| 自建本地服务 | 本地引擎、已加载模型和 Harness 兼容的端点 | 用户独立于 Hitch 管理 |
| Hitch 托管本机 SGLang | 导入的 Checkpoint 和 CPU/CUDA 选择 | Hitch daemon 和本机资源账本 |
| Hitch 托管远程模型节点 | 导入的模型、节点绑定、确定的 GPU 与推理锁 | Hitch 协调服务，模型节点管理其 GPU 分配 |

模型位置与智能体工具的执行位置相互独立。本地 Harness 可以调用远程模型，Docker 评测也可以调用宿主机上的模型。评测参数 `--provider local-docker` 选择执行 Provider，不是选择模型服务商。

`local/<name>` 是 Hitch 对已导入托管模型的选择方式。加上 `--model-node-file` 后，模型在绑定的节点上运行；`local/` 前缀并不要求 GPU 位于提交命令的电脑上。

## 调用远程模型 API

先完成 [Quick Start](quickstart.md)，包括认证和干净仓库准备。Codex 可以使用已保存的 CLI 登录，也可以通过日常密钥管理方式提供 `CODEX_API_KEY`，用于非交互执行。详见 [Codex 自动化认证](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)。

把 `MODEL_ID` 替换为账户可用、且所选 Harness 接受的模型：

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --model MODEL_ID \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件。" \
  --timeout 5m \
  --output json
```

Hitch 不会在适配器之间转换模型名称。Codex 接收自身使用的模型 ID；DeepSeek Harness 按已配置的 Provider 行解释 `provider/model`；OpenCode 使用它原生的 Provider/Model 选择方式。省略 `--model` 时由 Harness 配置决定。仅添加 Provider 前缀或模型名称，不会配置一个新的服务地址。

## 在本机运行托管 SGLang

准备磁盘上完整的 Hugging Face safetensors Checkpoint，包括配置与 Tokenizer。`models add` 导入内容并计算摘要，不会下载权重；这条路径不接受 GGUF、不完整的 Checkpoint 或要求执行任意远程代码的模型。替换模型路径，并从干净的目标 Git 仓库运行：

```bash
hitch models add /models/coder-checkpoint --name coder
hitch run \
  --harness codex@version:0.145.0 \
  --model local/coder \
  --device cuda \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件。" \
  --timeout 5m \
  --output json
```

Hitch 解析模型、固定推理运行时与配置，按需启动 daemon 和 SGLang，并向 Harness 提供私有模型路由。使用这条托管路径不需要云模型登录，也不需要手动传入端点。

`--device` 默认为 `auto`；比较不同后端时，显式选择 `cpu` 或 `cuda`。本机 Docker 运行时目前面向 **Linux/amd64，搭配 Intel Xeon AMX CPU 或一张兼容的 NVIDIA CUDA GPU**；CUDA 还需要可用的容器 GPU 支持。macOS/Metal、普通非 AMX 桌面 CPU 和多卡执行不在这条本机预览路径的支持范围内。不支持的硬件会在预检时失败，不会回退到云模型。本机 Docker 运行时仍为 Preview，完整硬件发布验收尚待完成，详见[本地推理实现状态](../../local-model-inference-spec.zh-CN.md)。

托管 Codex 推理要求 **`codex@version:0.145.0`**，以及配置了工具解析器的模型类型；Quick Start 中较旧的 Codex 固定版本用于外部 API 示例。`model-call` 提供纯文本路径；`training-tool` 使用单独的 Chat Completions 绑定，见[训练集成](../../slime-training-binding.zh-CN.md)。这不代表所有 Harness 或所有 SGLang 兼容模型都受支持。

需要提前准备或检查状态时，可使用：

```bash
hitch local doctor --device cuda --json
hitch local prepare local/coder --device cuda --profile baseline --json
hitch models inspect local/coder --verify --json
hitch local status --json
```

Doctor 检查主机准入条件，Prepare 启动并探测推理链路。首次准备可能下载按摘要固定的运行时镜像。`--offline` 禁止这一步下载，要求缓存已准备好；它不会关闭智能体工具或 Verifier 的网络。

完成 [Harbor 配置](evaluations.md)后，同一模型也可用于本机 Docker 评测。从包含指南示例任务的 Hitch 源码仓库执行：

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

权限参数作用于这个可信任务容器。Hitch 自动提供容器中的模型路由和凭据，这条托管配置无需添加端点覆盖或云密钥。

## 使用托管远程模型节点

模型需要在远程 GPU 上推理，而 Harness 或 Harbor 任务在其他机器执行时，使用节点绑定。节点应事先安装 Gear 的 `gear_training.node` 协议 v2、SGLang 和配置好的 Python 环境，并具有一张可用的 CUDA GPU。普通 OpenAI 兼容 URL 不能直接作为此类节点。节点部署与已验证的范围见 [Gear / Slime 集成](../../slime-training-binding.zh-CN.md)。

从节点维护者或 Gear 部署中取得以下文件：

| 文件 | 内容 |
| --- | --- |
| `CONNECTION.json` | Schema 2 注册信息：`binding` 与 `connection`，后者包含 SSH 主机别名、Python 命令、节点配置的绝对路径和本机/节点网关端口 |
| `BINDING.json` | 仅包含固定的绑定：`schema_version`、`node_id`、`generation`、`runtime_digest` 和 `launcher: "process"` |
| `SNAPSHOT_REF.json` | 可选，指向节点内容寻址存储中已有的完整 HF Checkpoint：`uri: "cas:sha256:…"`、对应 `digest` 和 `mediaType: "application/json"` |

使用节点实际观测到的身份，不能自行编造摘要。Daemon 用户必须能非交互地使用 SSH。Hitch 会探测节点，拒绝 generation、运行时不一致或缺少进程管理能力的注册。精确字段见[节点绑定 Schema](../../schemas/model-node-binding.schema.json)。

```bash
hitch model-node register --file CONNECTION.json --json
hitch model-node inspect --file BINDING.json --json
hitch models add-node SNAPSHOT_REF.json \
  --model-node-file BINDING.json --name coder --json
hitch models inspect local/coder --verify \
  --model-node-file BINDING.json --json
```

如果 Checkpoint 在控制端，使用 `hitch models add /models/coder-checkpoint --name coder` 替代 `add-node`；Hitch 会在远程准备时传输所需模型内容。`add-node` 直接使用节点上的已有快照，无需把权重下载到控制端。

接着从节点检查结果中选择真实 GPU UUID，并固定推理计划：

```bash
hitch local plan local/coder \
  --harness codex@version:0.145.0 \
  --gpu GPU-UUID \
  --model-node-file BINDING.json \
  --offline --json
```

将 `GPU-UUID` 替换为观测到的 UUID，再把返回的 `lock.inference_id`（包含 `sha256:` 和完整 64 位十六进制摘要）填入下方的 `sha256:INFERENCE_DIGEST`。Plan 验证并固定配置，不会启动候选任务，也不代表模型已能生成回答。

```bash
hitch run \
  --harness codex@version:0.145.0 \
  --model local/coder \
  --model-node-file BINDING.json \
  --inference sha256:INFERENCE_DIGEST \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件。" \
  --timeout 5m --output json
```

进行评测时，把上方托管评测示例中的 `--device cuda` 替换为相同的 `--model-node-file` 和 `--inference` 参数。精确推理锁已经固定设备和 Profile，不要同时传入显式 `--device cuda` 或 `--local-profile` 覆盖。这样 Harbor 仍在本机、模型推理在远程；远程 Harbor Worker 是另一项有额外准入要求的功能。[已有单卡验收](../../slime-training-binding.zh-CN.md#历史实机验收)只覆盖固定版本的本地 Harbor/远程模型部署，不代表所有硬件、远程 Worker 或主机重启恢复都已验收。

## 连接已有的本地服务

先安装并启动推理引擎，加载适合可用内存的模型。开始运行智能体前，确认接口协议、模型名称、上下文容量、流式输出及工具调用支持。单次文本生成成功，并不代表智能体工具调用闭环可用。

对于本地 Ollama，选择已经存在于本机的模型，再通过 Hitch 传入 Codex 的本地 Provider 参数：

```bash
ollama list
hitch run \
  --harness codex@version:0.92.0 \
  --model LOCAL_MODEL_ID \
  --agent-arg --oss \
  --agent-arg --local-provider \
  --agent-arg ollama \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件。" \
  --timeout 5m \
  --output json
```

用已安装模型的精确名称替换 `LOCAL_MODEL_ID`，并选择本地执行的模型，而不是 Ollama 云模型。非交互 Codex 需要明确指定本地 Provider；这个示例不会通过 Hitch 准备引擎或 Checkpoint。引擎配置和上下文要求见 [Codex 本地 Provider](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers)及 [Ollama 的 Codex 集成](https://docs.ollama.com/integrations/codex)。

## 连接自定义端点

使用 SGLang、vLLM、远程 GPU 服务器或 API 网关时，要显式配置 Harness 的端点。下面的 Codex 示例要求端点支持 **Responses API**，以及任务需要的模型与工具能力。仅实现 `/v1/chat/completions` 的服务，不能只改 URL 就满足这个示例。引擎配置可参考 [SGLang](https://docs.sglang.io/docs/basic_usage/openai_api)、[SGLang 工具解析](https://docs.sglang.io/docs/advanced_features/tool_parser)和 [vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/)。

假设服务已在 `http://127.0.0.1:8000/v1` 监听。将它接受的 Token 放入启动环境的 `MODEL_API_KEY`，并把 `SERVED_MODEL_ID` 替换为服务端提供的模型名：

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --model SERVED_MODEL_ID \
  --agent-arg -c \
  --agent-arg 'model_provider="hitch_endpoint"' \
  --agent-arg -c \
  --agent-arg 'model_providers.hitch_endpoint={name="Inference",base_url="http://127.0.0.1:8000/v1",wire_api="responses",env_key="MODEL_API_KEY"}' \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件。" \
  --timeout 5m \
  --output json
```

重复的 `--agent-arg` 分别向 Codex 传递一个参数；每段带引号的 TOML 赋值必须保持为一个参数。配置中只出现认证环境变量名。如果本地服务明确不需要认证，省略 `env_key`，不要填入真实云端密钥。对于远程服务，把 Base URL 换成实际 HTTPS 端点，并使用该服务的认证。

这些 Provider 字段属于 Codex 配置，不是 Hitch 的通用参数。Claude Code、Pi、OpenCode 和 DeepSeek Harness 使用各自的 Provider 配置。先查看 `hitch inspect HARNESS --json` 和所选 Harness 版本的文档；适配器端点或采集能力标记为 unknown，不代表已经验证某个自定义服务兼容。字段契约见 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 从 Docker 评测访问模型

对于外部管理的端点，任务容器中的 `127.0.0.1` 指向容器本身。宿主机 Run 可用的地址，在 Harbor 中可能无法访问。Hitch 托管本机或节点推理则会自行提供容器路由。

| 服务位置 | 任务容器使用的地址 |
| --- | --- |
| 云 API 或远程推理服务器 | 容器可达的 HTTPS 端点 |
| Docker Desktop 宿主机 | 通常使用 `host.docker.internal`，加上服务端口和 API 前缀 |
| Linux Docker Engine 宿主机 | 明确可达的宿主地址，或已配置的 `host-gateway` 映射 |
| 其他 Worker 或机器 | 该 Worker 的任务网络可以访问的地址，不是提交请求的笔记本的 Loopback |

Docker Desktop 提供[宿主机 DNS 名称](https://docs.docker.com/desktop/features/networking/networking-how-tos/#connect-a-container-to-a-service-on-the-host)，Linux Engine 支持显式配置 [host-gateway 映射](https://docs.docker.com/reference/cli/dockerd/#configure-host-gateway-ip)。Hitch 不会为所有任意模型端点自动添加通用 Linux 映射。应配置任务允许的网络拓扑，并从该网络验证可达性；仅监听宿主机 Loopback 的服务可能需要配置可达接口。端点应保持在预期的访问边界内。

对于 Docker Desktop，完成[评测准备](evaluations.md)后，可以从源码仓库执行以下命令。Daemon 自身环境必须已经包含 `MODEL_API_KEY`，服务也必须能从任务容器访问：

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

权限参数仅作用于这个可信任务容器。使用远程模型时替换 Base URL；没有 daemon 占用 root、希望直接评测时，去掉 `--daemon`。容器不会自动继承宿主机的登录和 Provider 配置文件。评测通过 `--pass-env` 显式传递命名变量；普通宿主机 Run 使用启动进程的环境，不接受该参数。

## 协调 daemon 与推理容量

先配置 Harness 所需环境，再启动 daemon。之后在另一个 Shell 导出新 Token，不会更新已有 daemon。需要更换其环境时，先完成或取消活动任务，再使用原 root 和资源参数重新启动。

| 推理路径 | 如何为并行任务分配容量 |
| --- | --- |
| 托管本机 Docker | 同时预留模型服务和任务容器的容量；服务的 CPU、内存、GPU、磁盘和容器预留进入 daemon 的统一资源账本。 |
| 托管远程节点 | 节点管理模型进程与 GPU 归属；控制端仍为自己的任务分配资源，本机 GPU 数量不能代表远程节点容量。 |
| 外部 API 或自行启动的引擎 | 模型资源和请求队列不在 Hitch 账本内，需要自行考虑服务内存、限流和排队容量。 |

推理锁相同、且缓存作用域允许共享的 Trial 可以复用一个已加载服务及其资源预留。默认 `baseline` 禁用前缀缓存；`--local-profile throughput` 显式启用更高的请求并发和 Radix 缓存，也会改变推理身份。任务并发（`--max-concurrent`）和推理并发是两个限制；增加 Trial 可能只是增加排队。

已有旧 daemon 可能未配置 GPU 或临时磁盘容量。先完成或取消其任务，再使用合适的 `--capacity-gpus`、`--capacity-ephemeral-disk-mib` 重启。其余任务资源预算见 [daemon 调度](daemon.md)。

## 恢复与释放托管服务

通过 `hitch local status --json` 查找服务 ID。`hitch local stop SERVICE_ID --json` 可以停止空闲服务；存在活动租约时，普通停止会被拒绝。`--force` 可能中断工作，如果确实要结束任务，应先取消所属 Run/Eval。`daemon stop` 也会取消活动任务，不是暂停命令。

恢复时，Hitch 先确认归属，再复用或释放资源。本机 Docker 服务恢复会清理确认归属的遗留容器，不会续接中断的 Token 流。托管节点处于同一 generation 时，受支持的恢复路径可在执行、归属和租约证据匹配后接管原进程与网关。节点暂时不可达不代表其 GPU 已空闲。

节点 OS 重启后，先注册当前 generation 的连接，再显式核对旧服务的释放：

```bash
hitch model-node register --file CURRENT_CONNECTION.json --json
hitch model-node recover-service SERVICE_ID \
  --file CURRENT_BINDING.json --json
hitch local inspect-service SERVICE_ID --json
```

此操作要求节点保留旧归属与实际资源释放证据。它会释放旧预留，不会为旧任务重新加载权重；缺少证据时仍保留未确认状态。服务恢复不能替代 [Run/Eval 恢复](daemon.md)，详细边界见[模型服务恢复](../../slime-training-binding.zh-CN.md#模型服务恢复)。

## 保存模型证据

使用 `hitch runs inspect RUN_ID --json` 检查最终运行，保留请求与实际模型 ID、Harness 版本、不含密钥的端点配置、采样设置及可用 Usage 证据。自建模型还应保留 Checkpoint、Tokenizer/Template、量化及推理运行时版本；可变服务别名无法单独标识权重。

普通 Run 接受 `--model-identity-file` 作为结构化身份元数据，它不会配置端点或加载 Checkpoint，Eval CLI 也不接受该参数。不能仅因服务回传模型名就把外部身份标记为已解析。

托管推理保存 `model_id`、`runtime_id`、`inference_id`、完整推理锁和执行观测。远程节点还绑定节点 ID、generation 和运行时摘要。需要固定模型与配置时，使用证据中的 `local/sha256:…` 和 `--inference sha256:…`；易读别名可以被重新指向其他模型。详见[查看运行与证据](runs-and-evidence.md)。

## 诊断连接问题

| 现象 | 检查内容 |
| --- | --- |
| 认证失败 | 这个 Harness 要求的变量或登录，以及是否传入 daemon/容器 |
| 找不到模型 | 服务端精确模型 ID，以及 Harness 的 Provider 选择语法 |
| `/responses` 返回 404 | API 协议和 Base Path；仅兼容 Chat Completions 不够 |
| 宿主机能访问，Docker 不能 | 容器 Loopback、DNS、服务监听地址、端口和任务网络策略 |
| 文本可用，工具调用失败 | 模型模板、工具解析器、Responses/Tool Call 支持和上下文预算 |
| 并行后频繁超时 | 推理队列、KV Cache/内存压力、服务商限流和 Trial 并发 |
| 不认识 `models`、`local` 或 `model-node` 命令 | 正在运行旧 CLI；检查源码提交与实际可执行文件，重新构建当前 dev |
| 托管推理拒绝 Harness | 使用支持的确定版本，以及所需的工具协议与解析器 |
| 节点运行时或 generation 不一致 | 检查并注册实际节点；保留已有任务的旧绑定，并核对旧资源归属 |
| 失败后 GPU 仍被预留 | 检查服务与租约证据；daemon 退出或节点不可达不能证明资源已释放 |

## 使用当前 dev 构建

如果当前安装早于这些集成，使用 Node.js 22+ 构建独立的 dev 工作目录：

```bash
git clone --branch dev https://github.com/rsi-gear/agent-hitch.git hitch-dev
cd hitch-dev
npm ci
npm run build
npm link
hitch --version
git rev-parse HEAD
```

`npm link` 将该工作目录中的 CLI 链接为 `hitch`；执行托管示例前，确认 Shell 实际解析到它。记录 Git 提交和包版本。也可以直接调用 `node /absolute/path/to/hitch-dev/dist/bin/hitch.js`，避免更改全局 CLI。
