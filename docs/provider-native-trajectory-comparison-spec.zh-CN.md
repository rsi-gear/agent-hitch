# Hitch 以 Run 为中心的 Provider-Native 轨迹存储规范

- 状态：Draft
- 版本：V1

## 1. 摘要

Hitch MUST 将每次实际执行都保存为一个独立的 `RunRecord`。`RunRecord` 是轨迹、执行结果以及比较元数据的唯一事实来源。

每个 run MUST 通过一个 `context` 字段说明它执行的任务范围：

1. `benchmark_task`：holdout validation set 中的 benchmark task；
2. `seed_task`：train set 中允许被 RSI、模型或 harness 看到的 seed task；
3. `ad_hoc`：不属于上述集合的普通运行。
4. `benchmark_phase`：多阶段 benchmark 的一次独立候选会话；不单独计整题分数，见第 18 节。

Eval 不定义另一套轨迹存储。单会话 trial MUST 形成一个普通的 `RunRecord`；多阶段 trial 的每次候选会话仍形成各自的 `RunRecord`。Group 只保存引用，不拼接或复制这些会话的轨迹。现有单 run `EvalResult` 的计分规则保持第 9 节约束，多阶段评分接入另按第 18 节完成验收。

本规范不要求把物理目录组织为 `benchmark/task/model/harness`。物理存储 MUST 以 `run_id` 为主键；benchmark、task、model 和 harness 视图由索引或查询生成。

## 2. 规范用语

关键词 MUST、MUST NOT、SHOULD、SHOULD NOT 和 MAY 表示规范要求。

- `RunRecord`：一次实际 agent 执行的完整持久化记录。
- `SeedTask`：train set 中的任务，允许被训练或迭代过程观察。
- `BenchmarkTask`：holdout validation set 中的任务，用于质量比较和 promotion 判断。
- `Provider-native trajectory`：尽可能保留 provider 原始事件类型、字段、顺序、ID 和 payload 的轨迹。
- `Strict comparison`：除待比较维度之外，所有影响结果的 identity 均一致的比较。

`SeedTask` 与 `BenchmarkTask` 是两个不同的领域概念，MUST NOT 通过给同一个通用 `Task` 增加标签来混用。

## 3. 目标与非目标

### 3.1 目标

V1 MUST 支持：

- 给定精确 harness revision，比较不同模型在同一个 `BenchmarkTask` 上的表现；
- 给定精确模型，比较不同 harness revision 在同一个 `BenchmarkTask` 上的表现；
- seed task 集合持续变化时，记录每个模型或 harness 实际运行过哪些 `SeedTask`；
- direct run、RSI/training run 和 eval trial 使用同一种 run 存储格式；
- disposable container 被销毁后，Hitch 仍能读取完整轨迹和结果；
- agent 从机器可读记录中判断两个 run 是否可比，并说明不可比原因。

### 3.2 非目标

V1 不定义：

- 面向人类的轨迹页面或可视化；
- `ExperimentPlan`、`Condition` 或完整实验编排系统；
- 固定不变的全局 seed set snapshot；
- activity graph、annotation、人工 review 等派生对象；
- 全局 CAS、跨 run 去重或垃圾回收协议；
- 自动决定某个 harness 或模型是否应该 promotion。

这些能力以后可以基于 `RunRecord` 增加，不应成为保存一次 run 的前置条件。

## 4. 核心模型

V1 只有两个必须持久化的核心记录：

```text
BenchmarkTask ─┐
               ├─> RunRecord ─> Provider-native trajectory
SeedTask ──────┤       │
               │       └──────> Result
Ad-hoc ────────┘

EvalResult ────────────> run_id[]
```

`RunRecord` 是逻辑聚合，不要求所有字段位于同一个 JSON 文件中。Hitch 当前的 `request.json`、`resolution.json`、`manifest.json`、`result.json` 和轨迹文件共同构成一个 `RunRecord`。

## 5. RunContext

### 5.1 Schema

每个新 run 的 `manifest.json` MUST 包含以下 discriminated union：

```ts
type Sha256 = `sha256:${string}`

type RunContextV1 =
  | {
      kind: 'ad_hoc'
    }
  | {
      kind: 'seed_task'
      seed_task_id: string
      seed_task_digest: Sha256
      seed_set_id?: string
      seed_set_revision?: string
      iteration_id?: string
    }
  | {
      kind: 'benchmark_task'
      benchmark_id: string
      benchmark_revision: string
      task_id: string
      task_digest: Sha256
      verifier_identity: Sha256
    }
```

### 5.2 字段语义

`ad_hoc` 表示普通交互或没有可验证 task identity 的 run。它可以保存轨迹，但不能参加 strict benchmark comparison。

`seed_task` 表示 train set 运行：

- `seed_task_id` 是 seed task 在其来源中的稳定名称；
- `seed_task_digest` 是本次实际输入 task artifact 的内容摘要；
- `seed_set_id` 和 `seed_set_revision` 只用于说明来源集合，MAY 省略；
- `iteration_id` MAY 关联一次 RSI/training iteration，但不引入新的持久化实体。

`benchmark_task` 表示 holdout validation 运行：

- `benchmark_id` 是 benchmark 的稳定名称，例如当前 Harbor `dataset`；
- `benchmark_revision` MUST 是不可变 revision、commit 或 snapshot identity，不能是 `latest`；
- `task_id` 是该 revision 内的稳定 task 名称；
- `task_digest` MUST 覆盖实际 task instruction、初始 workspace/artifact 以及决定任务语义的配置；
- `verifier_identity` MUST 标识实际执行的 verifier 代码和评分配置。

同名 task 但 `task_digest` 不同，MUST 视为不同任务。同一 task 但 `verifier_identity` 不同，MUST NOT 进入 strict comparison。

### 5.3 Context 的写入者

- 普通 `hitch run` 未提供 context 时 MUST 写入 `{ "kind": "ad_hoc" }`；
- RSI/training 调用方 MUST 写入 `seed_task` context；
- eval backend/bridge MUST 为每个 trial 写入 `benchmark_task` context；
- 调用方提供的 context MUST 在 agent 启动前完成校验并写入初始 manifest；
- run 开始后，context 的 identity 字段 MUST NOT 被修改。

Benchmark context SHOULD 只由受信任的 evaluator 写入，避免普通调用方把已暴露的 seed task 伪装成 holdout task。

## 6. RunRecord

### 6.1 必须保存的信息

每个 run MUST 能解析出以下信息：

```ts
interface RunRecordV1 {
  run_id: string
  context: RunContextV1
  parent?: {
    kind: 'eval'
    eval_id: string
    trial_id: string
    attempt: number
  }
  status: 'queued' | 'preparing' | 'running' |
          'succeeded' | 'failed' | 'timed_out' | 'cancelled'

  harness: {
    harness_id: string
    requested_ref: string
    revision_identity: Sha256
    artifact_id?: Sha256
    agent_args_sha256?: Sha256
  }

  model: {
    provider?: string
    requested_id: string
    effective_id: string
    parameters_sha256?: Sha256
  }

  protocol: {
    timeout_ms: number
    workspace_mode: string
    initial_workspace_digest?: Sha256
    environment_identity?: Sha256
    tool_policy_sha256?: Sha256
  }

  observation?: {
    status: 'valid' | 'invalid'
    reward?: number
    verifier_result_ref?: string
    invalid_reason?: string
  }

  request_ref: string
  resolution_ref: string
  result_ref?: string
  trajectory_ref?: string
  created_at: string
  completed_at?: string
}
```

这是逻辑 schema。实现 MAY 保留当前 manifest 的扁平字段，但 MUST 能无歧义地投影为上述结构。

### 6.2 Identity 要求

Harness identity 至少由以下字段共同确定：

```text
(harness_id, revision_identity, artifact_id, agent_args_sha256)
```

`revision_identity` MUST 来自 Hitch 的 immutable harness resolution。仅记录用户输入的分支名、版本范围或安装态名称不足以进行 strict comparison。

Model identity 至少由以下字段共同确定：

```text
(provider, effective_id, parameters_sha256)
```

如果 provider 返回了实际 model snapshot/version，adapter MUST 写入 `effective_id`。如果 provider 只接受并返回可变 alias，Hitch MUST 保留该 alias，但比较器 MUST 将 model identity 标记为未完全解析，而不能假装它是精确版本。

`parameters_sha256` SHOULD 覆盖 temperature、top-p、reasoning effort、max tokens、system/developer 配置以及其他会影响模型行为的参数。秘密值 MUST NOT 直接写入摘要输入或持久化文件。

Protocol identity 由所有不属于 model、harness、task 或 verifier，但可能影响结果的执行配置组成。V1 至少 MUST 保存 timeout 和 workspace mode；能够解析 environment、初始 workspace 或 tool policy 时 SHOULD 保存对应 identity。

### 6.3 状态与失败

Run directory MUST 在实际执行开始前创建。因此失败、超时和取消也会产生 `RunRecord`。

- agent 正常完成但 verifier 给出 0 分，是有效 benchmark observation；
- 基础设施失败、取消或 verifier 缺失不是 0 分，属于无效 observation；
- 比较器 MUST 单独报告无效 run，MUST NOT 静默丢弃或转换为 0 分；
- terminal run 的 manifest、result 和 trajectory 引用一旦 sealed，MUST NOT 原地改写。修复或重新导入应产生新 run 或显式 migration record。

每个 terminal `benchmark_task` run MUST 有 `observation`。完整 verifier 输出
MUST 保存在该 run 目录内；`reward` MAY 被 EvalResult 冗余缓存，但 RunRecord
中的 observation 是权威值。

## 7. Provider-Native 轨迹

### 7.1 权威关系

每个支持原生事件输出的 adapter MUST 保存 provider-native trajectory。Provider-native 文件是行为分析的首选证据。

当前 DSH-compatible canonical session MAY 继续保存，用于统一工具、feedback 和兼容性；它是 provider-native 数据的派生视图，不取代原始记录。

当 provider 无法输出结构化原生事件时，Hitch MAY 保存 `normalized` 或 `minimal` 轨迹，但 MUST 显式记录 fidelity，MUST NOT 将其标记为 provider-native。

### 7.2 TrajectoryRef

```ts
interface TrajectoryFileRefV1 {
  role: 'provider_events' | 'provider_transcript' |
        'provider_artifact' | 'canonical_session'
  path: string
  media_type: string
  sha256: Sha256
  bytes: number
}

interface TrajectoryRefV2 {
  schema_version: '2'
  run_id: string
  fidelity: 'provider_native' | 'normalized' | 'minimal'
  provider?: string
  provider_session_id?: string
  files: TrajectoryFileRefV1[]
  redactions?: Array<{
    rule_id: string
    count: number
  }>
}
```

要求：

- `path` MUST 相对 run directory，MUST NOT 保存容器或宿主机绝对路径；
- `files` MUST 按实际读取顺序列出组成轨迹的文件；
- 每个文件 MUST 有 SHA-256 和字节数；
- provider 的事件类型、原始 ID、顺序、tool call/result 关联和 payload SHOULD 原样保留；
- Hitch 增加的 envelope 字段 MUST 与 provider payload 分离；
- 如因安全策略发生 redaction，规则和计数 MUST 可见，不能静默修改原始语义。

## 8. 物理存储布局

规范布局如下：

```text
<state-root>/
  runs/
    <run-id>/
      request.json
      resolution.json
      manifest.json
      result.json
      events.jsonl
      trajectory.ref.json
      verifier/
        result.json             # benchmark_task run only
      trajectory/
        provider/
          ... provider-native files ...
        canonical/
          ... optional canonical session ...

  evals/
    <eval-id>/
      request.json
      resolution.json
      result.json
      events.jsonl

  indexes/                    # optional，可重建
    benchmark/...
    seed-task/...
```

`runs/<run-id>/` 是唯一权威副本。`indexes/` MAY 提供 `benchmark/task/model/harness` 或 `seed_task/model/harness` 视图，但索引 MUST 可从 run manifests 重建，MUST NOT 保存唯一轨迹副本。

不采用 `benchmark/seed-task/model/harness` 作为物理层级，原因是：

- seed task 不属于 benchmark，它属于 train set；
- 同一个 run 同时受 model、harness、protocol 和 iteration 等多个维度影响，不存在唯一自然目录层级；
- run-based storage 避免在 seed set 变化或重新分类时移动、复制轨迹。

## 9. EvalResult

Eval 是 run 的编排与聚合层，不是另一种执行记录。

```ts
interface EvalTrialRefV1 {
  trial_id: string
  run_id: string
  task_id: string
  attempt: number
  observation_status: 'valid' | 'invalid'
  reward?: number
  verifier_result_ref?: string
  invalid_reason?: string
}

interface EvalResultV1 {
  schema_version: '1'
  eval_id: string
  benchmark_id: string
  benchmark_revision: string
  status: 'succeeded' | 'failed' | 'cancelled'
  trials: EvalTrialRefV1[]
  started_at: string
  completed_at: string
}
```

当前单 run `EvalTrialRefV1` 中，每个 `trials[*].run_id` MUST 指向一个存在的 `runs/<run-id>/manifest.json`，且该 run：

- `context.kind` MUST 为 `benchmark_task`；
- `parent.eval_id` MUST 等于当前 `eval_id`；
- task、attempt 和 verifier identity MUST 与 trial 一致。

`verifier_result_ref` MUST 指向对应 run 目录下的相对路径。EvalResult 中冗余的
`reward` 和 `observation_status` MUST 与 RunRecord 完全一致；不一致时该 eval
记录损坏，不能进入 strict comparison。

Eval directory MUST NOT 复制 run trajectory。Backend 自己的原始日志 MAY 保留在 eval directory 中，但不能取代 `RunRecord`。

## 10. 写入与导入流程

### 10.1 Direct、RSI 与 training run

1. Hitch 分配 `run_id`；
2. 校验 `RunContext`；未提供时使用 `ad_hoc`；
3. 创建 run directory 并写入 request、初始 manifest 和 resolution；
4. 执行 agent，同时流式记录 provider-native 事件；
5. 写入 trajectory files、checksums、`trajectory.ref.json` 和 `result.json`；
6. 最后将 manifest 更新为 terminal status 并 seal。

RSI 新增 seed task 时不需要修改旧目录或建立新的全局 snapshot。对新 task 的每次运行直接创建新的 `RunRecord`，写入其 `seed_task_id` 和 `seed_task_digest`。

### 10.2 Eval 与 disposable container

Harbor 等 disposable backend MUST 对每个 trial 执行以下流程：

1. 在启动 trial 前分配全局唯一 `run_id`；
2. 将完整 `benchmark_task` context 和 eval parent 信息传入容器；
3. 容器内按标准 run layout 记录 provider-native trajectory、verifier output 和 result；
4. trial 结束后，将整个 run bundle 导出到宿主机 staging directory；
5. 校验所有必需文件、run identity 和 trajectory checksums；
6. 原子发布为 `runs/<run-id>/`；
7. 将 `run_id` 写入 `EvalResult`；
8. 只有步骤 6 成功后才能销毁容器。

导出失败时 eval trial MUST 标记为 invalid，并保留可诊断的失败记录；不能只返回 reward 后丢弃轨迹。

## 11. Strict Comparison Contract

### 11.1 Benchmark task identity

Strict comparison 只接受 `context.kind = 'benchmark_task'` 的 run。

两个 run 的 benchmark task identity 相同，当且仅当以下字段全部相等：

```text
(benchmark_id, benchmark_revision, task_id, task_digest, verifier_identity)
```

比较器 MUST 使用这些 identity 字段，而不能只按展示名称、prompt 文本或目录名匹配。

### 11.2 固定 harness revision，比较模型

比较不同模型时，纳入同一 comparison group 的 runs MUST 满足：

- benchmark task identity 完全相同；
- harness identity 完全相同；
- protocol identity 完全相同；
- 只有 model identity 允许不同。

概念查询：

```text
filter context.kind = benchmark_task
filter benchmark_task_identity = X
filter harness_identity = H
filter protocol_identity = P
group by model_identity
```

### 11.3 固定模型，比较 harness revision

比较不同 harness revision 时，纳入同一 comparison group 的 runs MUST 满足：

- benchmark task identity 完全相同；
- model identity 完全相同；
- protocol identity 完全相同；
- 只有 harness identity 允许不同。

概念查询：

```text
filter context.kind = benchmark_task
filter benchmark_task_identity = X
filter model_identity = M
filter protocol_identity = P
group by harness_identity
```

### 11.4 比较输出

比较器至少 MUST 输出：

- 两侧或各组纳入的 `run_id`；
- 每组有效 observation 数量、reward/score 汇总和 agent failure 数量；
- 被排除的 `run_id`、数量和明确原因；
- 所有未能精确解析的 identity；
- 是否满足 strict comparison。

推荐的排除原因码：

```text
not_benchmark_task
benchmark_revision_mismatch
task_digest_mismatch
verifier_identity_mismatch
harness_identity_mismatch
model_identity_mismatch
protocol_identity_mismatch
model_identity_unresolved
trajectory_missing_or_corrupt
verifier_result_missing
infrastructure_failure
cancelled
```

V1 不要求把 comparison result 本身永久保存；它可以由查询实时生成。

## 12. 可变 Seed Task 集合

V1 不要求固定 seed task 集合，也不要求每次迭代产生完整 `SeedSetSnapshot`。

规则如下：

- 每次 seed run 只引用它实际执行的 `seed_task_id` 和 `seed_task_digest`；
- 新增 seed task 只会新增 run records，不会改变旧 run 的身份；
- 同名 seed task 内容改变时，digest 必须改变；
- 如果需要知道某次 RSI iteration 使用了哪些 seed tasks，可按 `iteration_id` 查询当时的 runs；
- 如果需要比较两个 iteration 在共同 seed tasks 上的行为，可按 `seed_task_digest` 取交集；
- seed task 的表现不能用于 strict holdout benchmark comparison，也不能与 benchmark task 仅凭内容相同就合并。

Seed task 记录用于回答“模型/harness 训练时实际看过和跑过什么”，BenchmarkTask 记录用于回答“模型/harness 在未暴露 validation 上表现如何”。二者的统计语义必须保持分离。

## 13. 查询与索引

实现 MUST 能按以下字段查询 runs：

- `run_id`；
- `context.kind`；
- benchmark ID、revision、task ID 和 task digest；
- seed task ID、digest 和可选 iteration ID；
- harness ID 与 revision identity；
- model provider、requested/effective ID；
- eval ID；
- status 和时间范围。

索引是派生数据。删除索引后，系统 MUST 能通过扫描 `runs/*/manifest.json` 重建。

## 14. 完整性与安全

- 持久化引用 MUST 使用相对路径和内容摘要，不能依赖已销毁容器路径；
- 所有 JSON MUST 使用 UTF-8；所有 JSONL 文件每行 MUST 是一个完整 JSON value；
- trajectory checksum 不匹配时，该 run MUST 标记为 corrupt，不能进入 strict comparison；
- secret、token 和 credential MUST NOT 写入 manifest、query index 或 provider-native trajectory；
- 若 provider payload 可能含秘密，adapter MUST 在写盘前执行明确的 redaction policy；
- benchmark task payload 和 trajectory 可能泄露 holdout 内容，访问控制 SHOULD 至少与 benchmark 本身一致；
- 将一个已暴露的 `SeedTask` 重标为 `BenchmarkTask` 不会恢复 holdout 属性，MUST 禁止作为 strict validation evidence。

## 15. 兼容与迁移

现有 direct runs 可以按以下规则迁移：

- 没有可靠 task 来源时补写 `context.kind = 'ad_hoc'`；
- 已知来自训练集合且能恢复 task digest 时补写 `seed_task` context；
- 只有能恢复不可变 benchmark revision、task digest 和 verifier identity 的历史 eval trial，才能补写 `benchmark_task` context；
- 无法恢复精确 identity 的历史记录 MAY 保留并用于人工查看，但 MUST NOT 进入 strict comparison。

现有 `trajectory.ref.json` schema V1 和 DSH session MAY 继续读取。新增 provider-native capture 使用新的 ref schema；迁移不应伪造过去不存在的 native fidelity。

## 16. 验收标准

V1 实现完成必须满足：

1. 每个 direct run、seed run 和 eval trial 都能通过 `run_id` 在 `runs/` 下找到唯一记录；
2. 每个 run 都有且只有一个合法 `RunContext`；
3. eval 的每个 trial 都引用一个标准 `RunRecord`，容器销毁后轨迹仍可读取并通过 checksum；
4. 给定 harness revision、benchmark task 和 protocol，查询能按 model identity 分组并比较结果；
5. 给定 model identity、benchmark task 和 protocol，查询能按 harness identity 分组并比较结果；
6. task、verifier、model、harness 或 protocol identity 不匹配时，比较器拒绝 strict comparison 并返回具体原因；
7. seed task 新增或变更无需迁移旧 runs，且可按 task digest/iteration 查询；
8. seed runs 和 ad-hoc runs 不会进入 strict benchmark metrics；
9. normalized/minimal 轨迹不会被错误声明为 provider-native；
10. 所有派生索引均可从 run manifests 重建。

## 17. V1 决策总结

V1 的核心决策是：

> 一次实际执行就是一个 run；run 保存自己执行的 context、精确 harness/model/protocol identity、result 和 provider-native trajectory。Eval 只聚合 run，比较只是对 run records 的受控查询。

因此，V1 不需要先构建复杂的 experiment hierarchy。以后若需要实验计划、seed set snapshot 或可视化，它们都应引用 `run_id`，而不是创建第二套轨迹事实来源。

## 18. 多阶段候选会话补充（实施中）

OSWorld 等任务的原生 runner 会在同一环境中多次重置候选会话。每次重置后的执行 MUST 保存为独立 run，使用 `benchmark_phase` context：除原有 benchmark/task/verifier identity 外，要求 `run_group_id = run_group_<32 hex>` 和从 1 开始的 `phase_index`，并要求 eval parent。其 context 必须在启动前确定，不能在运行后把普通 task 改成 phase。

阶段 run MUST NOT 带独立 `observation`。成功、失败、超时或取消均保持实际进程状态和自身轨迹，正常封存 bundle；不使用 `defer_benchmark_observation`，也不因没有独立 verifier 而伪造一条 invalid benchmark observation。查询可按 benchmark/task/eval 找到这些 run，但现有单 run strict comparison 和训练候选派生 MUST 排除它们。

`inspectBenchmarkPhaseGroup`、`sealBenchmarkPhaseGroup` 和 `readBenchmarkPhaseGroup` 已提供有序阶段证据集合。Group 文件位于 `evals/<eval-id>/run-groups/<run-group-id>/group.json`，schema 为 `benchmark-phase-group.schema.json`；只引用原 `runs/` 的 bundle digest/index digest 与 native session ID。成员必须从 phase 1 连续排列，属于同一 trial/attempt、benchmark、task ID 与冻结 task digest、verifier、harness/model identity；执行时间不重叠，session ID 不重复，记录与轨迹均通过完整性校验。读取 group 时重新检查全部成员，封存后的 group 不允许用不同成员或证据覆盖。

该集合的 scope 固定为 `candidate-evidence-only`，不含 reward/observation。**连续编号和不同 session ID 不证明原生任务已完成，也不能独自证明没有恢复旧上下文。** 当前单 run 导入器拒绝把 phase run 当成完整 trial；多阶段整题评分仍未接通。后续 supervisor/导入器必须：

1. 在每次原生 reset 后准备独立候选环境、runtime 和日志挂载，防止后续候选读取旧阶段 prompt、scratch 或轨迹；销毁旧候选进程及其后台子进程后才启动下一会话，保留原生 VM/网站的阶段状态。
2. 在启动前私有绑定 `run_id`，仅把当前阶段的 instruction、观察和工具绑定交给候选；禁止恢复/分叉旧模型会话，记录实际 native session ID 和运行命令配置。
3. 按原生 controller 的 reset/gate/terminal 证据核对**全部已执行阶段**，不能把调用者提供的任意 prefix group 当成完整任务。
4. 将原生最终评分与完整 group 关联为独立 trial assessment；模型中断、阶段边界停止和真实执行错误要依照明确的 native completion 证据区分，不能仅看进程 exit code。
5. 原 phase bundle 原样导入并保持已封存的 digest；额外的 trial resource、controller 和 grading 证据写入 group/trial assessment，不回写旧 phase manifest。所有 phase bundle 和 group 校验成功后才发布整题结果；不得取第一个 bundle、复制整题分数到每个 phase，或丢掉失败阶段。

当前测试通过实际 Hitch 执行器启动合成 harness 进程，验证独立 copy workspace、独立 session 标识、不可变 group、错误身份/顺序/篡改拒绝和计分排除。它未执行真实模型、OSWorld VM 或官方任务，不计作 benchmark 两题验收。

通用 `NativePhaseSupervisor` API 现已串起私有 native state/bind/cancel、候选 prepare/run/cancel、容器回收、重新 setup 与绑定。它在容器退役后调用 `inspectSealedPhaseRunBundle`，检查原始 task/context/parent、harness revision、bundle、trajectory 及会话/时间一致性；完整阶段列表与原生边界写到候选不可见的 `hitch-native-phases/supervision.json`，scope 仍为 `candidate-evidence-only`。整题预算不会逐阶段重置，退出但尚有待答 observation 的候选不会被另一会话续跑。最后阶段停止 `main` 并走最终 snapshot，异常走整题 cleanup。实际 Hitch CLI + 原生函数/RPC 的合成测试通过；容器替换在该编排测试中由本地目录模拟，真实 Docker 的独立 recycler canary 不能替代整体 VM 验收。标准包入口和上述第 3–5 项的整题 assessment 导入仍待完成。
