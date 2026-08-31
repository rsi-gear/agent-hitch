# Hitch Harbor 兼容实验控制面设计规范

- 状态：Draft v0.1
- 目标版本：`0.3.x`
- 更新日期：2026-09-01
- Hitch 基线：`0.2.5@4aa6da8`
- Harbor 基线：`0.21.0`
- 适用范围：Harbor-backed eval、Docker 并发、环境镜像构建、执行节点、模型交互采集与结果封装
- 变更类型：新增控制面与执行抽象；保持 Harbor 任务、环境和 Verifier 语义兼容
- 实现证据追踪：`hitch-harbor-control-plane-implementation-status.md`

## 1. 摘要

Hitch 当前已经是 Agent Harness 的不可变版本、内容寻址制品和运行证据层，但 Harbor eval 的执行仍然是单机、同步、以 Harbor 进程为中心的编排：单次 eval 将 `max_concurrent` 直接传给 Harbor，多次 attempt 在 Hitch 外层串行运行，环境类型固定为 Docker，多个 eval 之间没有统一的 CPU、内存、构建和容器预算。

本规范借鉴参考图中 Aforge 的 companion service 思路：保留 Harbor 输入语义，在中间补齐 service/control plane，并把轨迹、交互、验证结果和来源血缘一起输出；不照搬其具体组件实现。

本规范将 Hitch 扩展为一层 **Harbor 兼容实验控制面**：输入继续使用 Harbor 的任务、环境和 Verifier 语义；Hitch 在中间统一负责构建、缓存、资源调度、Agent 适配、执行节点、凭据和可选模型交互采集；输出继续发布到 Hitch 权威的 sealed run，并增加一份完整性可验证的 Result Bundle 索引。

目标链路如下：

```text
Hitch CLI / HTTP API
  -> Eval admission and planning
  -> Global resource scheduler
       -> Image resolver / BuildKit cache
       -> Agent adapter / shared controller runtime
       -> Execution provider / worker lease
            -> Harbor backend
                 -> task sandbox
                 -> Candidate Agent
                 -> Verifier
       -> optional model proxy and interaction capture
  -> atomic run publication
  -> sealed Result Bundle
  -> optional training-data candidate derivation
```

Hitch 不替代 Harbor，也不复制 Harbor benchmark 领域模型。职责边界是：

> Harbor 决定“测什么、环境是什么、怎样验证”；Hitch 决定“用哪个不可变 Agent 版本、在哪里执行、怎样并发、如何恢复、如何留证”。

## 2. 背景与现状

### 2.1 当前实现事实

| 能力 | 当前实现 | 影响 |
| --- | --- | --- |
| daemon API | `src/daemon/server.ts` 仅提供 `/v1/runs` | eval 无法排队、查询、取消和跨请求统一治理 |
| daemon 调度 | `src/daemon/scheduler.ts` 使用单个 FIFO 队列和整数 `maxConcurrent` | 不感知 CPU、内存、构建、容器和不同工作负载成本 |
| eval 编排 | `src/evals/service.ts` 直接调用 `runHarborBackend()` | CLI 生命周期与 Harbor 子进程绑定，daemon 重启恢复能力缺失 |
| attempt 并发 | 多个 logical attempt 由外层 `for` 串行执行 | 避免了部分 Harbor 冲突，但无法利用不同任务之间的并行度 |
| Harbor 并发 | `request.max_concurrent` 直接映射为 `n_concurrent_trials` | 只限制单个 Harbor job，不限制多个 eval 的全局容器总量 |
| 执行环境 | `environment: { type: "docker", delete: true }` 固定写入 JobConfig | 无法路由到远程 worker 或其他沙箱实现 |
| Harness 构建 | 已有内容寻址 artifact、目标平台缓存和文件锁 | Agent 本体重复构建问题已基本受控 |
| 环境镜像构建 | 主要由 Harbor、Compose 和本机 Docker 临时处理 | 并发 build storm、同名镜像竞争和缓存复用缺少统一治理 |
| Agent 适配 | 已有 registry、capabilities、process/translate 契约 | 可以演进为控制面可查询的能力目录 |
| 轨迹和结果 | 已有 provider-native evidence、canonical trajectory、Verifier evidence、observation 和 sealed run | 已具备 Result Bundle 的主体，只缺少环境、执行节点、资源和模型交互血缘 |

### 2.2 需要解决的问题

本规范优先解决以下问题：

1. 多个 eval 同时运行时，每个 Harbor 进程独立认为自己可以占满 `max_concurrent`，造成 Docker CPU、内存和磁盘争用。
2. 同一个任务的多个 attempt 可能因固定容器名、端口、Compose project 或工作目录发生冲突。
3. 多个 trial 同时构建相同环境镜像或 sidecar 时，可能触发构建锁竞争、重复构建或上游并发缺陷。
4. CLI 或 daemon 中断后，控制面无法可靠区分 queued、running、lost、已完成但尚未导入等状态。
5. 已停止容器、网络、临时目录和构建缓存缺乏基于所有权与 lease 的回收规则。
6. 结果中缺少完整的环境镜像、执行节点、资源使用和模型访问证据，难以形成可审计的数据闭环。

### 2.3 设计前提

- Harbor `0.21.0` 仍是首个受支持 backend。
- 首个 Execution Provider 仍是本机 Docker。
- Harbor 仍可负责创建和销毁具体 task environment；Hitch 第一阶段不 fork Harbor。
- Hitch 已有的 artifact、controller runtime、trajectory、trial import 和 sealed run 机制必须复用。
- 对于无法在运行前枚举任务的 dataset，控制面必须支持保守的 opaque plan，不得伪造任务成员关系。

## 3. 目标与非目标

### 3.1 目标

1. 为 eval 提供异步提交、状态查询、事件读取、取消和恢复 API。
2. 在同一个 Hitch root 下统一治理所有 daemon-managed run、eval、build 和 sandbox 的资源占用。
3. 将 `max_concurrent` 定义为单个 eval 的并行上限，而不是资源许可。
4. 按 CPU、内存、容器数和构建槽位进行原子资源预留。
5. 在已知任务成员关系时，将调度单位细化到逻辑 trial slot。
6. 在 Harbor 安全约束下并行不同任务，并默认在同一 collision domain 内串行同一任务的多个 attempt。
7. 对环境镜像执行不可变解析、构建去重、完整性验证和可选远程缓存。
8. 定义本机 Docker、远程 worker 和未来云沙箱共享的 Execution Provider 契约。
9. 将 Agent 公共运行时能力从 provider-specific adapter 中分离。
10. 提供可选的模型代理与请求/响应采集，并与原生轨迹关联。
11. 将轨迹、Verifier、环境、资源和来源血缘统一索引为可验证 Result Bundle。
12. 保持现有 CLI、磁盘记录和 schema 的读取兼容性，允许渐进启用控制面。

### 3.2 非目标

本规范不包含：

- 重写 Harbor 的 task、dataset、environment 或 Verifier 领域模型；
- 将 Harbor 内部实现复制到 Hitch；
- 修改 benchmark reward 语义或 promotion policy；
- 默认复用一个可写 sandbox 执行多个 trial；
- 保证任意 Agent 都能通过模型代理；
- TLS 中间人代理或捕获无法显式配置 endpoint 的私有协议；
- 把所有成功 Result Bundle 自动视为可训练数据；
- 在 V1 实现 Kubernetes 调度器或特定云厂商完整集成；
- 将 Docker 容器视为强多租户安全边界；
- 自动删除不带 Hitch 所有权标签的外部 Docker 资源。

## 4. 术语、权威边界与不变量

### 4.1 术语

| 术语 | 定义 |
| --- | --- |
| Eval | 一次候选 Harness 对一个不可变 benchmark revision 的评测 |
| Trial Slot | `(eval, task, logical attempt, candidate)` 组成的逻辑评测位置 |
| Physical Execution | 为完成一个 Trial Slot 实际启动的一次 Harbor trial；基础设施重试可能产生多个 physical execution |
| Backend Work Item | 控制面交给 backend 的最小可调度工作；可包含一个或多个 Trial Slot |
| Resource Reservation | work item 启动前在某个 worker 上原子预留的资源向量 |
| Lease | 控制面授予 worker 执行 work item 的有期限所有权记录 |
| Environment Image | benchmark task environment 使用的不可变 OCI 镜像 |
| Shared Runtime | Hitch controller runtime、代理配置、凭据注入、事件和取消协议等公共运行时 |
| Result Bundle | 一个 sealed run 的全部证据文件及其校验和索引 |
| Training-data Candidate | 从 Result Bundle 派生、通过额外质量与合规门禁的数据候选 |

### 4.2 权威边界

| 对象 | 权威方 |
| --- | --- |
| task 内容、环境定义、Verifier 和 reward | Harbor dataset / benchmark revision |
| Harness ref 解析、revision、artifact 和 controller runtime identity | Hitch |
| admission、队列、公平性、资源预算和 lease | Hitch control plane |
| worker 实际能力和运行时资源观测 | Execution Provider / worker |
| Agent 原生消息、工具调用和 session | Agent provider-native evidence |
| 模型 HTTP 交互 | 可选 Hitch model proxy；不替代 Agent 原生轨迹 |
| Verifier result | Harbor Verifier |
| sealed run 与 Result Bundle 发布 | Hitch |
| 数据是否可用于训练 | 独立的数据策略或上层服务，不由 eval 成功状态决定 |

### 4.3 必须保持的不变量

1. 一个 Trial Slot 最多只有一个被发布为权威结果的 `run_id`。
2. 同一时刻，一个 Backend Work Item 最多有一个有效 lease。
3. `max_concurrent` 只能缩小全局调度器允许的并发，不能突破 worker 资源预算。
4. Verifier 基础设施重试必须在原 sandbox 内执行，不得再次调用 Candidate Agent。
5. Candidate Agent 是否重新执行必须由显式 retry policy 决定，不能由 Harbor 或导入失败隐式触发。
6. Result Bundle 必须在所有引用文件写入并验证后一次性封存；sealed bundle 不得原地修改。
7. credentials 的值不得写入 request、plan、events、logs、image manifest、lease 或 bundle。
8. 所有删除和回收操作必须验证 Hitch root、provider、lease 和资源标签所有权。
9. daemon 重启后不得把未知状态的 physical execution 当成从未启动。
10. 旧版 run/eval 记录无需迁移即可继续读取和比较。

## 5. 目标架构

### 5.1 分层

```text
Interface layer
  CLI, daemon HTTP API
        |
Control plane
  admission, planner, scheduler, leases, recovery, cancellation
        |
  +-----+----------------+------------------+
  |                      |                  |
Build and image       Execution          Model access
resolution/cache      providers          and capture
  |                      |                  |
  +-----------> Harbor backend <------------+
                         |
                 Agent Adapter layer
                 + Shared Runtime
                         |
                 Disposable sandbox
                 agent + verifier + artifacts
                         |
                 Sealed Result Bundle
```

### 5.2 控制流

1. API 校验提交请求并持久化 immutable request。
2. Planner 解析 benchmark、Harness、controller runtime、task membership 和资源需求。
3. Scheduler 根据 eval 公平性、per-eval cap、worker capabilities 和资源预算选择 work item。
4. Build Service 解析或构建所需环境镜像，并返回不可变 digest。
5. Scheduler 创建 lease；Execution Provider 接受后启动 backend work item。
6. Harbor Backend 使用受限并发、显式任务子集和预留资源运行 trial。
7. Shared Runtime 启动选定 Agent，采集 native evidence；如果启用 model proxy，则关联模型交互。
8. Harbor 在原 trial 环境内运行 Verifier。
9. worker 导出 staging bundle；Hitch 校验、原子发布 run、更新 progress。
10. 所有 slot settled 后生成 eval result；Result Bundle 可被进一步派生为 Training-data Candidate。

### 5.3 数据流与控制流分离

- 控制面只传递 identity、manifest、相对引用、资源需求和状态，不内嵌大体积轨迹或镜像层。
- 大体积 artifact、image、trajectory 和 interaction capture 通过内容寻址 store、OCI registry 或 worker artifact transport 传输。
- worker 事件可以重复投递；控制面按 `(lease_id, sequence)` 去重。
- 结果发布仍以 Hitch `runs/<run-id>/` 为唯一权威位置，worker staging 不是第二份权威副本。

## 6. 模块边界

### 6.1 新增与调整的模块

```text
src/
  domain/
    resources.ts
    control-plane.ts
    images.ts
    interactions.ts

  images/
    contract.ts
    resolver.ts
    buildkit.ts
    store.ts
    integrity.ts
    gc.ts
    index.ts

  execution/
    contract.ts
    catalog.ts
    leases.ts
    workers.ts
    local-docker.ts
    remote-worker.ts
    recovery.ts
    index.ts

  model-access/
    contract.ts
    proxy.ts
    capture.ts
    policy.ts
    index.ts

  control-plane/
    admission.ts
    planner.ts
    scheduler.ts
    resources.ts
    service.ts
    state.ts
    recovery.ts
    cancellation.ts
    index.ts

  evals/
    planner.ts
    finalizer.ts
    service.ts                 # 保留 direct mode；逐步变薄

  backends/harbor/
    planner.ts
    runner.ts
    image-overlay.ts
    backend.ts                 # 兼容 facade

  daemon/
    server.ts
    client.ts
    scheduler.ts               # 迁移后仅保留兼容导出或删除
```

### 6.2 依赖方向

目标依赖图为：

```text
domain
  <- foundation
  <- adapters / images / execution / model-access / backends
  <- revisions / artifacts / controller-runtime / trajectories / runs / evals
  <- control-plane
  <- daemon / cli
```

具体约束：

- `domain/` 不得依赖 Node.js API。
- `images/` 不得依赖 `evals/`、`control-plane/`、`daemon/` 或 CLI。
- `execution/` 只依赖纯契约和底层机制，不导入 `EvalService`。
- `backends/` 接受显式计划、identity 和路径，不读取 daemon 内部状态。
- `control-plane/` 是业务编排所有者，可以调用 eval planner、backend、image 和 execution facade。
- `daemon/` 只负责认证、HTTP、进程生命周期和调用 control-plane facade。
- 必须同步更新 `scripts/check-architecture.ts`，对新增模块执行依赖方向和 cycle 检查。

目标 `ALLOWED` 关系如下；迁移期兼容边必须有删除阶段，不得永久放宽为任意依赖：

| 模块 | 允许直接依赖 |
| --- | --- |
| `domain` | 无 |
| `foundation` | `domain` |
| `adapters` | `domain`, `foundation` |
| `revisions` | `domain`, `foundation`, `adapters` |
| `artifacts` | `domain`, `foundation`, `adapters`, `revisions` |
| `controller-runtime` | `domain`, `foundation` |
| `images` | `domain`, `foundation` |
| `execution` | `domain`, `foundation` |
| `model-access` | `domain`, `foundation` |
| `trajectories` | `domain`, `foundation`, `adapters` |
| `workspaces` | `domain`, `foundation` |
| `runs` | `domain`, `foundation`, `adapters`, `revisions`, `artifacts`, `workspaces`, `trajectories`, `model-access` |
| `backends` | `domain`, `foundation` |
| `evals` | `domain`, `foundation`, `backends`, `runs`, `artifacts`, `revisions`, `controller-runtime`, `workspaces`, `trajectories` |
| `control-plane` | 除 `daemon`、`cli` 外的上述业务 facade |
| `daemon` | `domain`, `foundation`, `control-plane` |
| `cli` | 所有公开 facade |

## 7. 状态目录与权威记录

### 7.1 根目录扩展

```text
<hitch-root>/
  evals/
    eval_<id>/
      request.json
      submission.json
      resolution.json
      plan.json
      execution-plan.json
      control.json
      events.jsonl
      progress.json
      result.json
      leases/
        lease_<id>.ref.json
      harbor/
        work-<id>/

  workers/
    worker_<id>.json

  leases/
    active/
      lease_<id>.json
    terminal/
      lease_<id>.json

  store/
    environment-images/
      sha256/<64-hex>/manifest.json
    build-records/
      sha256/<64-hex>/record.json

  locks/
    builds/<64-hex>.lock
    trial-slots/<64-hex>.lock

  runs/
    run_<id>/
      ...existing files...
      bundle.index.json
      execution.json
      runtime.ref.json
      environment/
        image.manifest.json
      interactions/
        interaction.ref.json
        interactions.jsonl
```

### 7.2 文件权威性

| 文件 | 可变性 | 含义 |
| --- | --- | --- |
| `request.json` | immutable | 现有 EvalRequest，保持兼容 |
| `submission.json` | immutable | API envelope、执行策略和 idempotency identity |
| `plan.json` | immutable | 现有候选、benchmark、artifact、runtime 计划 |
| `execution-plan.json` | immutable | task slots、work items、资源与 provider 选择 |
| `control.json` | generation-based mutable | eval 调度状态、取消意图、当前 lease 摘要 |
| `events.jsonl` | append-only | 控制面生命周期事件 |
| `progress.json` | atomic mutable | 已发布 trial 集合；保持现有语义 |
| `result.json` | immutable terminal | eval 终态和聚合结果 |
| `bundle.index.json` | immutable | sealed run 内所有证据引用和校验和 |

`control.json` 不能代替 `progress.json` 或 `result.json`。前者描述执行控制状态，后两者描述已发布的评测事实。

`environment/image.manifest.json` 是所用小型 EnvironmentImageManifest 的完整副本，不是指向可变 Docker tag 的路径；发布前必须确认其 `image_id` 与全局 store 一致。`runtime.ref.json` 只固定 controller runtime identity、manifest digest 和相对语义，不复制完整 runtime payload。`execution.json` 保存 provider、worker、lease、reservation 和有界 observed resource summary。

## 8. 领域记录与 Schema

以下类型用于定义协议，最终实现必须在 `docs/schemas/` 提供对应 JSON Schema，并通过严格 validator。

### 8.1 Eval submission

```ts
interface EvalSubmissionV1 {
  schema_version: '1'
  request: EvalRequest
  execution?: EvalExecutionPolicyV1
  idempotency_key?: string
  submitted_at: string
}

interface EvalExecutionPolicyV1 {
  provider: string // Execution Provider catalog id，例如 local-docker
  max_parallelism: number
  resources: {
    default_trial: ResourceVectorV1
    setup?: ResourceVectorV1
  }
  build: {
    mode: 'backend' | 'prebuild-preferred' | 'prebuild-required'
    remote_cache?: string
  }
  model_capture: {
    mode: 'off' | 'native' | 'proxy' | 'hybrid'
    required: boolean
  }
}
```

API 输入使用同结构的 `EvalSubmissionInputV1`，但 `request` 接受 `EvalRequestInput`，且不接受客户端提供 `submitted_at`。服务端完成校验、benchmark resolution 和时间戳写入后才形成上述持久化记录。

兼容规则：

- `/v1/evals` 可以接受现有扁平 `EvalRequestInput`，服务端将其包装为默认 policy。
- `request.json` 继续写入现有 EvalRequest，不加入调度字段。
- 调度策略不参与 Harness、benchmark 或 observation identity。
- `max_parallelism` 默认等于现有 `request.max_concurrent`，但仍受全局预算限制。

### 8.2 Resource vector

```ts
interface ResourceVectorV1 {
  cpu_millis: number
  memory_bytes: number
  container_slots: number
  build_slots: number
  gpu_count?: number
  ephemeral_disk_bytes?: number
}
```

约束：

- 所有字段为非负安全整数。
- 调度预留必须对完整向量原子成功或完全失败。
- `cpu_millis` 表示可调度配额，不等同于实际 CPU time。
- `memory_bytes` 必须对应 Docker/worker 的硬限制或可审计的 admission limit。
- 未知资源不能按零处理；必须使用 operator 配置的保守默认值。

### 8.3 Trial slot 与 work item

```ts
interface TrialSlotV1 {
  schema_version: '1'
  slot_id: string
  eval_id: string
  task_id: string
  task_digest?: `sha256:${string}`
  attempt: number
  candidate_identity: `sha256:${string}`
  state:
    | 'pending'
    | 'blocked'
    | 'ready'
    | 'leased'
    | 'running'
    | 'collecting'
    | 'succeeded'
    | 'invalid'
    | 'failed'
    | 'cancelled'
  physical_execution: number
  authoritative_run_id?: string
  invalid_reason?: string
}

interface BackendWorkItemV1 {
  schema_version: '1'
  work_id: string
  eval_id: string
  backend: 'harbor'
  slots: string[]
  opaque_membership: boolean
  requested_parallelism: number
  reservation: ResourceVectorV1
  provider: string
  image_refs: EnvironmentImageUseV1[]
}
```

`slot_id` 由以下 canonical JSON 的 SHA-256 派生，并编码为 `slot_<32-lower-hex>`：

```json
{
  "eval_id": "eval_...",
  "task_id": "task-name",
  "attempt": 1,
  "candidate_identity": "sha256:..."
}
```

`physical_execution` 从 1 开始，只在显式允许重新创建候选环境的基础设施重试时递增。

`candidate_identity` 对 `{harness revision identity, artifact id, requested model identity, agent args digest, protocol identity}` 做 canonical SHA-256；不包含 eval id、task、时间戳、本机路径或运行后才观测到的 provider session id。

### 8.4 Control record

```ts
interface EvalControlV1 {
  schema_version: '1'
  eval_id: string
  generation: number
  state:
    | 'queued'
    | 'planning'
    | 'preparing'
    | 'running'
    | 'finalizing'
    | 'succeeded'
    | 'failed'
    | 'cancelling'
    | 'cancelled'
  cancel_requested_at?: string
  active_leases: string[]
  queued_work_items: string[]
  terminal_work_items: string[]
  failure?: { code: string; message: string }
  created_at: string
  updated_at: string
}
```

每次更新必须读取上一 generation、校验预期值并原子替换。单 daemon root lock 防止两个 control plane 同时写入；generation 防止同一进程内部的迟到回调覆盖新状态。

### 8.5 Lease

```ts
interface ExecutionLeaseV1 {
  schema_version: '1'
  lease_id: string
  work_id: string
  eval_id: string
  worker_id: string
  provider: string
  reservation: ResourceVectorV1
  state: 'offered' | 'accepted' | 'running' | 'releasing' | 'released' | 'expired' | 'lost'
  epoch: number
  issued_at: string
  accepted_at?: string
  heartbeat_at?: string
  expires_at: string
  terminal_at?: string
}
```

- worker 必须携带 `(lease_id, epoch)` 上报事件。
- 新 epoch 使旧 worker 的迟到事件失效。
- 本地 provider 也必须使用 lease，不能走无记录的快捷路径。

### 8.6 Environment image manifest

```ts
interface EnvironmentImageManifestV1 {
  schema_version: '1'
  image_id: `sha256:${string}`
  source: {
    kind: 'registry' | 'build-context' | 'compose-build'
    benchmark_id: string
    benchmark_revision: string
    task_id?: string
    context_digest?: `sha256:${string}`
    dockerfile_digest?: `sha256:${string}`
  }
  platform: string
  build: {
    builder: 'buildkit'
    buildkit_version?: string
    builder_id?: string
    frontend?: string
    build_args_sha256?: `sha256:${string}`
    secret_names: string[]
    cache_key: `sha256:${string}`
  }
  output: {
    reference: string
    manifest_digest: `sha256:${string}`
    config_digest?: `sha256:${string}`
  }
  base_images: Array<{ reference: string; digest: `sha256:${string}` }>
  created_at: string
}

interface EnvironmentImageUseV1 {
  task_ids: string[]
  image_id: `sha256:${string}`
  reference: string
  manifest_digest: `sha256:${string}`
  platform: string
  resolution: 'registry' | 'prebuilt' | 'backend-build'
  cache_hit: boolean
}
```

`image_id` 的 canonical identity 排除 `created_at`、本地 tag、builder hostname 和 cache hit 状态，包含 source digest、platform、构建参数摘要、base image digest 和 output manifest digest。secret 只记录名称，不记录值或值摘要。

`build.cache_key` 在构建前计算，对规范化后的 `{source inputs, platform, frontend, target, build args digest, base image digests, secret names}` 做 canonical SHA-256。Build secret 只能用于认证不可变输入；如果 secret 会改变输出内容且没有不泄密的外部版本 identity，则必须禁用该构建的跨请求缓存，不能把 secret value 或可供离线猜测的 value digest 放入 key。

### 8.7 Result Bundle index

```ts
interface ResultBundleIndexV1 {
  schema_version: '1'
  run_id: string
  sealed: true
  context_identity: `sha256:${string}`
  files: Array<{
    role:
      | 'request'
      | 'resolution'
      | 'manifest'
      | 'result'
      | 'runtime-ref'
      | 'environment-manifest'
      | 'execution-evidence'
      | 'control-events'
      | 'process-log'
      | 'workspace-evidence'
      | 'trajectory'
      | 'provider-evidence'
      | 'verifier-evidence'
      | 'interaction-capture'
      | 'diagnostic'
    path: string
    size: number
    sha256: `sha256:${string}`
  }>
  environment?: {
    image_id?: `sha256:${string}`
    image_digest?: `sha256:${string}`
    provider: string
    worker_id?: string
    lease_id?: string
  }
  resources?: {
    requested: ResourceVectorV1
    observed?: Record<string, number>
  }
  interaction_ref?: string
  provenance: {
    harness_revision: `sha256:${string}`
    artifact_id?: `sha256:${string}`
    controller_runtime_id?: `sha256:${string}`
    benchmark_id?: string
    benchmark_revision?: string
    verifier_identity?: `sha256:${string}`
  }
  bundle_digest: `sha256:${string}`
  created_at: string
}
```

`bundle.index.json` 是对现有 run 目录的新增索引，不替换 `manifest.json`、`result.json` 或 `trajectory.ref.json`。旧 reader 可以忽略它，新 reader 必须验证所有文件路径不逃逸 run 目录、文件类型为 regular file、大小和摘要匹配。

`bundle_digest` 是对移除 `bundle_digest` 和 `created_at` 后的 index canonical JSON 计算的 SHA-256；它不把 `bundle.index.json` 自身列入 `files`，从而避免自引用。`files` 按规范化 UTF-8 path 字节排序，重复 path、绝对 path、非 NFC path 和 `..` 段均非法。

`context_identity` 对 `{context, parent, harness, model, protocol, observation}` 的 validated RunRecordV1 投影做 canonical SHA-256，不包含本机路径、时间戳或描述性错误文本。它用于证明 bundle 中的各类证据属于同一个逻辑运行上下文，不取代 `run_id`。

## 9. Eval API 与 CLI

### 9.1 HTTP API

| Method | Path | 行为 |
| --- | --- | --- |
| `POST` | `/v1/evals` | 校验、持久化并排队，返回 `202` |
| `GET` | `/v1/evals/:eval_id` | 返回 control、progress 和 terminal result 摘要 |
| `GET` | `/v1/evals/:eval_id/events?offset=N` | 按现有 run events 规则读取 NDJSON |
| `POST` | `/v1/evals/:eval_id/cancel` | 请求取消 queued/running eval |
| `POST` | `/v1/evals/:eval_id/reruns` | 按 task 或 invalid selector 创建显式 rerun operation |
| `GET` | `/v1/workers` | 返回 worker capabilities、心跳和资源占用 |
| `GET` | `/v1/builds/:build_id` | 返回构建状态和 image manifest 引用 |

提交响应：

```json
{
  "schema_version": "1",
  "eval_id": "eval_...",
  "status": "queued",
  "links": {
    "self": "/v1/evals/eval_...",
    "events": "/v1/evals/eval_.../events",
    "cancel": "/v1/evals/eval_.../cancel"
  }
}
```

状态响应：

```ts
interface EvalStatusResponseV1 {
  schema_version: '1'
  eval_id: string
  control: EvalControlV1
  progress: EvalProgressV1 | null
  result: EvalResultV1 | null
  effective_parallelism: {
    requested: number
    admitted: number
    running: number
  }
}
```

HTTP 规则：

- request/schema 错误返回 `400` 和稳定 error code；认证失败返回 `401`；不存在返回 `404`。
- idempotency 或 terminal-state 冲突返回 `409`。
- admission 能确定永远不可满足时返回 `422 resource_request_unsatisfiable`；暂时无资源仍返回 `202 queued`。
- cancel 对 queued/running eval 返回 `202`；对已 terminal eval 幂等返回 `200` 和现有状态。
- events endpoint 沿用 run events 的 committed-line、offset boundary 和 `x-hitch-next-offset` 规则。
- 所有 request body、单条 event 和 error message 都必须有大小上限。

### 9.2 Idempotency

- 客户端可以发送 `Idempotency-Key` header，或在 submission 中发送 `idempotency_key`，两者同时出现时必须相等。
- key 只在同一个 Hitch root 内有效。
- 服务端存储 key 到 normalized submission digest 的映射；digest 排除 `idempotency_key` 和服务端生成的 `submitted_at`。
- 同 key、同 digest 返回原 `eval_id`；同 key、不同 digest 返回 `409 idempotency_conflict`。
- 客户端断线后重试不得创建第二个 eval。

### 9.3 CLI

新增：

```bash
hitch eval run ... --daemon          # 提交并等待，保持现有 JSON/JSONL 输出语义
hitch eval submit ...                # 提交后立即返回 eval_id
hitch eval watch eval_<id>           # 跟随 events，最后输出 result
hitch eval cancel eval_<id>
hitch eval rerun eval_<id> ... --type candidate-restart
```

执行策略参数：

```text
--provider local-docker
--max-concurrent <n>
--cpu-per-trial <n>
--memory-per-trial <size>
--build-mode backend|prebuild-preferred|prebuild-required
--model-capture off|native|proxy|hybrid
--require-model-capture
```

兼容策略：

- `hitch eval run` 在 `0.3.x` 默认继续使用 direct mode。
- `--daemon` 和 `eval submit` 使用新控制面。
- 同一 root 的 daemon 存活且管理本机 Docker 资源时，direct Harbor eval 必须返回 `409 control_plane_active` 并提示使用 `--daemon`，避免绕过全局配额；使用独立 root 不受影响。
- direct mode 的 request、exit code、events、eval 目录和 result 格式保持兼容。
- 只有未来 major release 才能考虑将 daemon mode 改为默认，且必须单独立项。

## 10. Planning

### 10.1 Planner 输入与输出

Planner 输入包括：

- normalized EvalRequest；
- execution policy；
- resolved Harness revision 与 artifact；
- controller runtime；
- benchmark identity；
- backend capabilities；
- provider/worker capabilities；
- operator resource policy。

Planner 输出 immutable `execution-plan.json`，至少包含：

- candidate、benchmark、Verifier identity；
- task membership 状态；
- Trial Slots；
- Backend Work Items；
- 每个 work item 的资源需求；
- image resolution/build plan；
- provider constraints；
- capture policy；
- retry policy；
- planner 和 schema 版本。

### 10.2 已知 task membership

本地 dataset 必须在 admission 后、执行前枚举顶层 `task.toml`，沿用当前 task digest 和 planned trial 逻辑。

当 Harbor registry/package dataset 能通过稳定接口解析成员时，也必须在执行前生成 slots。task 顺序使用 UTF-8 字节排序，不能依赖文件系统或 registry 返回顺序。

### 10.3 Opaque task membership

如果 backend 无法可靠枚举任务：

- `execution-plan.json` 写入 `membership: "opaque"`；
- work item 不伪造 `slots`，使用 `opaque_membership: true`；
- 调度器按 `requested_parallelism * default_trial_resources` 保守预留；
- 首个 trial settle 后仍按现有 progress 规则发布真实 task identity；
- V1 同一 opaque eval 最多运行一个 Harbor work item，避免无法追踪的同任务冲突；
- opaque mode 不支持同一 eval 的 attempt 横向并行。

这是一条兼容降级路径，不是长期性能目标。

### 10.4 Work item 分片

已知 tasks 时：

- 每个 Harbor work item 使用 `n_attempts: 1`。
- 一个 work item 可以包含多个不同 task，但不得包含同一个 task 的多个 attempt。
- `requested_parallelism` 不得大于 work item 中的 slot 数。
- 分片大小由可用资源、build/image 相似性和 `max_parallelism` 决定。
- 相同环境镜像的 task 可优先同 shard，但公平性优先于缓存亲和性。
- 同一任务的 attempt 在相同 collision domain 内通过 task mutex 串行，直到 Harbor/provider 组合通过并行隔离 canary。

### 10.5 资源需求推导

每个 Trial Slot 的资源需求按以下优先级确定：

1. benchmark/task 中可验证的显式 CPU、memory、GPU 和 sidecar 声明；
2. environment/Compose 中的硬 limit；
3. submission execution policy 的 `default_trial`；
4. daemon operator 的保守默认值。

Planner 必须在 execution plan 中逐字段记录 `value`、`source` 和 `estimated`。一个 trial 包含多个容器时，reservation 是主容器、sidecars 和固定 provider overhead 的总和；不得只计算 Candidate Agent 所在容器。build resources 单独进入 build lane，不能重复计入 running trial，但 setup 期间同时存在 build 和 sandbox 时必须同时持有两类 reservation。

如果 task 声明与 Compose hard limit 冲突，取更大的 admission reservation，并产生 `resource_declaration_conflict` 诊断；provider 实际施加的硬限制必须记录在 `execution.json`。缺失 resource 声明不是零成本。

## 11. 全局资源调度

### 11.1 资源池

统一 resource ledger 覆盖 daemon `/v1/runs`、`/v1/evals`、image builds 和 provider leases。普通 daemon run 使用 CPU/内存 reservation；不创建容器时 `container_slots=0`。Harbor work item 按其内部最大同时活跃 trial 数预留 container slots 和对应 CPU/内存，不能只按 Harbor 进程数预留。

direct mode 在 daemon 未运行时保持单进程兼容路径，不宣称提供跨进程全局配额。daemon 已管理同一 root 的 Docker collision domain 时，direct Harbor eval 不得旁路 resource ledger。

每个 worker 暴露：

```ts
interface WorkerCapacityV1 {
  total: ResourceVectorV1
  reserved_for_system: ResourceVectorV1
  allocatable: ResourceVectorV1
  allocated: ResourceVectorV1
}
```

必须满足：

```text
allocatable = total - reserved_for_system
sum(active reservations) <= allocatable
```

本机 Docker provider 优先读取 Docker VM 的 CPU 和内存，而不是仅读取宿主机容量。在无法可靠检测时进入 conservative mode：`container_slots=1`，并要求 operator 显式配置后才能提高。

### 11.2 Admission 与 dispatch

Admission 只判断请求是否有可能运行：

- 单个 work item 需求大于所有兼容 worker 的最大容量时，eval 失败为 `resource_request_unsatisfiable`。
- 当前暂时无空闲资源时保持 queued，不失败。
- 缺少 provider capability 时失败为 `execution_provider_unavailable`。

Dispatch 必须同时满足：

1. eval 未被取消；
2. per-eval active slots 小于 `max_parallelism`；
3. worker capability 匹配 platform、backend、network 和 capture requirements；
4. 完整 ResourceVector 可以原子预留；
5. 所需 image 已就绪或 build lane 可用；
6. task mutex 可获得；
7. 公平调度允许该 eval 取得下一个 work item。

### 11.3 公平性

V1 使用按 eval 的 deficit round-robin：

- 每个非空 eval queue 每轮增加一个 quantum。
- work item cost 至少为 `container_slots`，并可加入标准化 CPU/内存权重。
- deficit 足够且资源可用时才能 dispatch。
- 单个大型 eval 不能让后提交的小型 eval 无限等待。
- build queue 与 execution queue 分离，但共享磁盘压力和 operator 限制。

V1 不提供用户可修改 priority。引入 priority 必须同时定义配额和防饥饿策略。

### 11.4 `max_concurrent` 语义

归一化后：

```text
effective eval parallelism = min(
  request.max_concurrent,
  execution.max_parallelism,
  available worker container slots,
  floor(available cpu / cpu per trial),
  floor(available memory / memory per trial),
  backend safe parallelism
)
```

因此 `max_concurrent=8` 不代表一定启动 8 个容器。API 状态必须同时展示 requested、admitted 和当前 effective parallelism。

### 11.5 Build lane

- `build_slots` 与 `container_slots` 分开计数。
- 默认本机 `build_slots=1`。
- 同一 build cache key 只允许一个 owner；其他 work item 等待同一 Promise/持久化 build record。
- 构建失败释放 build slot，但保留有界诊断记录。
- 执行容器不得因等待构建而长期占用完整 trial reservation。

### 11.6 task mutex

mutex key：

```text
sha256(collision_domain_id + backend + benchmark_id + benchmark_revision + task_id)
```

- mutex 覆盖 environment create 到 cleanup 完成。
- `collision_domain_id` 表示共享容器名、端口、Compose project、工作目录或 Docker daemon 的实际冲突域；本机通常是 Docker engine identity。
- 不同 eval 在同一 collision domain 运行同一 benchmark task 时也必须竞争同一 mutex。
- 不共享 Docker daemon、网络、工作目录或 mutable image tag 的独立 worker 可以拥有不同 collision domain，因此同一 task 可跨域并行。
- 当 Harbor/provider 组合通过容器名、端口、Compose project、sidecar 和目录隔离 canary 后，可按 capability flag 在该 collision domain 内关闭。
- operator 不能仅通过提高 `max_concurrent` 绕过 mutex。

## 12. 环境镜像解析、构建与缓存

### 12.1 解析顺序

1. 如果 task 指向带 digest 的 registry image，直接验证 platform 并使用。
2. 如果只提供 mutable tag，解析为 registry digest，并把 tag 和 digest 都记录到 manifest。
3. 如果提供 Dockerfile/build context，计算 context、Dockerfile、build args 和 base image digest。
4. 如果是 Compose build，规范化实际 build context、Dockerfile、target、args 和 platform，不以 service name 作为 identity。
5. 查找本地 EnvironmentImageManifest 和 OCI registry cache。
6. miss 时进入 build queue。

### 12.2 构建流程

```text
resolve immutable inputs
  -> calculate build cache key
  -> acquire keyed build lock
  -> recheck local/registry cache
  -> run BuildKit with bounded logs and resource reservation
  -> resolve output manifest digest
  -> verify platform and declared metadata
  -> write manifest in staging
  -> verify again
  -> atomic promotion
  -> inject digest into backend work item
```

### 12.3 BuildKit cache

- 支持 `cache-from` 和 `cache-to` registry backend。
- cache reference 必须由 benchmark、task environment identity 和 platform 派生，不能使用用户输入的任意 tag 覆盖其他缓存。
- cache 是性能提示，不是 identity；命中后仍必须验证最终 image digest。
- secret mount 和 SSH mount 不得进入 build args、manifest 或缓存元数据。
- 构建日志必须经过 credential redaction 并限制单条和总大小。
- builder 可以是本机 BuildKit 或显式注册的远程 BuildKit endpoint；远程 builder 仍需占用对应 worker/build pool 的 `build_slots`，并记录非敏感 `builder_id` 和版本。
- builder 暂时失联时不得假定构建失败后立即启动第二个同 key build；必须先等待原 build lease 到期并执行 cache/output probe。

### 12.4 Harbor 注入

优先级：

1. backend 能安全把环境替换为预构建 digest 时，写入 `image: <ref>@sha256:...` 并移除对应 build stanza。
2. 只能使用本地镜像时，创建由 digest 派生的只读兼容 tag，同时把真实 digest 写入 plan 和 bundle。
3. 当前 Harbor/Compose 版本无法安全 overlay 时，降级到 backend build，但仍必须取得 Hitch build mutex，并限制 build concurrency。

不得宣称预构建成功却让 Compose 再次从 mutable context 构建。

### 12.5 Store 与 GC

- Environment image store 只存 manifest，不复制 Docker/OCI layer。
- layer 生命周期由 Docker 或 registry 管理。
- GC 只能删除没有被非终态 eval、sealed bundle 或 operator pin 引用的 build record/tag。
- Docker image 删除必须按 digest 和 Hitch label 双重确认。
- GC 不在 eval critical path 内自动执行大规模 prune。

## 13. Execution Provider 与 worker

### 13.1 契约

```ts
interface ExecutionProvider {
  id: string
  inspect(): Promise<ExecutionProviderStatusV1>
  plan(input: ProviderPlanInput): Promise<ProviderPlanResult>
  offer(lease: ExecutionLeaseV1, work: BackendWorkItemV1): Promise<OfferResult>
  cancel(leaseId: string, epoch: number): Promise<void>
  recover(lease: ExecutionLeaseV1): Promise<RecoveryResult>
  release(leaseId: string, epoch: number): Promise<void>
}

interface ExecutionProviderStatusV1 {
  schema_version: '1'
  provider: string
  worker_id: string
  collision_domain_id: string
  health: 'healthy' | 'degraded' | 'unavailable'
  platforms: string[]
  backends: Array<{ id: string; version: string }>
  features: {
    docker: boolean
    buildkit: boolean
    model_proxy: boolean
    isolated_same_task_attempts: boolean
  }
  capacity: WorkerCapacityV1
  heartbeat_at: string
}

interface ProviderPlanInput {
  work: BackendWorkItemV1
  platform: string
  adapter_requirements: AdapterRuntimeRequirementsV1
}

interface ProviderPlanResult {
  supported: boolean
  reservation: ResourceVectorV1
  constraints: string[]
}

interface OfferResult {
  accepted: boolean
  handle?: { provider: string; worker_id: string; native_id: string }
  rejection_code?: string
}

interface RecoveryResult {
  state: 'not-started' | 'running' | 'terminal-uncollected' | 'released' | 'ambiguous'
  handle?: { provider: string; worker_id: string; native_id: string }
}
```

provider 不得：

- 修改 EvalRequest 或 backend task semantics；
- 根据日志文本猜测 reward；
- 覆盖 Hitch 已锁定的 Harness revision；
- 无 lease 启动持久执行；
- 删除其他 provider 或其他 Hitch root 的资源。

### 13.2 `local-docker`

V1 行为：

- worker 与 daemon 同进程或同主机 helper 进程运行。
- worker status 声明稳定的 `collision_domain_id`；同一 Docker engine 上的 worker 不得伪装成不同冲突域。
- provider 启动受控 Harbor backend process；具体 task containers 仍由 Harbor 创建。
- 所有可控制的 Docker/Compose 资源增加以下 labels：

```text
io.hitch.root-id
io.hitch.eval-id
io.hitch.work-id
io.hitch.lease-id
io.hitch.lease-epoch
io.hitch.task-id              # 已知时
```

- backend directory 必须包含 `eval_id/work_id/lease_epoch`，防止迟到进程覆盖新执行结果。
- provider 记录 Harbor PID、process start identity、Docker resource IDs 和最后心跳。
- provider 尽力从 Docker stats/cgroup 采集 peak memory、CPU time、OOM 和退出原因；无法采集时将 observed resources 标记为 unavailable，不能用 reservation 冒充实际用量。

### 13.3 Remote worker

远程 worker 最小协议：

1. `register`：上报 worker identity、platform、Docker/Harbor/BuildKit 版本和容量。
2. `heartbeat`：上报当前 lease、资源使用和健康状态。
3. `offer/accept`：控制面发 lease，worker 明确接受后才能启动。
4. `events`：按 lease sequence 发送幂等事件。
5. `artifact publish`：上传或提供内容寻址 staging bundle。
6. `complete`：上报 terminal status 和 artifact refs。
7. `cancel/release`：终止并回收属于该 lease 的资源。

远程协议的 transport 可以单独选择 HTTPS、gRPC 或队列；本规范固定语义，不固定 V1 transport。

### 13.4 Lease、心跳与 reaper

- 默认 heartbeat interval：10 秒。
- 默认 lease TTL：45 秒；必须至少大于 3 个 heartbeat interval。
- 本机进程仍在且 process identity 匹配时，短暂 daemon 重启可以 recover。
- TTL 到期后先标记 `expired`，执行 provider recovery probe；不能立即重跑 Candidate Agent。
- 能证明执行仍存活时签发更高 epoch 的恢复 lease。
- 能证明尚未启动 Candidate Agent 时，可以安全重新排队。
- 无法判断 Candidate Agent 是否运行过时，slot 标记 invalid `execution_state_ambiguous`，除非显式 retry policy 允许新的 physical execution。
- reaper 只清理标签与 terminal/expired lease 完全匹配的资源。

## 14. Harbor backend 集成

### 14.1 兼容原则

以下 Harbor 语义保持不变：

- dataset 和 task 内容；
- task environment 行为；
- Candidate Agent 收到的 instruction；
- Verifier 脚本和 rewards；
- Harbor trial artifacts 和 result normalization；
- `environment.delete: true` 的默认隔离策略。

### 14.2 Backend contract

Harbor backend 拆成：

```ts
interface EvalBackendV2 {
  id: 'harbor'
  capabilities(): BackendCapabilitiesV1
  plan(input: BackendPlanInput): Promise<BackendPlanV1>
  run(input: BackendRunInput): Promise<BackendRunResultV1>
  cancel(handle: BackendExecutionHandleV1): Promise<void>
  recover(handle: BackendExecutionHandleV1): Promise<BackendRecoveryV1>
}

interface BackendCapabilitiesV1 {
  backend: string
  version: string
  task_membership: 'enumerable' | 'opaque'
  prebuilt_image_overlay: boolean
  isolated_same_task_attempts: boolean
  verifier_only_retry: boolean
  recoverable_process: boolean
}

interface BackendPlanInput {
  eval_id: string
  request: EvalRequest
  candidate_identity: `sha256:${string}`
  known_task_ids: string[] | null
  execution: EvalExecutionPolicyV1
}

interface BackendPlanV1 {
  membership: 'known' | 'opaque'
  task_ids: string[]
  work_items: BackendWorkItemV1[]
  diagnostics: string[]
}

interface BackendExecutionHandleV1 {
  work_id: string
  lease_id: string
  lease_epoch: number
  process_id?: number
  native_id?: string
}

interface BackendRunInput {
  eval_id: string
  eval_directory: string
  backend_directory: string
  request: EvalRequest
  work: BackendWorkItemV1
  lease: ExecutionLeaseV1
  harness_artifact: {
    directory: string
    artifact_id: `sha256:${string}`
    artifact_integrity: `sha256:${string}`
    entrypoint_integrity: `sha256:${string}`
    revision_identity: `sha256:${string}`
    platform: string
  }
  controller_runtime: {
    directory: string
    runtime_id: `sha256:${string}`
    manifest_digest: `sha256:${string}`
  }
  credential_names: string[]
}

interface BackendRunResultV1 {
  status: 'succeeded' | 'failed' | 'cancelled' | 'lost'
  settled_trials: EvalTrialRefV1[]
  artifacts: BackendArtifactReference[]
  handle: BackendExecutionHandleV1
}

interface BackendRecoveryV1 {
  state: 'not-started' | 'running' | 'terminal-uncollected' | 'released' | 'ambiguous'
  result?: BackendRunResultV1
}
```

`run()` 只接收已选定的 tasks、attempt、parallelism、image refs、artifact/runtime refs、lease 和显式目录，不读取 control-plane queue。

### 14.3 JobConfig 生成规则

- 每个 work item 固定 `n_attempts: 1`。
- `n_concurrent_trials <= lease.reservation.container_slots`。
- 已知 slots 时必须把 task 子集显式写入 dataset/task selector。
- job name、directory、Compose project 和可控资源名包含 `work_id` 与 lease epoch。
- Harness artifact、controller runtime 和 local Git transport 继续使用现有完整性校验。
- 只传 credential 环境变量名称/引用，不把值写入 JobConfig。
- `include_logs` 继续包含 `hitch-*`，并增加有界 control/build/provider diagnostics。

### 14.4 并行 attempt

当前外层完全串行的 logical attempt 改为 slot 级调度，但执行规则是：

- 不同 task 的 attempt 可以并行；
- 同一 task 的不同 attempt 在同一 collision domain 默认串行；
- 同一 task mutex 必须在一个 collision domain 内跨 eval 生效；
- 独立 collision domain 可以并行相同 task；
- 只有 Harbor/provider capability `isolated_same_task_attempts=true` 且版本 canary 通过时才允许在同一 collision domain 并行；
- capability 必须由代码中的版本/测试矩阵决定，不能由用户请求自动开启。

### 14.5 Harbor 缺陷隔离

| 风险 | Hitch 侧措施 |
| --- | --- |
| 固定容器名/端口冲突 | collision-domain task mutex、work/lease namespace、同域同任务 attempt 默认串行 |
| 同一 sidecar 并发构建或 file lock 问题 | 独立 build lane、cache-key mutex、预构建优先 |
| Compose build overlay 未使用内容寻址 image | 构建后校验实际容器 image digest；不匹配时失败，不静默继续 |
| Harbor 进程结束但 bundle 尚未落盘 | 保留现有 bundle readiness grace 和 diagnostic run |
| stopped containers/networks 遗留 | lease 标签、provider recovery probe、所有权安全 reaper |
| Harbor 返回重复或缺失 trial | 使用 Slot identity、现有 trial import identity 校验和终态集合校验 |

### 14.6 Verifier 与重试

- 延续现有 verifier-only retry：只在原 live trial 内重跑 Verifier。
- Verifier failure 不能进入 Candidate Agent physical retry 路径。
- 非 Verifier 基础设施失败可以根据 `infrastructure_retries` 产生新 physical execution。
- 每次 physical execution 都保留独立 backend directory 和 diagnostic history。
- 最终只发布一个 authoritative run；被替代执行保留受限诊断引用，不作为有效 observation。

## 15. Agent Adapter 与 Shared Runtime

### 15.1 保留现有 AdapterDefinition

现有 `AdapterCapabilities`、`process()`、`translate()` 和 `translateLine()` 继续作为 provider-specific 契约。新增可选 requirements：

```ts
interface AdapterRuntimeRequirementsV1 {
  platforms?: string[]
  node_range?: string
  network: 'required' | 'optional' | 'forbidden'
  credential_names: string[]
  endpoint_override: 'supported' | 'unsupported' | 'unknown'
  capture: {
    native_events: boolean
    native_session: boolean
    model_proxy_compatible: boolean
  }
}
```

### 15.2 Shared Runtime 职责

Shared Runtime 统一负责：

- 运行目录和 runtime home；
- 进程启动、signal、timeout 和 graceful cancellation；
- credential 名称到临时环境/文件的注入；
- model proxy endpoint 注入；
- tunnel/proxy/environment setup；
- bounded stdout/stderr 与结构化事件；
- trace/eval/trial/run/lease correlation IDs；
- provider-native evidence redaction；
- Result Bundle staging/export；
- runtime 自身版本和完整性校验。

provider adapter 只负责：

- 将标准请求转换为原生 argv/stdin/env；
- 解析原生事件；
- 声明能力和 requirements；
- 必要的 provider-specific session 发现。

Shared Runtime 演进现有 content-addressed ControllerRuntimeBundle，不创建第二套可变脚本分发机制。

## 16. 模型访问与交互采集

### 16.1 模式

| 模式 | 行为 |
| --- | --- |
| `off` | 不新增采集；现有原生日志仍按 adapter 行为保存 |
| `native` | 只保存 provider-native evidence 和 canonical trajectory；默认值 |
| `proxy` | 通过显式 endpoint proxy 采集模型请求/响应；仍保留可用的原生轨迹 |
| `hybrid` | 同时要求 native 与 proxy 证据，并通过 correlation ID 关联 |

如果 adapter 不支持 endpoint override：

- capture `required=false` 时降级为 `native` 并记录原因；
- capture `required=true` 时 admission 失败为 `model_capture_unsupported`。

### 16.2 Interaction schema

```ts
interface ModelInteractionV1 {
  schema_version: '1'
  interaction_id: string
  run_id: string
  eval_id?: string
  trial_id?: string
  sequence: number
  requested_model: string
  effective_model?: string
  endpoint_identity: `sha256:${string}`
  started_at: string
  completed_at?: string
  latency_ms?: number
  status: 'succeeded' | 'failed' | 'cancelled'
  http_status?: number
  retry_of?: string
  usage?: Record<string, number>
  request_ref?: string
  response_ref?: string
  error?: { code: string; message: string }
}
```

请求和响应 payload 必须在落盘前脱敏。Authorization、Cookie、API key、自定义 secret header 和已知 credential 值不得保存。endpoint identity 对规范化 scheme/host/path 和企业 endpoint 标识做摘要，不包含 token 或 query secret。

### 16.3 Proxy 部署拓扑

支持两种拓扑：

- `host-side`：proxy 运行在 worker 上，sandbox 通过显式 endpoint/tunnel 访问；适合本机 Docker，便于集中采集和凭据托管。
- `in-sandbox`：proxy sidecar 与 Agent 同一隔离域运行，再转发到 public 或 enterprise endpoint；适合远程 worker 或无法回连 host 的网络。

选择规则：

- 拓扑必须写入 execution plan 和 interaction ref。
- provider 必须证明 sandbox 可达 proxy 且 proxy 可达目标 endpoint。
- enterprise endpoint 的证书校验、SNI 和自定义 CA 必须显式配置，不允许静默关闭 TLS verification。
- host-side proxy 不得监听超出 worker 所需的公共接口；in-sandbox proxy 不得把 credential 写入镜像层。
- proxy 健康检查在 Candidate Agent 启动前完成；`required=true` 时健康检查失败不得启动 Agent。

### 16.4 与 trajectory 的关系

- interaction capture 是模型网络证据，不是 canonical Agent trajectory。
- trajectory 仍是工具调用、消息边界和 provider session 的权威表示。
- 通过 `run_id + interaction_id + provider request id` 尽力关联。
- 无法一一关联时记录 `capture_completeness: partial`，不得伪造映射。
- proxy capture 失败在 `required=false` 时不改变 Agent result，但 Result Bundle 必须标记不完整。

## 17. Result Bundle 与训练数据候选

### 17.1 发布顺序

```text
backend terminal
  -> copy bounded diagnostics and verifier evidence to staging
  -> validate run identity and parent Eval/Trial identity
  -> validate provider evidence and canonical trajectory
  -> validate interaction capture according to policy
  -> write observation, terminal result and sealed manifest in staging
  -> build bundle.index.json
  -> verify every indexed file and bundle digest
  -> atomically promote runs/<run-id>/
  -> atomically update eval progress
```

atomic promotion 之后不得再修改 run 目录中的 manifest、result、bundle index 或证据文件。任何一步失败都不得留下看似成功但未封存的权威 run。沿用现有 diagnostic run 机制表示缺失或损坏的 bundle。

### 17.2 Bundle completeness

`bundle.index.json` 必须记录：

- request、resolution、result；
- Harness revision、artifact 和 controller runtime；
- provider-native evidence 和 canonical trajectory；
- Verifier result、重试历史和 observation；
- environment image digest、provider、worker 和 lease；
- requested/observed resources；
- model interaction ref 或明确的 capture mode/completeness；
- redaction summary；
- 所有文件摘要和 bundle digest。

### 17.3 Training-data Candidate

```ts
interface TrainingDataCandidateV1 {
  schema_version: '1'
  candidate_id: `sha256:${string}`
  source_bundle_digest: `sha256:${string}`
  run_id: string
  eligibility: 'eligible' | 'ineligible' | 'review-required'
  reasons: string[]
  context_ref: string
  trajectory_ref: string
  verifier_ref: string
  metadata: {
    benchmark_id: string
    benchmark_revision: string
    harness_revision: `sha256:${string}`
    model_identity_resolved: boolean
    capture_completeness: 'complete' | 'partial' | 'none'
    redaction_policy: string
  }
  provenance_digest: `sha256:${string}`
}
```

默认 eligibility policy：

- observation 必须为 `valid`；
- Verifier evidence 必须完整；
- trajectory 必须通过完整性校验；
- context/task 许可状态明确，否则 `review-required`；
- model identity 未解析时 `review-required`；
- required capture 不完整时 `ineligible`；
- 存在未处理敏感字段或脱敏失败时 `ineligible`；
- infrastructure diagnostic run 永远 `ineligible`。

Training-data Candidate 是派生记录，不写回或修改 source bundle。

## 18. 状态机、取消与恢复

### 18.1 Eval 状态机

```text
queued -> planning -> preparing -> running -> finalizing -> succeeded
   |         |           |          |            |
   +---------+-----------+----------+----------> failed
   |         |           |          |
   +---------+-----------+----------+----------> cancelling -> cancelled
```

- 进入 terminal 状态后不可回退。
- `cancel_requested_at` 一旦写入不可清除。
- finalizing 期间取消只阻止新 work item；已经获得的结果仍需完成安全导入，然后 eval 以 `cancelled` 终止。

### 18.2 Work item/lease 状态

```text
ready -> offered -> accepted -> running -> releasing -> released
   |        |           |          |
   |        +---------> expired -> recovered | lost
   +------------------------------> cancelled
```

资源只在以下条件全部满足后释放：

1. backend process 已停止或确认不再属于有效 epoch；
2. provider 完成必要 artifact collection；
3. 属于 lease 的容器/网络/临时资源已删除或记录为 cleanup failure；
4. lease terminal record 已原子写入。

### 18.3 daemon 重启恢复

启动顺序：

1. 获取 root instance lock。
2. 扫描非终态 `control.json`。
3. 加载 active leases 并验证 schema/generation。
4. 调用 provider `recover()`，不得先假定失败。
5. 对 still-running lease 恢复事件消费和 heartbeat。
6. 对 definitively-not-started work item 重新排队。
7. 对 terminal-but-uncollected work item继续 collection/import。
8. 对 ambiguous execution 标记 invalid 或等待显式 retry policy。
9. 完成 progress/result 一致性检查后才开放新 submission。

恢复过程本身必须产生事件，且同一 lease recovery 可幂等重试。

这里的 `recover` 不是 `rerun`：能够证明原 physical execution 仍存活或已经终止但尚未收集时，应继续消费原执行或收集原结果，不创建新的 Candidate execution。只有 provider 无法恢复原执行且操作方明确选择 rerun policy 时，才可以创建新的 physical execution。

## 19. 失败分类与重试策略

### 19.1 Rerun 类型

`rerun` 必须显式区分以下类型，不能在恢复失败后静默退化为 Candidate 从头执行：

| `rerun_type` | Candidate 行为 | 对话来源 | Sandbox 来源 | V1 状态 |
| --- | --- | --- | --- | --- |
| `candidate-restart` | 从原 instruction 重新执行 | 新会话 | 干净环境 | 已实现；兼容默认值 |
| `candidate-resume` | 继续原 Candidate | provider-native session | 可验证 checkpoint | 保留；条件不满足时拒绝 |
| `trajectory-replay` | 新 physical execution 重放上下文 | 已验证 canonical trajectory | 可验证 checkpoint | 保留；条件不满足时拒绝 |
| `verifier-only` | 不执行 Candidate | 无 | 原 live/retained sandbox | 仅原环境仍可用时允许 |
| `collect-only` | 不执行 Candidate | 无 | 无 | 用于 terminal-but-uncollected 导入恢复 |

持久化的 rerun request、state、event 和 result 至少记录：

```ts
interface EvalRerunOperationV1 {
  rerun_type:
    | 'candidate-restart'
    | 'candidate-resume'
    | 'trajectory-replay'
    | 'verifier-only'
    | 'collect-only'
  semantics: {
    candidate_action: 'restart' | 'resume' | 'replay' | 'none'
    conversation_source: 'original-instruction' | 'native-session' | 'canonical-trajectory' | 'none'
    sandbox_source: 'clean' | 'checkpoint' | 'retained' | 'none'
    candidate_executes: boolean
  }
  source_trial_id?: string
  source_run_id?: string
  source_lease_id?: string
  source_trajectory_digest?: `sha256:${string}`
  source_checkpoint_digest?: `sha256:${string}`
}
```

canonical trajectory 是审计证据，不是进程 checkpoint。把历史消息重新发送给 LLM 只能称为 `trajectory-replay`，不能称为透明 `candidate-resume`，因为轨迹不能单独恢复容器文件系统、后台进程、未完成 tool call、凭据句柄或 provider-native session。`trajectory-replay` 必须同时满足：trajectory 完整性验证通过、来源 lineage 明确、sandbox checkpoint 可恢复、Adapter 明确支持 context replay；否则返回 `eval_trajectory_replay_unavailable`。

`candidate-resume` 必须同时验证 Adapter `resume` capability、原生 session identity、sandbox checkpoint、来源 lease epoch 和模型/protocol identity。任一条件不满足时返回 `eval_candidate_resume_unavailable`，不得改跑 `candidate-restart`。所有新执行必须获得新 lease/epoch，并以 `retry_of` 或 `resume_of` 指向来源执行；旧 epoch 的迟到事件不得覆盖新执行。

### 19.2 失败与重试矩阵

| 阶段 | 稳定错误码示例 | 默认重试 | Candidate 是否重跑 |
| --- | --- | --- | --- |
| request/admission | `invalid_input`, `resource_request_unsatisfiable` | 否 | 否 |
| Harness/image resolution | `revision_unavailable`, `image_resolution_failed` | 仅网络型有界重试 | 否 |
| build | `environment_build_failed`, `build_cache_unavailable` | 有界重试；cache 故障可降级 | 否 |
| lease offer | `worker_rejected`, `worker_unavailable` | 换兼容 worker | 否 |
| worker lost before Agent | `worker_lost_before_candidate` | 是 | 尚未运行 |
| worker state ambiguous | `execution_state_ambiguous` | 默认否 | 仅显式 policy |
| sandbox setup | `sandbox_setup_failed` | 计入 infrastructure retry | 可能产生新 physical execution |
| Agent execution | `agent_failed`, `agent_timed_out` | 默认否 | 否 |
| Verifier bootstrap | `verifier_infrastructure_failure` | 原 sandbox verifier-only | 否 |
| Verifier result missing | `verifier_result_missing` | 原 sandbox 可用时 verifier-only | 否 |
| model capture | `model_capture_incomplete` | required 时 invalid；否则 warning | 否 |
| bundle collection | `result_bundle_missing`, `result_bundle_invalid` | readiness grace + collection retry | 否 |
| cleanup | `sandbox_cleanup_failed` | reaper 重试 | 否 |

所有 retry 事件必须记录 attempt、backoff、原因、是否重新运行 Candidate Agent。禁止仅根据 exception message 选择会改变候选执行语义的重试。

## 20. 安全、凭据与信任边界

### 20.1 凭据

- 继续使用显式 allowlist 和 `--pass-env NAME`。
- plan、lease 和 worker offer 只包含 credential name/secret handle。
- 本机 provider 在启动前最后一刻从 daemon process environment 解析值。
- 远程 worker 使用一次性、短 TTL secret envelope；不得通过普通事件或 artifact 通道传递明文。
- secret 不进入 image layer、BuildKit cache、process argv、JobConfig、trajectory 或 bundle。
- 日志 redaction 同时匹配敏感字段名和本次注入的已知值。

### 20.2 不可信输入

以下均按不可信输入处理：

- Harbor result 和 trial artifacts；
- worker events 和 artifact refs；
- provider-native JSONL；
- model endpoint 响应；
- build logs 和 image labels；
- bundle staging 目录。

必须执行 schema allowlist、路径逃逸检查、regular-file 检查、大小上限、摘要校验和有界错误信息。远程 worker 不能覆盖 control plane 已锁定的 eval/run/trial identity。

### 20.3 Docker 所有权与删除

- 所有可回收资源必须至少有 root-id、lease-id 和 epoch 标签。
- reaper 先列出、再逐个验证，不使用宽泛 name glob 删除。
- label 缺失、冲突或 lease 不可读时只报告，不删除。
- 不自动执行全局 `docker system prune`、volume prune 或 builder prune。

### 20.4 远程 worker

- worker 必须使用可撤销身份认证。
- lease offer 和 terminal receipt 必须防重放。
- worker 只能读取当前 lease 所需的 artifacts/secrets。
- worker artifact 上传必须先进入隔离 staging，再由控制面验证和 promote。
- 网络层安全的具体实现由 remote worker transport spec 补充，但不能降低上述语义要求。

## 21. 可观测性

### 21.1 事件

新增事件至少包括：

```text
eval.queued
eval.planning.started
eval.plan.created
eval.resource.blocked
eval.work.queued
eval.work.leased
eval.work.started
eval.work.completed
eval.work.lost
eval.finalizing
eval.cancel.requested

build.queued
build.started
build.cache_hit
build.completed
build.failed

worker.registered
worker.heartbeat_missed
lease.offered
lease.accepted
lease.renewed
lease.expired
lease.recovered
lease.released

sandbox.cleanup.started
sandbox.cleanup.completed
sandbox.cleanup.failed
interaction.capture.degraded
result.bundle.sealed
```

事件不得包含 prompt、credential value、完整模型请求/响应或无界异常文本。

### 21.2 健康状态

`GET /health` 扩展但保持现有字段：

```json
{
  "status": "running",
  "scheduler": {
    "queued_runs": 0,
    "queued_evals": 2,
    "active_work_items": 1,
    "resources": {
      "cpu_millis": {"allocated": 2000, "allocatable": 9000},
      "memory_bytes": {"allocated": 4294967296, "allocatable": 7516192768},
      "container_slots": {"allocated": 1, "allocatable": 2},
      "build_slots": {"allocated": 0, "allocatable": 1}
    }
  },
  "workers": {"healthy": 1, "degraded": 0, "lost": 0}
}
```

### 21.3 指标

V1 至少在结构化 daemon logs/health 中暴露：

- queue wait、planning、build、setup、Agent、Verifier、collection 时长；
- requested/admitted/effective parallelism；
- build cache hit/miss/wait；
- CPU、memory、container、build slot 利用率；
- worker heartbeat age 和 lease recovery 次数；
- trial valid/invalid、physical retry 和 Candidate rerun 次数；
- bundle/capture completeness；
- cleanup failure 和残留资源数量。

Prometheus endpoint 可以后续增加，不是 V1 阻塞条件。

## 22. 配置与默认策略

### 22.1 配置优先级

```text
CLI operator flags
  > HITCH_* environment policy
  > provider auto-detection
  > conservative defaults
```

请求中的 `max_concurrent` 不是 operator policy，优先级低于 daemon/worker 资源限制。

### 22.2 本机默认值

- CPU：读取 Docker engine/VM 可用 CPU，保留至少 1 CPU 给系统和控制面。
- 内存：读取 Docker engine/VM 内存，保留至少 1 GiB；无法读取时只允许 1 个 container slot。
- container slots：由 CPU、内存和 operator cap 的最小值确定。
- build slots：1。
- 每 trial CPU/内存：优先使用 task 明确声明；否则使用 operator 默认；两者都缺失时采用保守模板并在 plan 记录 `resource_estimate: true`。
- model capture：`native`、`required=false`。
- build mode：`prebuild-preferred`；无法安全注入 digest 时降级为 backend build。
- 同一 collision domain 内的同任务 attempt：串行。

对于 10 CPU、8 GiB Docker VM，若 task 声明 2 CPU、4 GiB，则有效并发应为 2，而不是请求默认值 4。

## 23. 兼容与迁移

### 23.1 磁盘与 Schema

- 现有 `runs/`、`evals/`、artifact store 和 controller runtime store 原地保留。
- 新文件均为 additive；旧记录不要求 backfill。
- reader 以文件存在性区分 legacy direct eval 和 control-plane eval。
- 现有 `eval-progress.schema.json`、`eval-result.schema.json` 和 RunRecordV1 语义不变。
- 新增 submission、execution-plan、control、lease、image manifest、interaction ref 和 bundle index schema。
- 不修改已有 content digest 的 canonical encoding。

### 23.2 CLI/API

- direct `hitch eval run` 保持可用。
- daemon eval 是 opt-in，不改变现有自动化脚本。
- `eval list` 和 `eval inspect` 同时读取两种模式。
- `eval rerun` 对 control-plane eval 必须通过 daemon rerun endpoint，避免绕开活跃 lease；对 terminal legacy eval 保留现有 direct 行为。

### 23.3 Harbor

- 继续 pin 已验证的 Harbor 版本。
- backend capabilities 按 Harbor 版本显式声明。
- 升级 Harbor 前必须运行相同 task attempt、并发 build、image overlay、bundle export 和 verifier-only retry canary。
- 如果新 Harbor 版本修复某项缺陷，只能在 canary 通过后移除 Hitch 侧 mutex/fallback。

## 24. 实施阶段

### 阶段 0：契约与兼容基线

1. 新增 domain types 和 JSON Schemas。
2. 将现有 Harbor JobConfig、eval request/result、progress 和 run bundle fixture 固化为兼容测试。
3. 更新 architecture checker 的模块集合和依赖规则。
4. 增加 provider/backend capability 模型，但不改变执行行为。

完成条件：完整 `npm run check` 通过，direct eval fixture 字节级或语义级兼容。

### 阶段 1：daemon eval 与持久队列

1. 新增 `/v1/evals`、status、events、cancel。
2. 新增 control records、generation 更新和启动恢复。
3. 将现有 daemon Run Scheduler 迁移到统一 resource ledger，保持 `/v1/runs` 行为兼容。
4. 把现有 `runEval()` 包装为单个 coarse-grained work item。
5. 实现 eval 间公平队列和整数 container slot 预留。

完成条件：多个 eval 不再各自突破 daemon 全局 container cap；daemon 重启可把未启动 eval 重新排队，并能安全分类活跃 eval。

### 阶段 2：资源向量、分片与 Harbor 并发治理

1. 实现 CPU/内存/container/build 原子预留。
2. 本地 dataset 生成 Trial Slots 和 work item shards。
3. 将 attempt 从外层全串行改为 slot 调度。
4. 实现跨 eval task mutex、lease epoch、Docker labels 和 reaper。
5. 保留 opaque dataset 保守降级。

完成条件：不同 task 可并行；同一 collision domain 内的同任务 attempt 不冲突；资源利用不超过 worker capacity；中断后不产生双重权威结果。

### 阶段 3：环境镜像服务

1. 实现 image resolution、manifest、store 和 keyed build locks。
2. 接入 BuildKit 本地/registry cache。
3. 实现 Harbor image digest overlay 和实际容器 digest 校验。
4. 构建与执行 lane 分离。

完成条件：相同环境的并发请求只构建一次；cache hit 不重新执行 Dockerfile；实际运行 image digest 与 plan 一致。

### 阶段 4：Execution Provider 与远程 worker

1. 将本机 Harbor process 封装为 `local-docker` provider。
2. 实现 worker registration、heartbeat、lease 和 artifact transport。
3. 增加 capability/resource-aware worker selection。
4. 完成网络中断、worker lost 和 artifact collection 恢复测试。

完成条件：同一 eval 可以在两个同构 worker 上运行不同 task，结果仍原子发布到控制面权威 store。

### 阶段 5：模型交互与数据候选

1. 增加 proxy/hybrid capture 和 adapter capability gate。
2. 写入 interaction refs、redaction summary 和 bundle index。
3. 实现 bundle validator。
4. 增加只读 Training-data Candidate exporter 和 eligibility policy。

完成条件：capture 可关闭、可降级、可要求；任何模式都不改变 Harbor reward；候选可追溯回唯一 sealed bundle。

## 25. 测试与验证

### 25.1 单元测试

- ResourceVector 原子加减、溢出和边界。
- deficit round-robin 公平性和防饥饿。
- task mutex key 与跨 eval 冲突。
- submission idempotency。
- control generation 的迟到写入拒绝。
- lease epoch 和重复事件去重。
- image cache key、manifest identity 和 secret 排除。
- bundle index 路径、大小、摘要和 canonical digest。
- capture policy 的支持、降级和 required failure。

### 25.2 并发测试

至少覆盖：

1. 两个 eval 各请求 4 并发，而 worker 只有 2 slots，实际同时运行不超过 2。
2. 大 eval 排队后提交一个单 task eval，小 eval 能在有资源的有限轮次内运行。
3. 10 个 work item 请求同一 image，只有一个 BuildKit invocation。
4. 相同 task 的两个 attempt 不同时持有同一 collision domain 的 task mutex，但可在两个独立域并行。
5. 不同 task、相同 image 可以并行并共享 cache。
6. cancel 与 settle 同时发生时只发布一次 run/progress generation。

### 25.3 崩溃恢复测试

在以下时点强制终止 daemon/worker：

- submission 写入后、queue 之前；
- lease offer 后、accept 前；
- Harbor 启动后、Agent 启动前；
- Agent 运行中；
- Verifier 完成后、bundle export 前；
- bundle 已 promote、progress 未更新；
- progress 已更新、eval result 未写入；
- cleanup 过程中。

每个 case 必须断言：没有重复 authoritative run、没有资源预算泄漏、没有错误 Candidate 自动重跑、状态最终可解释。

### 25.4 安全测试

- credential value 不出现在所有新增 JSON、events 和 logs 中。
- 恶意 worker 不能使用 `../` artifact path 覆盖 root 外文件。
- 伪造 lease epoch 的迟到事件被拒绝。
- reaper 不删除无 Hitch labels 或不同 root-id 的容器/网络/image。
- 恶意 bundle symlink、hardlink、FIFO、超大文件和 digest mismatch 被拒绝。
- model capture 对 Authorization、Cookie、自定义 secret header 和已知值脱敏。

### 25.5 集成与 canary

必须运行：

```bash
npm run typecheck
npm run build
npm run check:architecture
node dist/scripts/check-syntax.js
node --test "dist/test/*.test.js"
```

Docker/Harbor canary 至少包含：

- 2 个不同 task 并行；
- 同 task 2 个 attempt 串行；
- 环境 image cache miss 和 hit；
- Agent success、failure、timeout；
- Verifier success、真实零分、bootstrap failure 和 verifier-only retry；
- daemon cancel 和 restart recovery；
- bundle/trajectory 缺失 diagnostic；
- Docker 资源清理检查。

### 25.6 负载验收

在固定 10 CPU、8 GiB Docker VM，使用声明 2 CPU、4 GiB 的任务：

- 即使请求 `max_concurrent=8`，同时运行的 trial 不超过 2；
- 连续 20 个 trial 不出现由超卖导致的 OOM；
- 相同环境只发生一次有效构建，其余命中或等待同一构建；
- terminal 后 60 秒内无属于该 eval 的运行中/已停止遗留容器和网络，cleanup failure 除外且必须可见；
- 所有 valid trial 都能通过 `bundle verify`；
- invalid trial 不被聚合为零 reward。

## 26. 验收标准

本规范完成必须同时满足：

- [ ] eval 可以通过 daemon API 提交、查询、跟随、取消和恢复。
- [ ] 全局资源预留覆盖多个并发 eval，而不是只限制单个 Harbor job。
- [ ] `max_concurrent` 不可突破 CPU、内存、容器和 backend safe parallelism。
- [ ] 不同任务可并行，同一 collision domain 内的同任务 attempt 默认互斥。
- [ ] 相同 image build 被内容寻址和 keyed lock 去重。
- [ ] Harbor 仍是 task/environment/Verifier 语义权威。
- [ ] verifier-only retry 永不重跑 Candidate Agent。
- [ ] daemon/worker 崩溃恢复不会产生重复权威 run。
- [ ] reaper 只清理带正确 root/lease/epoch 所有权的资源。
- [ ] 现有 immutable Harness artifact 和 controller runtime 机制未被旁路。
- [ ] 每个新 sealed run 都能生成并验证 Result Bundle index。
- [ ] 模型代理是可选能力，关闭时不影响现有 Agent。
- [ ] credentials 不进入构建缓存、控制记录、事件或结果包。
- [ ] legacy direct eval 和历史记录继续可读。
- [ ] 完整 TypeScript、architecture、syntax 和 test suite 通过。

## 27. 明确设计决策

以下决策在本规范中已确定，实施时无需再次选择：

1. Hitch 采用 companion control plane，而不是 Harbor fork。
2. Harbor 继续拥有 task、environment 和 Verifier 语义。
3. 首个 provider 是本机 Docker，远程 worker 渐进加入。
4. 资源调度使用向量预留，不能只使用一个并发整数。
5. `max_concurrent` 是 per-eval 上限，不是全局资源许可。
6. 同一 collision domain 内的同任务 attempt 默认串行，直到 Harbor/provider 组合 canary 证明可安全并行。
7. BuildKit 构建和普通 trial 使用独立 lane。
8. 环境镜像身份使用 OCI digest，不使用 mutable tag 作为权威 identity。
9. Shared Runtime 扩展现有 ControllerRuntimeBundle，不再创建一套运行时分发系统。
10. provider-native trajectory 和 model interaction capture 是互补证据，不能互相替代。
11. Result Bundle 使用 additive `bundle.index.json`，不破坏现有 RunRecordV1。
12. Training-data Candidate 是只读派生物，不反向修改 eval/run。
13. `0.3.x` 中 daemon eval 为 opt-in，direct mode 保持兼容。

## 28. 后续独立规范

以下内容需要在对应阶段前补充独立实现规范，但不阻塞阶段 0—2：

- Remote worker transport、认证和 artifact upload 协议；
- 具体 OCI registry cache 的部署与 retention policy；
- 各 Agent provider 的 model proxy endpoint 配置矩阵；
- Training-data Candidate 的组织级许可、隐私和 retention policy；
- Harbor 新版本 capability/canary 矩阵。

这些规范只能细化机制，不能改变本文定义的权威边界、资源不变量、Candidate retry 语义和 sealed Result Bundle 原则。

## 29. 风险、降级与回滚

| 风险 | 检测 | 降级/缓解 |
| --- | --- | --- |
| control plane 故障阻塞全部 daemon eval | health、queue age、recovery events | 保留 direct mode；修复后从持久 control/lease 恢复，不复制提交 |
| 资源估计偏低导致内存压力 | Docker stats、OOM event、worker degraded | 降低 effective parallelism，更新 operator 默认；不自动提高 |
| task mutex 过于保守 | mutex wait 指标、不同 collision domain 对比 | 允许跨独立域并行；仅以 canary 解锁同域并行 |
| 预构建 image 与 Harbor 实际运行 image 不一致 | 启动后检查 container image digest | work item 失败为 `environment_image_mismatch`，切回 backend build 诊断 |
| BuildKit/registry cache 不稳定 | cache error rate、build lease age | `prebuild-preferred` 可降级到受 mutex 保护的 backend build；required 模式不降级 |
| model proxy 改变 Agent 行为 | A/B canary、native/proxy trajectory 差异 | 默认 `native`；单 eval 可关闭 proxy；required 模式明确失败 |
| remote worker 失联造成重复 Candidate | lease TTL、epoch、provider recovery probe | ambiguous 默认 invalid，不自动重跑 |
| bundle index 新逻辑影响结果发布 | bundle verify 和 legacy fixture | feature flag 暂停生成新 index；现有 run 文件格式不回滚、不重写 |

阶段性回滚规则：

1. 阶段 1—2 可以停止使用 `--daemon`，回到现有 direct eval；有 active lease 时必须先取消或完成恢复，不能并行启动同一 eval 的 direct 副本。
2. 阶段 3 可以将 build mode 设为 `backend`，但仍保留全局 build slot 和 task mutex。
3. 阶段 4 可以禁止 remote worker admission，只使用 `local-docker`；已接受的远程 lease 必须先进入 terminal/recovered 状态。
4. 阶段 5 可以将 capture 设为 `native` 或 `off`；已 sealed bundle 不删除已有 interaction evidence。
5. 所有回滚都只能关闭新路径，不能修改历史 identity、重写 sealed run 或把 invalid observation 改成零 reward。
