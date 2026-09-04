# Hitch 本地模型推理实现 Spec（SGLang）

- 状态：Preview implementation；核心代码与无硬件 contract tests 已实现，真实 Linux CPU/CUDA/Harbor release gate 尚未执行，因此不能标记为 P0 GA。
- 日期：2026-09-04；修订：用户确认从 llama.cpp 改为 SGLang。
- Hitch 基线：`e137518f5529fb9d36655f9a0fa2ffd011b4ac49`，实现分支 `codex/sglang-local-inference`，当前包版本 `0.2.8`。
- 明确需求：通过集成一个推理框架，同时支持 CPU 和 GPU 本地推理。
- 决策：仅集成 **SGLang Serving Runtime（SRT）**；Hitch 通过 HTTP 管理其推理服务，不在 Node.js 内嵌 Python，不引入 SGLang 的 Agent 编排语言或第二推理框架。

当前 preview 已落地模型 CAS、digest-pinned CPU/CUDA runtime catalog、doctor/preflight/inference lock、daemon 持有的 SGLang supervisor、run-scoped Responses gateway、Codex/model-call 绑定、普通 run 与本机 Harbor eval 接入、证据和恢复记录。`npm run check` 覆盖的 fake runtime、协议、并发、恢复和回归测试属于实现验收，不替代 §15.3 的真实硬件认证。

## 1. 方案摘要

用户添加本地 Hugging Face checkpoint 后，直接沿用 `hitch run` / `hitch eval run` 并选择 CPU 或 GPU。Hitch 在执行前自动选择认证的 SGLang runtime、生成并封存不可变 inference lock，同时管理制品、资源、服务生命周期、Harness 接入和证据；SGLang 管理模型执行、连续批处理、KV/prefix cache 与平台 kernel。普通用户不需要管理镜像、lock 文件、端口或服务 ID。

核心原则：**Harness、checkpoint、推理运行时分别锁定；CPU 和 GPU 是不同的已认证执行配置。** 引擎切换不改变 Hitch 的证据链与 Harbor 的任务执行职责。

### 1.1 支持范围

| 平台/backend | 集成方式 | 交付范围 |
| --- | --- | --- |
| Linux x64 / `cpu` | 固定摘要的 SGLang CPU OCI 镜像，CPU engine | P0；以具备 AMX 的 Intel Xeon 为首批认证设备 |
| Linux x64 / `cuda` | 固定摘要的 SGLang CUDA OCI 镜像 | P0；单机单卡，认证型号/驱动组合 |
| macOS arm64 / `metal` | Hitch 私有 Python 环境，SGLang MLX backend | P1 独立认证项；保留接口，但不得在 P0 宣称已支持 |
| 非 AMX 桌面 CPU、macOS 纯 CPU、Linux arm64、其他 GPU/OS | 按 backend profile 扩展 | 尚未认证，doctor 明确拒绝；不自动改用另一个引擎 |

上游 CPU 指南目前重点覆盖 Xeon/AMX，Metal 使用 MLX，不能把它们当作所有桌面 CPU 或任意 GPU 的统一可用性承诺。[CPU 指南](https://docs.sglang.io/docs/hardware-platforms/cpu_server)、[Metal 指南](https://docs.sglang.io/docs/hardware-platforms/apple_metal)

与上一版相比，**取消“无需 Python/Docker 的通用 CPU 运行”和 llama.cpp 式逐层 GPU 卸载承诺**。P0 用户主机需要 Docker；Python、PyTorch 和 kernel 随运行时镜像隔离，无需安装到全局环境。CUDA 额外要求已配置的驱动及容器 GPU runtime；CPU 模式不要求 GPU 驱动。多卡 TP、远端服务、CPU offload 和 MLX 不包含在 P0 验收中。

### 1.2 选型依据与取舍

采用 SGLang，是为了把 Hitch 本地推理的优先级调整为 **checkpoint 原生加载与批量 Agent 评测**。SGLang 提供前缀缓存、连续批处理及面向服务器的并行执行能力；具体性能仍须以 Hitch workload 实测，不能引用框架宣传数据代替验收。[项目说明](https://github.com/sgl-project/sglang)

| 维度 | 本次决定 |
| --- | --- |
| 模型格式 | P0 使用完整的 HF/safetensors checkpoint，不再强制转 GGUF |
| 引擎 | 只有 SGLang；llama.cpp 不作为 fallback 或隐藏依赖 |
| 交付方式 | Linux 优先 OCI 镜像，以 image digest 固定 Python/框架/kernel；Metal 后续使用独立环境 |
| 并发 | Hitch 控制有界请求准入，SGLang 内部调度与批处理；不由 Hitch 拼 token batch |
| 缓存 | 批量评测可开启 Radix prefix cache，同时单列禁缓存基线与缓存隔离规则 |
| 代价 | 更重的运行时、更加具体的硬件要求；模型×backend×kernel 兼容矩阵必须实测 |

上游 loader 支持 safetensors，也支持 GGUF 等格式；Hitch 首版主动只开放 safetensors，以减少可执行反序列化、格式转换和跨后端量化差异。这个限制是本产品的实现范围，不是 SGLang 的格式能力上限。[模型加载文档](https://docs.sglang.io/docs/advanced_features/model_loading)

## 2. 目标与非目标

### 2.1 必须交付

1. 在认证 Linux CPU 与 NVIDIA GPU 上通过同一套 Hitch CLI 管理 SGLang 服务。
2. 准备完成后模型推理不访问云推理 API，不需要用户云模型 API key。
3. 支持普通 run 和本机 Harbor local-docker 评测；多个 trial 共享一个已加载服务，资源只计一次。
4. P0 打通 `model-call` Responses 文本路径，并认证至少一个固定版本 Codex 的完整工具调用闭环。
5. 固定 checkpoint 全文件、tokenizer/template、运行时镜像、backend、缓存、采样和调度配置。
6. 支持取消、超时、OOM、引擎/容器崩溃、daemon 恢复、并发复用及安全清理。
7. 保留可扩展 backend 契约，但未知硬件、模态、协议或参数必须 fail closed。

### 2.2 不在 P0

- 不训练、不转换或隐式量化模型；不加载 pickle checkpoint，不启用 trust_remote_code、自定义 loader/plugin。
- 不接管用户自行启动的 SGLang，不实现通用外部 endpoint 管理。
- 不实现多机、同机多 GPU TP/DP/EP、PD 分离、LoRA 热加载、权重在线更新或 CPU offload。
- 不接入第二引擎，也不引入 SGLang Model Gateway/Router 形成第二套服务调度层。
- 不承诺所有模型、Harness、硬件后端；MLX 仅规划为 P1。
- 不承诺图片、音视频、embedding、rerank、OSWorld 视觉候选路径；不做隐式文本降级。
- 不开放远端 worker 的模型本地推理；P0 local 指本机 Docker Engine 所在主机。
- 不承诺跨硬件逐 token 一致；本地 candidate 也不代表整个 Agent 或 verifier 已断网。

## 3. 现有实现及改造依据

以下是基线源码已有行为，不是计划实现：

| 位置 | 已有能力/限制 | 本方案需要的变化 |
| --- | --- | --- |
| `src/model-access/proxy.ts` | `HostModelProxy` 支持 HTTP/SSE 转发与采集；强制 `eval_id`；上游按 openai/anthropic 固定，默认取环境变量或云端地址 | 提取共享转发组件，新增强绑定本地上游和 ad-hoc run 支持 |
| `src/model-access/policy.ts` | 根据 endpoint override、adapter 和 execution provider 决定采集，可选采集允许降级 | 本地路由独立于采集策略，路由失败不得降级为云调用 |
| `src/domain/runs.ts` | `ModelIdentityV1` 有请求/有效 ID、参数摘要和 resolved 标志 | 增加本地推理证据引用，区分模型与运行时 |
| `src/evals/execution-plan.ts` | candidate digest 包含 Harness 制品、请求模型字符串、agent args、超时 | 本地 candidate digest 必须包含 inference lock，不能只含 alias |
| `src/control-plane/resources.ts` | 内存中的 `ResourceLedger` 支持 CPU/RAM/GPU 数量配额 | 新增长驻 inference allocation 和实际设备绑定/持久化恢复 |
| `src/adapters/contract.ts` | adapter 接收运行目录与 runtime home，无类型化模型连接信息 | 增加进程内 `model_endpoint` binding |
| `integrations/model-call/cli.js` | 只发一次 Responses 请求、禁止工具；要求 `OPENAI_API_KEY`；HTTP 仅接受 loopback | 保留 no-tools 不变量，接入本地凭证与受验证的容器代理地址 |
| `src/adapters/providers/codex.ts` | 可覆盖 endpoint，但未建立本地模型兼容认证 | 按精确 Harness 版本生成隔离 provider 配置并测试 |
| Pi / OpenCode / DeepSeek adapters | endpoint override 是 `unknown`，proxy compatible 为 false | 未完成专门适配前禁止选择本地模型 |
| `src/evals/model-capture-runtime.ts`、Harbor bridge | 有 host-side 代理绑定、容器 reachability probe | 复用拓扑，不在任务容器内启动推理引擎 |

另外，`docs/design.md` 原本将 model routing 排除在产品边界外。本变更只增加**锁定到一个本地模型服务的绑定**，不扩展为通用模型网关产品；实现时同步更新该边界说明。

## 4. 架构与模块边界

```text
CLI / daemon API
        │  local model reference + inference lock
        ▼
control-plane：资源准入、服务租约、运行调度
        │
        ├── inference：权重/运行时 CAS、设备探测、SGLang service supervisor
        │                                      │
        │                                      ▼
        │                              SGLang SRT（CPU/CUDA；Metal P1）
        │                                      ▲
        ▼                                      │ loopback + engine token
runs / evals ── Harness ──► model-access：run-scoped 路由、限流、采集
                    （宿主机或 Harbor 任务容器）
```

新增 `src/inference/`，只依赖 `domain`、`foundation`。`model-access` 同样不依赖 `control-plane` 或 `evals`。通过 domain 中的接口及编排层注入资源准入、路由注册和租约操作，不制造反向依赖。

- `inference`：只管理引擎、模型与运行进程，不理解 benchmark reward 或 Harness 工具执行。
- `model-access`：只路由已绑定请求，不选择设备/模型，不下载权重。
- `adapters`：只将连接 binding 转成各 Harness 的 argv/env/私有配置，不启动引擎。
- `control-plane`：持有 `InferenceManager` 和 `ResourceLedger`，是唯一服务调度者。
- `runs/evals`：通过注入的协调接口 acquire/release；不能从这里向上 import `control-plane`。
- `daemon`：挂载新 API，处理用户请求；CLI 通过模块 facade 调用，不直接读写服务状态文件。

本地推理采用 daemon 单一所有者：`run/eval` 发现 `--model local/<name>` 后自动确保本 root 的 daemon 存在，完成本地推理 preflight，再提交并等待结果。CLI 必须报告首次 runtime 准备、最终 device/profile 和 inference_id。非本地模型的旧 direct run 保持不变。进程内 API 调用者必须注入同一个 manager/client，不能偷偷启动第二套 supervisor。

## 5. 用户接口

普通流程只增加 `models add` 和一个可选的 `--device`；已有 `run/eval` 用法不再要求用户先执行 setup、doctor、prepare，也不要求传递 lock 文件。下列接口已在 preview 分支实现。

```bash
# 一次添加：导入并校验 config、tokenizer、模板及 safetensors 权重。
hitch models add /models/coder-checkpoint --name coder

hitch run --harness codex@version:<tested-version> \
  --model local/coder --device cpu \
  --prompt "Inspect this repository"

hitch eval run --backend harbor --dataset terminal-bench@2.0 \
  --harness codex@version:<tested-version> --model local/coder \
  --device cuda \
  --model-capture hybrid --require-model-capture
```

`--device` 缺省为 `auto`。首版 `auto` 在提交 preflight 中优先选择有足够容量且已认证的 CUDA，否则选择已认证 CPU；选择结果在启动 candidate 前固化并显示，retry/resume/rerun 不重新选择。两个都不可用时直接报错，不尝试未认证 backend。

首次使用某个 backend 时，Hitch 在 candidate 启动前显示 one-time setup 阶段，拉取 catalog 中固定 digest 的 OCI 镜像、执行 doctor/probe 并保存内部 lock。机器可读输出产生 `inference.preparing` 事件。`--offline` 模式禁止拉取，缺少 runtime 时给出下面的预准备命令，而不是在运行中联网。

运维和高级复现接口单独收在 `hitch local` 下，不进入 happy path：

```bash
# CI、离线环境或希望提前下载时使用；返回可选的 inference_id。
hitch local prepare local/coder --device cuda --profile baseline --json

hitch local doctor --device cuda --json
hitch local status --json
hitch local stop                         # 只停当前 root 的空闲服务
hitch models inspect local/coder --json
hitch models gc --dry-run --json

# 高级用法：新的 run 固定复用已准备的推理身份；不能再同时指定 device/profile。
hitch run ... --model local/coder --inference sha256:<inference-id>
```

接口规则：

1. `local/<alias>` 或 `local/sha256:<digest>` 只用于选择模型；不能原样交给 Harness 猜 provider。
2. `models add` 是唯一普通导入入口，只接受本地完整目录；它不要求用户理解 SGLang，也不把绝对源路径作为后续执行依赖。
3. 本地 run/eval 在创建 candidate 前完成 preflight：解析 alias、runtime、device、默认 profile 和全部参数，生成内部 lock/inference_id，再原子提交。候选一旦提交就不允许改变这些选择。
4. 普通 run/eval 默认使用 `baseline` profile；批量评测只有显式 `--local-profile throughput` 才启用更高并发和 Radix cache。高级参数不散落成几十个 CLI flag，而通过版本化 profile 管理。
5. `--inference` 只接受本 root 中已验证的 inference_id；model 不匹配或同时传 device/profile 时失败。默认路径不要求该参数。
6. 本地 run/eval（包括 daemon submit）在 preflight 阶段自动准备缺失的认证 runtime，并显示 digest、大小和进度；不得下载权重、tokenizer、模型代码或任意 tag。只有显式 `--offline` 禁止该行为，缺 runtime 时返回可复制的 `hitch local prepare` 命令。
7. doctor 只读。preview 的 `local prepare` 完成 runtime 拉取、完整性检查和 lock 固化；首次真实 acquire 负责加载模型、Responses 探测和短生成。独立 prewarm operation 属于后续管理面增强。两者都不是 happy path 的必做步骤。
8. `local stop` 有活跃租约时报 `inference_in_use`；`--force` 会撤销 gateway 并停止服务，使受影响运行 fail closed。由 daemon 主动给所有关联 run/eval 写入取消状态属于后续增强。GC 默认 dry-run，只有 `--apply` 才删除；alias 或 inference lock 引用的模型不得删除。
9. `--root` / `HITCH_ROOT` 隔离所有服务记录和缓存；机器输出带 schema_version，不输出 secret。
10. P1 的 `--device metal` 只有对应认证 catalog 存在才开放；P0 返回 `inference_device_unsupported`。

## 6. 数据契约与身份

### 6.1 新增实体

| 实体 | 必须包含 | 不可作为唯一身份 |
| --- | --- | --- |
| `LocalModelManifestV1` | model_id、format=hf-safetensors、排序全文件清单(path/size/sha256)、权重索引、架构/dtype/量化元数据、tokenizer/template/config 摘要、来源与许可证信息 | repo 名、分支名、可变目录 |
| `InferenceRuntimeManifestV1` | runtime_id、engine=sglang、SGLang commit/version、平台/backend、Python/PyTorch/kernel 版本与 SBOM、运行包身份、兼容测试版本 | PATH 中的 Python 或单独的 pip 包版本 |
| `InferenceLockV1` | model/runtime 身份、实际配置、能力要求、资源、协议、profile、inference_id | PID、端口、secret、运行 ID、宿主绝对路径 |
| `InferenceServiceRecordV1` | service_id、inference_id、isolation_key、状态、epoch、owner、容器/进程身份、设备 allocation、租约、私有 endpoint 引用、时间/错误 | 明文 token |
| `InferenceExecutionEvidenceV1` | run_id、lock、服务 epoch、CPU/GPU/驱动/ISA、实际 dtype/kernel/内存池、协议 probe、请求指标、缓存条件及完整性 | 其他 run 的请求内容 |

runtime package 是判别联合：P0 `kind=oci` 记录平台特定 OCI image digest、镜像 manifest/SBOM；P1 `kind=python-env` 记录 Python 可分发包、wheel 全闭包、native library 摘要和环境构造清单。runtime_id 覆盖整个运行包，而不只是 SGLang 版本。

所有身份使用现有 canonical JSON / Sha256。model_id 覆盖推理必需的所有本地文件：safetensors shards、index、config、generation_config、tokenizer、special tokens 与选定 chat template。外部 tokenizer/template 必须一并导入 CAS。文件字节、模板或量化配置变化即新 model_id；alias、时间戳和下载镜像 URL 不参与内容身份。

### 6.2 Lock 类型草案

```ts
type SGLangBackendConfigV1 =
  | { backend: "cpu"; cpu_threads: number; numa_policy: "single-node";
      cpu_feature_requirement: "amx"; overlap_schedule: false }
  | { backend: "cuda"; device_constraint?: string;
      mem_fraction_static: number; overlap_schedule: boolean;
      cuda_graph: "enabled" | "disabled" }
  | { backend: "metal"; mlx_quantization: "none" | "prequantized";
      overlap_schedule: boolean }; // P1；P0 parser 接受类型但 admission 拒绝

interface InferenceLockV1 {
  schema_version: "1";
  engine: "sglang";
  model_id: Sha256;
  runtime_id: Sha256;
  inference_id: Sha256;
  profile: "evaluation-baseline-v1" | "evaluation-throughput-v1";
  execution: {
    platform: SGLangBackendConfigV1;
    load_format: "safetensors";
    dtype: string;                     // 已解析，不保留 auto
    quantization: string | null;       // 仅预量化 checkpoint 的认证方式
    tensor_parallel_size: 1;
    data_parallel_size: 1;
    pipeline_parallel_size: 1;
    context_tokens_per_request: number;
    max_running_requests: number;
    max_queued_requests: number;
    max_total_tokens: number;           // 经 prepare 验证的物理 token pool 预算
    chunked_prefill_size: number;       // 具体值，-1 表示禁用
    max_prefill_tokens: number;
    kv_cache_dtype: string;
    attention_backend: string;
    sampling_backend: string;
    deterministic_inference: boolean;
    prefix_cache: {
      mode: "disabled" | "radix";
      scope: "run" | "eval";
      initial_state: "empty";
    };
    hicache: false;
    speculative_decoding: false;
    cpu_offload_gb: 0;
    startup_timeout_ms: number;
    queue_timeout_ms: number;
    request_timeout_ms: number;
    idle_ttl_ms: number;
  };
  generation: {
    temperature: number;
    top_p: number;
    top_k: number;                     // Hitch 0=no top-k；后端负责精确映射
    min_p: number;
    repetition_penalty: number;
    seed: number;
    max_output_tokens: number;
    override_policy: "reject-conflicts";
  };
  protocol: {
    api: "responses" | "chat-completions";
    streaming: boolean;
    tool_calls: boolean;
    parallel_tool_calls: boolean;
    input_modalities: ["text"];
    tool_call_parser: string | null;
    reasoning_parser: string | null;
    compatibility_profile_id: Sha256;
  };
  resources: ResourceVectorV1;          // 包含引擎容器、CPU/RAM/shm预算
}
```

字段必须严格解析，拒绝未知参数和不可支持组合。backend 特有参数不可交叉传递；服务生效的完整参数写入证据。SGLang/PyTorch/MLX 版本变化不能自动沿用旧 profile。

默认值是 Hitch 的设计默认值，不是上游默认行为：

| 项目 | baseline | throughput |
| --- | --- | --- |
| context | 8192，受模型上限限制 | 8192，可 prepare 显式提高 |
| max_running_requests | 1 | CUDA 8；CPU 2，prepare 不满足则拒绝而非静默降低 |
| prefix cache | disabled | radix，仅认证 backend/profile 开放 |
| dtype / quantization | model config 展开到明确 dtype；不隐式量化 | 同左 |
| temperature/top_p/top_k/min_p/repetition_penalty/seed | 0/1/0/0/1/0 | 同左 |
| max_output_tokens | min(2048, floor(context/4))，允许请求使用更小上限 | 同左 |
| kernel/graph/overlap/chunked prefill | 按认证平台 profile 展开并锁定 | 按认证平台 profile 展开并锁定 |
| CPU threads | min(8, operator 允许的同一 NUMA 节点可用核数) | 同左；不足 1 核拒绝 |
| CUDA mem_fraction_static | 0.80 | 0.80；不是显存硬隔离保证 |
| queue/startup/request/idle TTL | 60s/600s/600s/60s | 同左 |
| engine max_queued_requests | max_running_requests，仅作第二道边界 | 同左 |

max_total_tokens 与 prefill/kernel 参数由 prepare 在资源预留后探测，写入具体数值；不以 P×context 简单推导可同时容纳的最大请求数。若固定 token pool 和最大上下文无法容纳至少一个有效请求，prepare 失败。

两个 profile 均不默认保证确定性。`deterministic_inference=true` 只有固定 backend、kernel 和模型组合通过测试才允许；不能把上游“确定性推理”选项泛化成跨 CPU/GPU 一致。[确定性推理文档](https://docs.sglang.io/docs/advanced_features/deterministic_inference)

`inference_id = H(model_id, runtime_id, profile, execution, generation, protocol, resources)`。实际设备 UUID、CPU affinity、驱动、容器资源上限单独记录为 hardware/deployment fingerprint；含设备约束的 lock 按其约束验证。

### 6.3 与 run/eval 的连接

- RunRequest/EvalRequest 新增可选 inference，包含提交时封存的 lock 及摘要；文件路径不是执行依赖。
- ModelIdentityV1 的 requested_id 保留 local/alias，effective_id=model_id，provider=local，parameters_sha256=H(采样策略)，新增可选 inference_id。
- identity_resolved=true 只能由 manager 验证得出，不能相信调用者的自我声明。上游 response.model 仅是 wire alias，不能覆盖已验证 model_id。
- inference.ref.json 关联 lock、model/runtime manifests 和 execution evidence，纳入 manifest/bundle，封存后不可修改。
- 本地 eval candidate_identity 包含 inference_id；retry/resume/rerun 使用原 lock。verifier-only rerun 不启动候选推理服务。
- 严格 Harness 比较要求模型、inference_id、hardware/deployment fingerprint 和缓存条件一致；模型维度比较允许模型不同，但必须匹配采样、服务配置、硬件与 warm/cold 实验条件。
- throughput profile 的共享缓存命中是观测值，不是可复现调度承诺。严格冷启动延迟比较应使用 baseline 或每个实验独立清空的服务，不能混入旧 eval cache。

### 6.4 存储布局

```text
<HITCH_ROOT>/
  store/model-files/sha256/<digest>/...
  store/models/sha256/<model-digest>/manifest.json
  store/inference-runtimes/sha256/<runtime-digest>/manifest.json
  store/inference-locks/sha256/<lock-digest>/lock.json
  indexes/models/aliases.json
  inference/services/<service-id>/{state.json,events.jsonl,engine.log}
  inference/private/<service-id>/...       # 0700/0600，凭证与私有配置
  cache/inference/<runtime-id>/<hardware-id>/... # JIT/编译缓存，不作为权重
  locks/inference/...
  runs/<run-id>/inference/{lock.json,model.manifest.json,runtime.manifest.json,execution.json}
```

P0 镜像层存放在 Docker image store，Hitch CAS 保存其不可变引用/manifest，不复制整份镜像。GC 只能删除 Hitch 拥有且未引用的对象，不执行全局 docker prune。普通 bundle 只含 manifests/digests，离线迁移必须另外携带 checkpoint 和 OCI image archive；不能凭 bundle 宣称空白机器可直接复现。

## 7. 引擎与模型制品准备

### 7.1 Runtime catalog

1. Hitch catalog 固定 SGLang release/commit、OCI image digest 或 Python environment manifest、平台/backend、Python/PyTorch/kernel/CUDA/MLX 版本、SBOM、构建 provenance 和兼容测试结果。
2. P0 setup 只拉精确 OCI digest；不把 latest/dev/tag 解析结果写入 lock。校验 registry manifest、平台和 catalog 后发布 runtime manifest。[安装文档](https://docs.sglang.io/docs/get-started/install)
3. Hitch 不安装驱动或 Docker Engine。doctor 验证版本、GPU container runtime、共享内存和 CPU ISA；没有 catalog 时失败，不在用户主机编译 kernel。
4. P1 Metal 使用 Hitch 私有 Python 环境和固定 wheel 闭包，不修改全局 Python；闭包无法核验则不发布支持。
5. 升级创建新 runtime_id，不覆盖旧 digest；保留 SGLang、镜像依赖和模型许可证。
6. run 阶段禁止 pip install、git clone 或下载 Harmony/tokenizer 等初始化依赖；prepare 前完成所有下载和 Responses 初始化 probe。

调研时上游 HEAD 是 `54cadad151e55c7cfef357da77061812eb893b96`，只作为 API 设计基线，尚非认证 runtime。M0 必须选择稳定版本，写入真实 image digest；main 不得进入 lock。

### 7.2 Checkpoint 导入

- P0 只接受目录，流式 hash 全部文件。要求 config、tokenizer/chat template、safetensors shards/index 完整且内部引用不越界。
- 拒绝 .bin/pickle、自定义 Python、remote code、绝对或越界软链接；需要 trust_remote_code 的模型标记 unsupported。
- 先复制或 CoW clone 到临时目录，再验证并原子发布；不 hardlink 可变源。中断、并发修改或磁盘不足不发布半成品。
- generation_config 中的 auto/dtype/量化参数在 prepare 展开；import 不等于 backend 兼容认证。
- 首次启动重验文件集和 digest。来源标记 verified/user-declared/unknown；文件 hash 不证明来源或许可证。
- P0 禁止远程 model path、对象存储和自定义 loader；run 不直接消费可变 Hugging Face cache。

## 8. CPU/GPU 选择与资源准入

### 8.1 Backend 规则

| backend | 强制语义 | 失败策略 |
| --- | --- | --- |
| cpu | 认证 CPU image、device=cpu、AMX/NUMA/profile 匹配、无 GPU allocation | ISA、内存或 NUMA 不满足即失败 |
| cuda | 认证 CUDA image；只暴露 manager 分配的单卡；TP/DP/PP=1 | 驱动、型号、显存或 kernel 不匹配即失败 |
| metal | P1 SGLANG_USE_MLX 路径 | P0 或无 catalog 时拒绝 |
| auto | 仅 prepare 解析成具体 backend | CPU fallback 需明确允许并兼容；执行 lock 无 fallback |

CUDA UUID/PCI ID 和容器 ordinal 显式映射；CPU 记录 NUMA/ISA/affinity。启动后以 server info、日志和 probe 核对 device/dtype/kernel/context/token pool。OOM 不得静默量化、缩 context、改 dtype/并发、切 CPU 或换引擎。P0 不开放 CPU offload；以后启用时必须形成新 profile/inference_id。

### 8.2 配额和共享

- 服务申请长驻 `ResourceAllocationV1.kind="inference"`；同一 eval 的 trial 共享服务，不重复计权重和 KV pool。
- trial 资源仍独立计算；引擎容器、RAM、CPU、GPU、共享内存和 writable cache 都进入服务预算。
- CUDA P0 按整卡独占的 Hitch lease，不超售 mem_fraction_static；该参数不代表完整显存硬隔离。
- CPU 使用真实 container limits、NUMA/线程 affinity；逻辑 quota 不能代替 OS 限制。
- 预算包含 weights、KV pool、CUDA graph/JIT、scratch、框架进程和安全余量；最终以预留后的加载和边界 probe 为准。
- 不同 Hitch root 使用 user-private 物理设备锁。归属无法确认时标 ambiguous，不杀未知进程；仍需检测非 Hitch 负载。

先确认“服务 + 至少一个 work item”理论可容纳，再启动服务，ready 后分配任务。不得先占满任务资源再等模型；活跃服务不可抢占。

### 8.3 并发、缓存和公平性

网关提供有界 FIFO、per-run 公平队列、queue timeout 和取消；SGLang max-running/max-queued 是第二道边界。工具执行期间不持有推理 permit。

baseline 禁用 Radix cache；throughput 开启 prefix cache。缓存规则：

1. `isolation_key=H(inference_id, cache_scope_owner)`；run 不跨 run，eval 只在同 eval/candidate/授权边界共享。
2. 不能以 prompt hash 作为授权；无法强命名空间隔离时，每个 isolation key 使用独立服务。
3. 新 epoch cache 为空；复用要求 isolation key 一致。清 cache 只由 supervisor 在无在途请求时执行。
4. warmup 单列证据，不混入候选 token/轨迹；cold/warm 指标分组，记录命中率和 eviction。
5. 是否允许 cache 进入 lock；命中结果不作为可复现调度保证。

max-running/max-queued/max-total-tokens、静态内存比例及 prefill/kernel 参数必须全部展开进 lock。[服务参数文档](https://docs.sglang.io/docs/advanced_features/server_arguments)

## 9. 生命周期与恢复

### 9.1 状态机

```text
absent → starting → ready → draining → stopped
             │        │         │
             └────────┴─────────┴──→ failed
```

`failed` 是当前 epoch 的终态。再次启动创建新 epoch；不能修改已封存运行的历史记录。权重下载/准备属于制品操作，不混入服务状态。

`acquire(inference_id, owner_id)`：

1. 验证提交 lock、runtime、model 与 Harness compatibility profile。
2. 获取服务级互斥锁，同一 inference_id + 设备绑定只启动一个服务实例；其他调用等待同一个 startup promise。
3. 获得长驻资源/设备 lease，写入 starting record 与 epoch。
4. P0 以固定 image digest、entrypoint/argv、只读 checkpoint mount、专用 internal network 和资源限额启动 OCI；P1 原生 Metal 以固定私有 Python 环境及 argv 启动。两者都不经 shell 拼接，并在私有目录创建随机 engine/admin token。
5. 检查 container/process 身份、health、模型 alias，再做短生成 probe；按调用方能力需要检查 Responses/SSE/tool-call。TCP 端口打开不等于 ready。
6. 写入有效设备/上下文等证据，转 ready；发放引用租约，注册 run-scoped 网关 binding。

临时端口由本机分配策略选择并校验服务归属。P0 只向宿主 `127.0.0.1` 发布容器 API 端口；如果运行时不能继承已绑定 FD，保留端口探测竞态处理，在 startup deadline 内遇占用换端口重试。不能向占用该端口的未知服务发送 prompt，也不能误杀它。

`release` 必须幂等；最后一个租约释放后开始 idle TTL（建议 60 秒），到期先 draining、拒绝新路由，再 terminate/wait/release。新的 acquire 与 drain 通过同一锁排序；已进入 draining 不复用旧 epoch。首版不提供无限常驻自动预热。

### 9.2 超时与异常

- 明确区分排队、引擎启动和 candidate 执行时间；新增 inference queue/startup budget，不能把冷启动偷偷混入模型 token latency。
- candidate deadline 开始后，网关排队、推理和工具时间均消耗 candidate budget。对每个请求使用剩余总 deadline 与 lock request timeout 的较小值。
- CPU prefill 可能较慢；不能以短时间“无 token”直接判断故障。SSE idle timeout 来自锁定 profile，并服从总 deadline。
- cancel/timeout 立即取消排队或断开下游及上游流，等待引擎释放该请求 slot。单 run 取消不得杀死仍为其他 run 服务的引擎；验证无法释放的实例进入故障处置，不伪造取消成功。
- 引擎退出/OOM：所有已转发请求明确失败，相关 eval 按基础设施错误处理，不能写 reward=0 代表模型能力差；关闭 binding，释放确认已退出的 container/process 资源。
- 网关不自动重放 POST，不在部分 SSE 输出后重试。允许重试整个 trial 的情况由现有 infrastructure retry policy 决定，新 physical run 使用相同 lock、新 interaction ID，并保留失败证据。
- 服务启动前尚未发出推理请求的绑定重建可在剩余 deadline 内执行；已向引擎提交但结果不明的请求不能以“未执行”处理。

### 9.3 Daemon 重启

服务状态、引用 owner 与 container/process start identity 必须持久化；现有内存 ResourceLedger 不能当作事实来源。

首版采用保守恢复：启动 daemon 时先扫描自己拥有的服务。P0 校验 container ID、image digest、Hitch ownership label、root/epoch；P1 校验 executable/package、PID start identity、root/epoch。对确认为遗留实例的服务停止并确认退出，再重建资源账本、轮换 token。旧在途请求记录 interrupted，不接续 SSE；由已有 run/eval 恢复规则决定失败或新 attempt。

无法确认归属的 PID/端口标为 ambiguous，隔离该设备并要求用户处理，不杀无关进程、不释放仍可能被占用的 lease。正常 daemon stop 默认 drain 所有服务；强制 stop 对受影响 run 先写终态证据。

## 10. 模型路由、协议与 Harness 接入

### 10.1 类型化 endpoint binding

向 `AdapterProcessRuntime` 增加仅运行期的 `model_endpoint`：

```ts
interface ModelEndpointBindingV1 {
  kind: "managed-local";
  inference_id: Sha256;
  api: "responses" | "chat-completions";
  base_url: string;
  wire_model: string;
  credential_env_name: string;
  capabilities: {
    streaming: boolean;
    tool_calls: boolean;
    parallel_tool_calls: boolean;
    input_modalities: ["text"];
  };
}
```

绑定由 manager 构造，不能由未经认证的 run JSON 自行提供 URL；secret 通过进程启动的私有环境或凭证文件注入，不放在上述对象、argv、请求记录或 manifest。

`wire_model` 使用由模型 digest 派生的稳定 alias，网关只接受该 binding 的 alias；readiness probe 必须核对 SGLang 实际加载的 checkpoint/service profile，不能仅凭请求中的 `model` 字段判定模型身份。

### 10.2 复用代理但不复用危险默认值

将现有 proxy 的 HTTP/SSE transport 与采集抽出，保留 `HostModelProxy` 作为旧 eval 场景兼容包装，新增 `LocalModelGateway`：

- 每个已登记 run 只绑定一个固定 engine endpoint、一个 inference_id、一个 service epoch。
- 只放行所需模型端点，例如 `/v1/responses` 或 `/v1/chat/completions` 及经认证必需的只读子集；不暴露 `/flush_cache`、`/abort_request`、profiler、模型更新、原生 `/generate`、router 或其他管理端点。
- 校验 run-scoped token 与登记的 run ID；未注册、已封存或已撤销 token 的请求拒绝。不能像当前路由解析一样仅检查 run ID 格式。
- 转发前移除调用者 Authorization、x-api-key、cookie 等认证头，注入 engine token；不把云模型凭证送到引擎。
- `upstream` 必须来自受验证的服务记录，无环境变量或云端默认值回退。引擎掉线、optional capture 降级也不能改变路由。
- 路由与 capture 分离：`off` 只是不保存模型 payload，不代表直连云端。最小 inference 身份和故障证据始终保存；完整评测默认要求 hybrid/proxy capture。
- 有界流式转发，保留 backpressure；处理上下游 abort/error/close，确保 permit 只释放一次。JSON/SSE 跨 chunk 解析不能假设一块数据就是一个事件。
- 对截断 capture、写盘失败和不完整 SSE 标记 partial/failed；要求完整 capture 的评测不可宣称证据完整。不能因 HTTP=200 就认定整个生成成功。
- 显式落实 lock 采样默认值；Harness 已提供同名采样字段时值必须相等，否则 `inference_parameter_conflict`。输出 token 上限是唯一例外：允许请求选择不超过 lock 的更小正整数，缺省取 lock 值，实际值逐请求保存。按协议映射 token 上限，拒绝不支持的参数，不能静默丢弃 reasoning/tool 参数。
- 对上下文检查使用固定引擎/tokenizer/template 的准确计数或已认证的服务端拒绝行为；输入加输出预算超过每请求容量时返回明确错误，不静默裁剪输入。字符长度估算只能作提示，不能作为正确性依据。

### 10.3 协议能力不是一个布尔值

SGLang 提供 OpenAI-compatible Chat Completions；目标 runtime 还必须在 M0 对 `/v1/responses` 做启动时能力探测，因为 endpoint 是否注册及其依赖可随固定版本/构建而异。这些只是集成入口，不是完整兼容证明。工具调用还依赖模型、chat template 与显式 parser；tool-call 输出只能由 Harness 执行。[OpenAI-compatible API 文档](https://docs.sglang.io/docs/basic_usage/openai_api)、[工具解析文档](https://docs.sglang.io/docs/advanced_features/tool_parser)

兼容注册表按 `(Harness artifact/version, runtime_id, model/template profile, protocol)` 记录测试结果；`endpoint_override=supported` 只证明可以改地址，不能跳过兼容检查。

| Harness | 首版计划 | 必须验证 |
| --- | --- | --- |
| `model-call` | P0 必须支持，沿用 Responses 文本路径 | completed/incomplete、空输出、usage、token 耗尽、取消、拒绝全部工具/图片 |
| Codex | P0 必须认证至少一个精确版本，不承诺任意 installed 版本 | Responses SSE 事件、call ID、工具返回、多轮 continuation、取消、上下文限制、无云认证依赖 |
| Pi / OpenCode / DeepSeek | P1 逐个增加独立 profile | provider 配置、协议和工具闭环；不能只改 requirements 为 true |
| Claude Code | 首版不支持 | Anthropic 协议及 Harness 运行假设需另行认证；上游存在 Messages 路由也不能直接放行 |

如果目标 SGLang/Codex 组合无法完成闭环，release gate 不通过；可以交付“单次调用预览”，但不能宣称完整 P0 完成。不得悄悄另接推理框架，或在 Hitch 内实现一个大型 Responses 模拟层。

### 10.4 两个 P0 Adapter 的具体变化

`model-call`：

- 保持可信 entrypoint hash 检查、单请求、no-tools、无重试；修改 runner 必须同时更新其制品可信检查测试。
- 本地模式读取 `HITCH_LOCAL_MODEL_TOKEN`，绑定 Responses endpoint；云模式保持现有 `OPENAI_API_KEY` 路径。
- 本地输入未设置 max_output_tokens 时，从私有 binding 配置使用 lock 上限，不沿用当前 runner 的 8192 默认；已指定值须不超过 lock 上限。
- 不把 `local/coder` 直接传作实际 wire model；prompt 仍使用当前 JSON 输入协议。
- Harbor HTTP 地址只接受 Hitch 签发 binding 中的准确 host/port/path；不能简单放宽为任意 HTTP URL，也不能只信任用户设置的一个布尔环境变量。bridge 用私有文件/认证 handoff 传递 binding。

Codex：为每次运行生成隔离 provider 配置，例如 `hitch_local`，传入 binding base_url、wire_model 和本地 credential env。当前官方配置支持 `base_url`、`env_key`，wire_api 为 `responses`；不使用已不在当前支持值中的 `chat`。关闭更新检查、遥测、云认证、远端搜索和请求/流重试，以保留评测证据。[OpenAI 官方配置参考](https://developers.openai.com/codex/config-reference/)

不修改用户全局配置或复用用户云端 auth；控制 provider 的 `agent_args` 与本地 binding 冲突时报错，不能让后出现的 argv 覆盖 endpoint。这里的当前文档只指导实现，历史 Harness 版本必须按对应制品测试。

首版采用无服务端会话依赖的完整历史请求，要求 `store=false`；不承诺 `previous_response_id`、服务端会话恢复或云端内置工具。认证 Codex profile 必须证明能以这一模式完成 continuation；否则该组合不支持。工具调用参数即使格式不合法，也不得由 Hitch 猜测、修复后偷偷执行。

## 11. Harbor、离线与安全边界

### 11.1 网络拓扑

P0 SGLang 容器加入专用 Docker internal network，不获得外网默认路由；API 端口只发布到宿主 `127.0.0.1`，容器内可监听 `0.0.0.0`。只有宿主 LocalModelGateway 访问该端口，Harbor 任务容器只访问网关。Linux 网关绑定显式 Docker bridge IP，并让 host-gateway 映射匹配该地址；P1 macOS 原生服务只绑定 loopback，并沿现有 `host.docker.internal` 路径向 Harbor 提供网关。不把容器内的 `127.0.0.1` 当作宿主机，也不向局域网公开引擎或代理。

每个实际任务网络执行容器内 reachability probe；Docker 自定义网络、rootless 或远端 Docker daemon 不可达时在 candidate 启动前失败，不能假设默认 bridge 永远适用。复用 `resolveModelProxyBinding` 但补齐真实网络配置验证。

候选运行嵌套启动容器内 Hitch 时，只传入封存 inference identity 和已签发 binding，设置内部 managed-execution handoff；容器内不调用 setup、不重新解析 lock、不启动 daemon/SGLang service。远端 worker 首版在 admission 明确返回 `local_inference_topology_unsupported`。

Verifier 模型调用是独立角色：首版不会自动重定向 grader/judge 凭证及模型。如果 benchmark verifier 需要云模型，报告中必须明确“candidate 本地，verifier 非本地/未知”；无云 verifier 凭证时提前失败。只有候选和 verifier 的网络依赖都满足时，才能声称该评测可完全离线运行。

### 11.2 数据与权限

- 新服务使用环境变量 allowlist；移除所有无关 `OPENAI_*`、`ANTHROPIC_*`、模型下载 token 和继承的 `SGLANG_*`、`HF_*`、`TRANSFORMERS_*`、`TORCH_*` 控制变量，再按 lock 写入必要值。
- 关闭或不暴露 SGLang 原生工具服务、远程媒体、动态/custom loader、model gateway/router、profiling 与管理 API，不继承用户配置。模型文件只是推理输入；所有真正的工具执行仍在原 Harness/Harbor 安全边界内。
- token 随机生成、按服务/run 最小授权并可撤销；token 文件 user-private，不在端口、URL query、错误文本或日志里出现。engine token 与 run token 分离。
- 运行期不启用引擎的远程模型下载。首版拒绝外部图片 URL 和文件访问参数；prepare 后断开外网仍可完成模型请求。
- 采集文件默认私有；本地推理不意味着 prompt 不敏感。日志关闭完整 prompt 输出，仍经过现有 credential redaction。
- OCI 镜像、私有 Python 环境与 checkpoint 全部是需要校验的第三方输入；固定摘要不能消除引擎或模型解析漏洞。以普通用户运行，容器尽量使用只读 rootfs、最小 capability 和 no-new-privileges；安全升级通过显式新 runtime_id 完成。
- CPU/GPU 权限锁、token 和 CAS 防止意外冲突及未授权网络调用，不构成同一 UID 恶意进程间的强安全隔离。

## 12. 观测、错误与证据

### 12.1 事件与指标

新增事件：`inference.queued`、`inference.starting`、`inference.ready`、`inference.acquired`、`inference.released`、`inference.draining`、`inference.stopped`、`inference.failed`。至少包含 service_id、inference_id、epoch、owner_id、timestamp；可归属 run/eval 时附其 ID。

每次执行保存：

- 模型/runtime/lock 摘要，实际 CPU/GPU 型号、驱动及 backend，实际 dtype/kernel、token pool、cache mode、CPU affinity/CUDA 显存、context 与并发请求数。
- 服务排队与冷启动耗时，是否复用已加载服务，warmup probe 的独立记录。
- 请求级 gateway queue_ms、请求总耗时、首输出事件时间、输入/输出 token（如果协议返回）。只有解析到文本 token 才标记为 TTFT，不能把 HTTP headers 或 SSE heartbeat 记为首 token。
- 服务级 RSS、GPU 显存或统一内存观测、并发、错误与退出原因；不将共享服务的全部资源用量重复记到每个 trial。
- generation 吞吐只在 token 数与计时区间可信时计算；缺失记 unavailable，不写 0。不把“API 成本为 0”解释为算力成本为 0。

baseline profile 关闭跨请求 Radix cache；throughput profile 可开启，但必须使用独立 lock 和前述 isolation key/服务隔离。两者都显式记录 warm/cold 条件；warmup 不属于候选回答，不混入候选 token 使用量或训练轨迹。

复用现有 `ModelInteractionV1` 记录请求/响应，新增指标放在独立 `InferenceExecutionEvidenceV1`，避免任意扩充所有旧交互字段。需新增字段的公共 record 必须同时更新 TypeScript、严格 parser 和 JSON Schema。

### 12.2 错误语义

| code | 类别 | 处理 |
| --- | --- | --- |
| `local_model_not_found` / `inference_lock_mismatch` | 输入/准备错误 | 执行前拒绝；提示 `models add`/`local prepare` |
| `local_model_integrity_failed` / `inference_runtime_integrity_failed` | 完整性错误 | 禁止加载；隔离制品，不回退其他版本 |
| `inference_runtime_unavailable` / `inference_device_unsupported` | 能力错误 | 提示正确 backend/平台制品 |
| `inference_harness_unsupported` / `inference_protocol_unsupported` | 兼容错误 | 提示认证 profile，不盲试 |
| `inference_parameter_conflict` / `inference_modality_unsupported` | 请求错误 | 执行前或该请求转发前拒绝 |
| `inference_capacity_exceeded` | 永久准入不满足 | 不进入无限等待队列 |
| `inference_queue_timeout` / `inference_start_timeout` | 调度/启动错误 | 留下阶段证据；符合策略才做基础设施重试 |
| `inference_oom` / `inference_process_exited` | 基础设施错误 | 失效受影响请求；停止并回收确认归属的进程 |
| `inference_context_exceeded` | 输入/上下文错误 | 不自动截断历史；candidate outcome 标记原因 |
| `inference_binding_revoked` / `inference_route_unavailable` | 路由错误 | fail closed，不访问云端 |
| `inference_capture_incomplete` | 证据错误 | required capture 场景不可标为完整有效 |
| `local_inference_topology_unsupported` | 部署错误 | admission 拒绝远端或不支持网络拓扑 |
| `inference_recovery_ambiguous` / `inference_in_use` | 生命周期冲突 | 不误杀、不强制回收；需要显式操作 |

错误映射使用现有 `HitchError` / CLI exit-code 约定；输入类退出码 2，基础设施类沿用现有约定。实现时在一个集中映射表注册，测试 JSON 与人类输出一致，不为每个错误任意分配退出码。

## 13. 具体代码改动清单

按以下职责拆分，遵守单实现文件最多 500 行、跨模块仅经 `index.ts` 的现有规则。

| 模块/文件 | 改动 |
| --- | --- |
| `src/domain/inference.ts`（新） | manifest/lock/evidence、endpoint binding、manager/admission 接口 |
| `src/domain/runs.ts`、`evals.ts`、`resources.ts`、`execution-plan.ts` | inference 可选引用、allocation kind、候选身份字段 |
| `src/inference/model-store.ts`、`model-manifest.ts`（新） | checkpoint 导入、全文件摘要、不可变发布、alias、pin/GC |
| `src/inference/runtime-catalog.ts`、`runtime-store.ts`（新） | 认证版本清单、下载/解包/校验、runtime CAS |
| `src/inference/devices.ts`、`lock.ts`（新） | CPU/GPU doctor、参数展开、prepare lock |
| `src/inference/sglang.ts`、`probe.ts`（新） | 唯一引擎适配器：参数编译、设备/health/protocol probe、观测解析 |
| `src/inference/supervisor.ts`、`records.ts`、`recovery.ts`（新） | 启停、进程身份、epoch、持久化与恢复 |
| `src/control-plane/inference-manager.ts`、`inference-admission.ts`（新） | 单所有者调度、租约、设备锁、idle TTL、ResourceLedger 协调 |
| `src/model-access/transport.ts`、`local-gateway.ts`（新） | 复用代理传输、run binding、限流/取消、固定上游 |
| `src/model-access/proxy.ts`、`capture.ts`、`policy.ts` | 保留旧行为；本地 routing/capture 解耦，处理 partial/abort |
| `src/adapters/contract.ts`、对应 providers、`integrations/model-call/cli.js` | 类型化连接、Codex 私有 provider 配置、model-call 凭证与 endpoint 校验 |
| `src/runs/request.ts`、`executor.ts`、`identity.ts`、`manifest.ts`、`records.ts`、`bundle.ts`、`compare.ts` | 锁定输入、生命周期接入、稳定模型身份、证据封存/比较 |
| `src/evals/request.ts`、`execution-plan.ts`、`model-capture-runtime.ts`、相关 rerun/recovery | 固定 candidate identity、服务共享、网络探测、重试继承 lock |
| `src/control-plane/eval-records.ts`、scheduler/admission 与 daemon scheduler | 提交时冻结 lock、资源顺序、恢复及兼容拒绝 |
| `src/backends/harbor/model-proxy-config.ts`、`integrations/harbor/hitch_harbor_agent.py` | 增加 managed-local handoff，候选/验证器角色分离 |
| `src/daemon/server.ts`、client | 现有 daemon 认证下的服务 list/stop API；普通 run/eval 自动 prepare |
| `src/cli/commands/local.ts`、`models.ts`（新）、run/eval/main/output | 简化 CLI、首次使用 preflight、参数冲突、daemon 提交与等待 |
| `src/foundation/config.ts` | CAS/服务/锁/private 路径 |
| `scripts/check-architecture.ts`、`package.json`、`src/*/index.ts` | 注册 inference 模块、允许依赖、公开 facade/export、随包发布 runtime catalog |
| `docs/schemas/` | 新增 model/runtime manifest、lock、service、execution/ref Schema；更新受影响 request/plan/manifest 等 Schema |
| README、design、evals、daemon 文档 | 支持矩阵、离线边界、安装/迁移/故障指南 |

preview 管理 API 挂在已有 daemon 认证下，当前提供 `GET /v1/inference/services` 与 `POST /v1/inference/services/:id/stop`；普通 run/eval 通过内部 acquire 自动 prepare。独立的异步 prepare operation API、单服务详情 API 和 operation 取消接口留在后续管理面迭代，不影响 happy path。推理数据面不复用 daemon 管理 token，普通 acquire/release 也不向任意 HTTP 用户提供 GPU 服务出租能力。

## 14. 版本兼容与迁移

- 保留 schema_version=1 的旧记录读取；新增可选字段仅在本地推理记录出现，不改写历史 bundle。
- 写入新字段前必须同步严格 parser 的 allowed fields，以及所有 request/plan/phase-group/bundle/training-candidate 投影；不能只改 TypeScript 类型。如字段语义无法兼容，新增有版本 record，而不是让老字段换含义。
- 新 CLI 与旧 daemon 通过 capabilities 握手；daemon 不支持 local inference 时明确 `daemon_upgrade_required`，不能把字段删除后继续云运行。
- daemon 到内部 worker/Harbor 的 handoff 增加版本/能力门禁；首版旧 worker 和远端 worker 拒绝本地推理任务。
- 非 local 的 model 字符串、现有环境变量、云代理行为与旧 run/eval 路径保持原样；不将全局 `OPENAI_BASE_URL` 改为本地地址。
- 本地 lock 新增字段/改变默认值意味着新的 inference_id；回滚运行时仅影响后续新服务，不修改在途服务或旧证据。

## 15. 测试与验收

### 15.1 单元与故障注入：不依赖 GPU

使用可控 fake SGLang server（独立子进程 + HTTP/SSE）验证：

1. safetensors/index/config/tokenizer/全文件摘要、导入中断、源文件并发修改、损坏归档、路径穿越、缺少动态库、磁盘不足。
2. lock hash 稳定：alias/本地路径不影响内容身份，backend/template/量化/采样/线程/context/parallel 改变则产生新身份。
3. CPU profile 不分配 GPU；CUDA profile 必须探测到锁定 GPU、backend/kernel 与模型驻留，不允许静默 CPU offload；auto 仅 prepare 可用，fallback 必须授权并写入新 lock。
4. 20 个并发 acquire 相同 lock 只 spawn 一次；不同 lock 不误复用；release/abort/timeout 双重触发不重复释放；TTL 与 acquire 竞态无遗留进程。
5. 设备绑定与 ordinal 重映射、跨 root 锁冲突、常驻服务与 trial 资源不重复记账；无容量可容纳时不死锁。
6. startup hang、process exit、OOM、PID 重用、daemon SIGKILL、重启 token 失效、占用端口、无法确认进程归属。
7. SSE 多字节字符跨 chunk、多个事件同 chunk、partial event、200 后 error、客户端断流、背压、超大 payload、capture 截断及磁盘写失败。
8. 非法 run ID/token、已封存 run、model alias 不匹配、私有管理端点、任意上游 URL、重定向、云 API key 外泄、用户 agent_args 覆盖 endpoint。
9. 不支持的 Harness/模态/参数提前拒绝；本地路由在 capture=off 或采集失败时依旧不会回退云端。
10. 旧 run/eval Schema、旧云模型代理、轨迹、bundle、compare、rerun 的回归测试。
11. CLI happy path 只需 `models add` + `run/eval --model local/...`；不产生用户侧 lock 文件。首次准备事件、`--offline` 失败提示、`--inference` 高级固定和冲突检查均有 snapshot/contract test。

### 15.2 协议与 Harness contract tests

- Responses：非流式、完整流式事件、usage、空文本、incomplete/token budget、工具调用 ID/arguments/tool-result、多轮请求、取消。
- Chat Completions：文本/SSE 与 function-call fixture，作为引擎能力验收；不据此自动开放任意 Harness。
- Codex：固定 Harness artifact 对固定模型/template 执行两轮以上工具调用，读取/修改一个测试文件并检查实际文件结果；不能只断言最终回答包含“成功”。
- model-call：准确一次 HTTP 请求，任何工具/action item 拒绝；坏响应是基础设施错误，合法空回答仍按现有语义处理。
- 所有实际发出的采样/能力参数与 lock 一致；provider 默认参数不参与隐式决策。

### 15.3 必须通过的真实硬件矩阵

| 环境 | 最小验收 |
| --- | --- |
| Linux x64 Intel Xeon AMX CPU | P0 固定 safetensors checkpoint 完成 run；实际 backend/kernel 为 CPU、无 GPU 分配；prepare 后断外网仍成功 |
| Linux x64 NVIDIA CUDA | 同一 checkpoint、单卡服务和并发 1/8 分别测试；记录实际 GPU ID/kernel/memory pool；显存不足无自动降级 |
| Linux Harbor local-docker | P0 容器经网关访问宿主模型，至少两个 trial 复用服务；一个取消不影响另一个 |
| macOS arm64 Metal/MLX | P1 gate：同一 checkpoint 请求及认证 Codex 工具闭环成功；记录实际 MLX/Metal backend；native process 不依赖 Docker GPU |

至少选择一个有明确许可证的小模型作为 CPU/传输测试 fixture，另选一个通过工具调用认证的模型作为 Agent fixture，固定 checkpoint manifest digest。二者可以不同；传输 fixture 成功不代表 Agent 质量达标。模型具体名单在 M0 硬件验收后进入 catalog，而不是凭模型名称先承诺。

资源不足/OOM 用真实紧约束 canary 加 fake 故障注入双重覆盖，避免破坏用户桌面。CUDA 验收不能由 mock 或“机器无 GPU 已跳过”替代。

### 15.4 性能与完成标准

- 对同一机器、同一引擎、同一 checkpoint、同一请求/参数/并发、同等采集条件，比较直连与 Hitch 网关，分别报告 cold start、TTFT、总时长、tokens/s 和资源峰值。
- 初始性能目标：在固定认证测试配置中，预热后请求端到端延迟 p50/p95 相比直连增加不超过 `max(20ms, 5% × 对应直连延迟)`；这是待测目标，不是当前性能承诺。
- 并发总数不超过配置，权重每个共享服务只加载一次；取消后在 5 秒目标窗口内释放该请求 slot；最后租约释放且 TTL 到期后 10 秒内完成正常服务停止，超时进入可见故障处置。
- 完成一次 P0 CPU、CUDA 普通 run 及一组 Linux local-docker 评测，核验 model/runtime/lock/evidence/bundle 全链路；没有外部模型请求、没有云凭证残留。Metal 只在对应 P1 gate 通过后加入完成标准。
- `npm run check` 通过；新增 `test/inference-*.test.ts`、`test/local-model-gateway.test.ts` 与硬件 canary，并保存真实硬件日志及测试制品摘要。
- 未通过完整 Harness 工具闭环或真实 GPU canary，不得把 P0 标记为完成。

## 16. 实施里程碑

| 阶段 | 可独立交付的结果 | 完成门槛 |
| --- | --- | --- |
| M0：兼容性 spike | 固定 SGLang release/commit 与 image digest；CPU/CUDA 制品策略与 Metal P1 风险；模型与 Codex profile；Responses/SSE/tool-call 实测 | 两个 P0 后端可加载；至少一个 Harness 工具闭环；明确模型/license/ABI；记录 Metal P1 缺口；无可用组合则先修订 spec |
| M1：模型与运行时制品 | runtime setup、model import/inspect、doctor、lock prepare/parser、CAS 与完整性测试 | 认证 Xeon CPU 环境使用固定镜像完成 prepare；不修改宿主 Python；损坏/中断不发布制品 |
| M2：托管服务与直连运行 | manager、资源/设备租约、生命周期、local gateway、model-call/Codex binding、run evidence | P0 CPU+CUDA run、复用/取消/恢复通过；云模式回归通过 |
| M3：Harbor 与证据闭环 | eval admission/plan、容器 handoff、身份/重试/compare/bundle、候选与 verifier 边界 | 本机 Harbor 多 trial、OOM/取消、rerun、一致身份全部验收 |
| M4：发布加固 | runtime catalog、支持矩阵、打包、迁移/安全文档、性能基线 | 所有 P0 release gates、`npm run check`、CPU/CUDA 与 Harbor canary 完整 |

M0 → M1 → M2 → M3 → M4 构成完整首版；不能把安装一个 SGLang server 并设置 `OPENAI_BASE_URL` 视为完成。本 spec 不绑定未经验证的工期，估算应在 M0 明确协议与平台打包成本后进行。

后续 P1 可沿 `InferenceBackend` 契约加入更多 SGLang 硬件后端、Harness、多模态与远端 worker 本机服务；若增加 vLLM 等第二框架，应单独立项，不影响已锁定的 SGLang 运行身份。

## 17. 关键决策记录

1. **集成方式：独立服务（P0 OCI、P1 受管进程）+ HTTP。** 隔离引擎崩溃和原生依赖，避免 Node ABI/FFI 绑定；Hitch 继续保持轻量控制面。
2. **CPU/GPU 是同一框架的不同后端。** 模型服务管理、协议、证据不分叉，实际 backend 进入执行身份。
3. **服务由 daemon 持有。** 复用现有调度与资源账本，避免多个 direct run 各自占满设备；只改变显式本地推理路径。
4. **请求路由必须强绑定。** 不依赖全局环境变量，不因可选采集失败而换模型，更不回退云端。
5. **先锁定再执行。** alias、自动设备选择和参数默认值只在 prepare/提交边界解析；run/eval/retry 不改变既定条件。
6. **支持声明以组合验收为准。** API 同名、模型可加载和工具调用可用是三个不同结论；官方文档用于选接口，实测决定支持矩阵。
