# Hitch Eval 调度与吞吐优化实现规范

状态：Draft
日期：2026-09-04
适用范围：Hitch managed benchmark eval、local/remote execution provider，以及调用 Hitch 的 Evolution 编排层
依赖规范：`hitch-harbor-control-plane-spec.zh-CN.md`

## 1. 摘要

本规范解决 Hitch 在任务级并行已经可用的前提下，实际端到端吞吐仍受长尾、重试屏障和阶段串行限制的问题。

核心改动为：

1. 将 `executePlannedHarborTasks` 从“全部首轮完成后统一重试”改为事件驱动的物理执行队列。
2. 使用历史时长和首次物化的 Evolution Baseline 时长估计任务关键路径，优先启动长任务，短任务回填。
3. 每个 trial 完成后立即进行稳定错误分类；只有明确可重试的基础设施失败才生成新的 physical retry work item。
4. 所有 retry 使用唯一 `work_id`、重新经过全局资源 admission、collision mutex 和 execution lease。
5. Candidate 证据已确定不可形成有效 observation 时，不再启动昂贵 Verifier；Agent timeout 本身不是跳过条件。
6. Evolution 第一次运行时只提交一次 Seed/Heldout Baseline，并将其作为不可变基准绑定到后续 Candidate rounds。
7. 后续 round 只提交 Candidate eval；不得重复提交或重算 Baseline。

本规范不改变 Harbor 对 task、environment、Verifier 和 reward 的语义权威，也不允许因吞吐优化而放宽证据完整性或自动重跑 Candidate。

## 2. 动机与基线

动机实验：

- Evolution ID：`bb14b103-569d-4192-b9d1-51b26dc65a84`
- Batch ID：`b8229968-f138-44b3-b1f3-39fc8834990e`
- Round ID：`52466690-5f1a-4146-8d77-a78fa1680797`

该轮实验的观测基线：

| 指标 | 观测值 |
| --- | ---: |
| 端到端时间 | 9 小时 14 分钟 |
| 四个 eval 阶段墙钟时间 | 9 小时 10.2 分钟 |
| 原始逻辑 trial | 128 |
| physical retry | 14 |
| 累计 physical trial 时间 | 43.04 小时 |
| 配置最大并发 | 10 |
| 实际平均并发 | 4.69 |
| 10 槽整体利用率 | 46.9% |
| Agent 执行占比 | 91.8% |
| 环境 setup 占比 | 0.2% |
| retry 占累计任务时间 | 18.2% |

关键症状：

- Seed Candidate 有约 49.6 分钟只剩一个 active trial。
- Heldout Baseline 有约 70.3 分钟只剩一个 active trial。
- Seed Candidate 的首轮任务约 89.7 分钟结束后，才启动最长 105.8 分钟的 retry。
- `regex-chess` 的一次 Candidate retry 在 Agent 已无法形成可导入 bundle 后，Verifier 仍消耗约 44.6 分钟。
- Heldout Candidate 的五次失败均为 provider quota exhausted，重试不能恢复。

基于该轮实际时长的十槽离线回放：

- 仅使用长任务优先调度，eval 墙钟时间预计由 9.17 小时降至约 7.98 小时。
- 长任务优先、即时 retry，并将 Baseline 限定为首次一次性物化后，首次端到端预计不超过约 7 小时；后续 Candidate-only round 会进一步缩短。
- 若同时消除不可形成有效 observation 的昂贵 Verifier，预计约 6 小时 15 分钟。

以上数字用于定义性能验收，不构成线上耗时承诺。

## 3. 目标

### 3.1 功能目标

1. 已知 task membership 的 benchmark eval 必须以单 task slot 或小型同质 shard 作为 admission 单元。
2. 一个 trial 的首轮 physical execution 终止后，不等待同 eval 的其他首轮任务即可分类和调度 retry。
3. 任务调度必须支持稳定、可解释、可恢复的关键路径优先级。
4. local 和 remote provider 使用相同 retry decision 与优先级语义。
5. provider quota、认证、配置错误不得进入自动 physical retry。
6. 所有动态 retry 在 daemon 重启后只能恢复、收集或重新排队一次，不得产生重复 Candidate execution。
7. 相同 collision domain 中同 task attempt 的互斥不变。
8. Baseline 必须按 Evolution lineage 和 exact fingerprint 执行一次性物化；后续 Candidate round 只能引用该 Baseline。
9. 首次物化时，Seed Baseline 与 Heldout Baseline 可以共享 Hitch 全局资源池并发执行，但 Heldout 结果必须与 Meta Agent 隔离。

### 3.2 性能目标

在本规范附带的固定 trace replay 中：

- 十槽端到端 makespan 不高于 425 分钟，包括 221 秒 Meta Agent 阶段。
- 首次含 Baseline 物化的 trace replay 端到端 makespan 不高于 425 分钟。
- 后续 Candidate-only round 的 trace replay makespan 不高于 240 分钟。
- 后续 round 的 Baseline eval submission 数为 0。
- 只要存在能够满足当前资源向量和 collision 约束的 ready work，调度器空闲槽时间比例不高于 2%。
- retry decision 写入到进入 ready queue 的软件开销 P95 不高于 5 秒，不含显式 backoff 和资源等待。
- 非 transient quota/auth/config 错误的自动 physical retry 数为 0。
- 不可形成有效 observation 的 Candidate 执行之后，task Verifier invocation 数为 0。

### 3.3 正确性目标

- 同一固定输入下，优化前后 valid/invalid、reward 和 authoritative run 选择完全一致；被明确识别为不可重试或不可评分的情况除外，但必须产生新的稳定诊断码。
- 不因优先级、并发或 retry 改变 Candidate 的输入、模型、超时、环境镜像和 Harness artifact。
- 取消、崩溃恢复、迟到事件和 collection 的不变量继续满足控制面主规范。

## 4. 非目标

- 不优化模型本身的生成速度。
- 不修改 benchmark reward、Verifier 逻辑或拒绝策略。
- 不把 Agent timeout 一律视为 infrastructure failure。
- 不通过无条件提高 `max_concurrent` 超卖 CPU、内存、GPU 或 container slots。
- 不允许 scheduler 解析任意异常字符串后直接决定重跑 Candidate。
- 不在不同 benchmark revision、模型配置或环境镜像之间模糊复用 Baseline。
- 不取消 legacy raw Harbor eval；该路径保留兼容，但不承诺达到本规范的吞吐目标。

## 5. 必须保持的不变量

1. Harbor 继续拥有 task、environment、Verifier 和 reward 语义。
2. 每次 Candidate physical execution 都必须有唯一 `work_id`、`lease_id` 和 lease epoch。
3. 每次 Candidate physical execution 都必须重新经过 ResourceLedger 和 task collision mutex。
4. 一个 logical slot 最多存在一个 authoritative valid observation。
5. retry 只能将 invalid observation 替换为 valid observation；不能覆盖既有 valid observation。
6. Verifier infrastructure failure 只能走原 sandbox 的 verifier-only 语义，不能触发 Candidate restart。
7. collection failure 优先恢复或 collect-only；不能静默重跑 Candidate。
8. 无法证明 Candidate 尚未执行时，未知错误默认不得自动启动新的 Candidate。
9. execution plan、retry decision、lease 和 progress 的写入必须原子、版本化且可幂等重放。
10. 优先级只影响执行顺序，不进入 Candidate/reward identity。

## 6. 当前实现差距

### 6.1 已有能力

当前仓库已经具备：

- `task-slots` execution plan；
- CPU、内存、container、build、GPU 和 ephemeral disk 向量 admission；
- 跨 eval deficit round-robin；
- task collision mutex；
- local/remote execution lease 和恢复；
- physical infrastructure retry；
- phase timing 和 effective parallelism 指标。

因此本规范不新增独立控制面。

### 6.2 真实缺口

`src/evals/planned-execution.ts` 当前执行顺序为：

```text
并发执行所有首轮 work item
    -> Promise.all 等待全部首轮结束
    -> 遍历 completed results
    -> 逐项执行 infrastructure retry
    -> finalization
```

这形成 eval 级 retry barrier。与此同时：

- `FairSemaphore` 和 `WorkItemDispatcher` 的 lane 内选择接近 FIFO，没有任务时长优先级。
- local retry 复用原始 `work_id`，remote retry 使用派生 `work_id`，两条路径身份语义不一致。
- `invalid_reason=infrastructure_failure` 粒度不足，provider quota 与真正瞬时基础设施错误无法稳定区分。
- Verifier 启动前没有“最终 observation 是否仍可能有效”的可信 gate。
- Evolution 编排层串行等待两个互相独立的 Heldout eval。

此外，本次阿里云实验保存的 execution plan 只有一个包含整批任务的 work item，而当前仓库的标准 benchmark 入口已经请求 `local-task-slots-v1`。实施前必须确认以下至少一种情况：

- 阿里云部署 revision 落后于当前仓库；
- Evolution 使用了 legacy raw eval 入口而不是标准 benchmark 入口；
- execution plan 在提交、恢复或 provider handoff 中被降级为 attempt shard；
- 线上读取的 plan 与实际执行 binary/runtime 不属于同一 revision。

这属于发布路径一致性缺口。若不先解决，仓库内 task-slot 和 priority 改动可能不会作用到 Evolution 实验。

## 7. 目标架构

```text
Execution Plan
      |
      v
Physical Work Queue <-------- Retry Decision / Recovery
      |
      v
Priority + cross-eval DRR
      |
      v
Resource admission + collision mutex
      |
      v
Local/Remote Provider -> Trial import -> Failure classifier
                              | valid/final
                              +-----------------> Progress
                              | retryable
                              +-----------------> Physical Work Queue
```

调度分为两层：

1. `WorkItemDispatcher` 保留跨 eval DRR，决定哪个 eval 获得下一次公平调度机会。
2. eval lane 内使用预计剩余关键路径降序选择 work item。

这样不会让一个大 eval 饿死小 eval，也不会在同一个 eval 内把 60 分钟任务留到最后。

## 8. Physical Work Queue

### 8.1 Work 类型

新增内部类型：

```ts
interface PhysicalWorkV1 {
  schema_version: "1";
  work_id: string;
  origin_work_id: string;
  eval_id: string;
  slot_id: string;
  task_id: string;
  logical_attempt: number;
  execution_kind: "initial" | "physical-infrastructure-retry";
  physical_execution: number;
  retry_index: number;
  trigger_trial_id?: string;
  not_before?: string;
  reservation: ResourceVectorV1;
  scheduling: SchedulingHintV1;
}
```

`initial` 的 `physical_execution=1`、`retry_index=0`。第 N 次 retry 的 `physical_execution=N+1`、`retry_index=N`。

retry work identity 必须确定性生成：

```text
work_id = H(
  origin_work_id,
  slot_id,
  execution_kind,
  retry_index,
  trigger_trial_id
)
```

local 与 remote provider 使用同一算法。禁止 local retry 继续复用原始 `work_id`。

### 8.2 生命周期

```text
blocked -> ready -> admitted -> leased -> running -> collecting -> terminal
    |                                                        |
    +----------------------------------------------------> skipped
```

- `blocked`：等待依赖、backoff、provider circuit 或同 task 前序 attempt。
- `ready`：可以进入 dispatcher。
- `admitted`：已取得资源和 collision permit，尚未创建或接受 lease。
- `terminal`：结果已导入，或已形成不可重试的稳定 invalid 结果。
- `skipped`：取消、circuit fail-fast 或 Candidate 证据不可评分；必须有稳定原因。

### 8.3 执行循环

`executePlannedHarborTasks` 改为消费物理执行队列：

```ts
while (queue.hasUnfinishedWork()) {
  const work = await queue.takeReady(signal);
  void executeWithAdmission(work).then(async outcome => {
    await publishOrRecordInvalid(outcome);
    const decision = await classifyAndPersist(outcome);
    if (decision.disposition === "physical-retry") {
      await queue.enqueue(retryWork(decision));
    }
    await queue.markTerminal(work, decision);
  });
}
await queue.settleAll();
```

实现可以继续使用 Promise，但不能再以所有 initial Promise 完成为 retry 的前置条件。

## 9. 优先级与时长估计

### 9.1 Scheduling hint

`BackendWorkItemV1` 新增可选字段；旧 execution plan 仍可读取：

```ts
interface SchedulingHintV1 {
  policy: "critical-path-lpt-v1";
  estimated_duration_ms: number;
  remaining_path_ms: number;
  estimate_source:
    | "evolution-baseline"
    | "history-p75"
    | "task-budget"
    | "default";
  estimate_sample_count: number;
}
```

该 hint 在 planning 时写入 execution plan，resume 时不得根据新历史重新计算。

### 9.2 估计来源

按以下顺序选择：

1. 同 Evolution lineage 中，兼容 benchmark revision、task digest、model/provider class 的首次 Baseline 时长；
2. 最近 20 次兼容 physical execution 的 P75；
3. benchmark task 的 Agent budget；
4. operator 默认时长。

历史统计 key：

```text
H(
  benchmark_id,
  benchmark_revision,
  task_digest,
  provider,
  model_provider,
  model_family,
  resource_class
)
```

不得包含 credential value。credential generation 仅用于 provider circuit identity，不进入通用时长统计。

建议持久化位置：

```text
state/scheduler/task-duration-stats/sha256/<digest>.json
```

统计记录只接受已完成 physical execution 的有界 phase timing；异常负值、超大值或不完整 timing 不进入样本。

### 9.3 排序规则

跨 eval 继续使用 DRR。一个 eval lane 获得调度机会后，使用以下稳定元组排序：

```text
1. recovery/collection work 优先于 Candidate execution
2. remaining_path_ms 降序
3. queued_at 升序
4. work_id 字节序升序
```

`remaining_path_ms`：

- initial：当前预计时长加上基于历史 infrastructure retry rate 得到的预计后继时长；
- retry：当前 retry 的预计时长；
- collect-only/recovery：预计 collection 时长。

禁止简单规定“所有 retry 永远高于所有 initial”，避免基础设施故障风暴饿死尚未运行的任务。

### 9.4 Direct mode

daemon 路径通过 `WorkItemDispatcher` 执行上述排序。没有共享 admission controller 的 direct mode 必须将 `FairSemaphore` 替换为支持相同 comparator 的 `PrioritySemaphore`，避免两条入口产生不同执行顺序。

## 10. 即时 retry

### 10.1 决策时点

trial import 或 diagnostic import 完成后立即执行分类。分类不等待同 eval 其他 work item。

处理顺序：

1. 原子发布本次 physical execution 的 diagnostic/observation。
2. 生成稳定 `RetryDecisionV1`。
3. 原子写入 retry state。
4. 若可 retry，将派生 work 放入 `blocked` 或 `ready` 队列。
5. 当前 lease 完成 collection、清理并释放资源。
6. retry 重新取得新的 admission 和 lease。

retry 可以在其他首轮任务仍运行时开始，但不能复用刚结束 physical execution 的资源 lease。

### 10.2 Backoff

- 显式 `Retry-After` 优先。
- 其他 transient failure 使用 exponential backoff with full jitter。
- 基础值为 `max(infrastructure_retry_backoff_ms, 1000)`。
- 默认上限 60 秒。
- `not_before` 必须持久化；daemon 重启不能重新从零计算 backoff。

### 10.3 Retry 数量

`infrastructure_retries` 继续表示每 logical slot 允许的新 Candidate physical execution 上限。

Verifier-only retry 不计入 Candidate physical retry 数，但保留独立 verifier retry history。

## 11. 稳定错误分类

### 11.1 分类记录

新增内部记录：

```ts
interface FailureClassificationV1 {
  schema_version: "1";
  phase:
    | "admission"
    | "setup"
    | "provider"
    | "agent"
    | "verifier"
    | "collection"
    | "cleanup";
  code: string;
  candidate_started: boolean | "unknown";
  retryability:
    | "never"
    | "transient"
    | "other-worker"
    | "verifier-only"
    | "collect-only"
    | "operator-required";
  source: "typed-provider" | "bridge-evidence" | "verifier-evidence" | "controller";
}
```

只有 Adapter、provider bridge、Verifier wrapper 和 controller 可以生成该记录。Scheduler 只能消费稳定字段，不得自行解析无界 stderr。

迁移期间允许在 provider/bridge 边界集中解析已知错误文本，但输出必须立刻归一化为稳定 code，并对文本变体做 fixture 测试。解析逻辑不得放入 scheduler。

### 11.2 默认矩阵

| 错误 | 稳定 code | 自动动作 | Candidate 重跑 |
| --- | --- | --- | --- |
| 余额或 quota 耗尽 | `provider_quota_exhausted` | 不 retry；打开 provider circuit | 否 |
| 凭据缺失/无效 | `provider_auth_failed` | 不 retry；operator required | 否 |
| 模型/参数配置无效 | `provider_configuration_invalid` | 不 retry | 否 |
| 明确 rate limit，带恢复窗口 | `provider_rate_limited` | 等待 `Retry-After` 后有界 retry | 是 |
| transient network/reset | `provider_transport_transient` | 有界 retry | 仅能证明允许重跑时 |
| worker 在 Agent 前丢失 | `worker_lost_before_candidate` | 同 worker 或其他 worker retry | 尚未执行 |
| sandbox setup 失败 | `sandbox_setup_failed` | physical retry | 是 |
| Agent 返回失败 | `agent_failed` | 不自动 retry | 否 |
| Agent 超时 | `agent_timed_out` | 不自动 retry；按 benchmark policy 判断是否评分 | 否 |
| Verifier bootstrap 失败 | `verifier_infrastructure_failure` | 原 sandbox verifier-only | 否 |
| bundle 尚未收集 | `result_collection_pending` | collection retry/恢复 | 否 |
| bundle 缺失或损坏 | `candidate_evidence_unavailable` | invalid，不重跑 | 否 |
| 执行状态不明确 | `execution_state_ambiguous` | operator required | 否 |

### 11.3 Provider circuit breaker

Circuit scope：

```text
H(provider, model endpoint, credential handle, credential generation)
```

不得写入 credential value 或其直接哈希。

状态：`closed -> open -> half-open -> closed`。

- quota/auth/config：默认打开到 credential generation 或配置发生变化；不做自动 half-open Candidate probe。
- rate limit：按照 `Retry-After` 打开，之后允许一个 half-open probe。
- transient transport：连续达到阈值后短期开启，默认 30 秒。

P0 只要求 circuit 阻止同失败 trial 的 retry。阻止尚未开始的同 scope work 属于 P1，必须通过 feature flag 发布，并以明确 eval failure/blocked 状态结束，不能伪造 trial reward。

## 12. Verifier eligibility gate

### 12.1 原则

Agent timeout 不是跳过 Verifier 的充分条件。若 benchmark policy 是 `grade_final_state`，且可信最终状态与完整 Candidate bundle 存在，Verifier 仍必须执行。

只有已经能够证明“无论 Verifier 输出什么，本 physical execution 都不可能成为 valid observation”时，才能跳过 task Verifier。

### 12.2 可信 Agent outcome

`HitchHarborAgent` 在 trial 控制目录写入不可由 Candidate 修改的记录：

```ts
interface TrustedAgentOutcomeV1 {
  schema_version: "1";
  run_id: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  candidate_bundle: "complete" | "missing" | "invalid";
  submission_snapshot: "complete" | "missing" | "not-required";
  gradeability: "gradeable" | "ungradeable";
  reason_code?: string;
}
```

该记录只能在 Hitch result、bundle marker、导出结果和 snapshot 已完成一致性检查后写入。

### 12.3 Verifier 行为

`HitchRetryingVerifier.verify()` 在调用 task Verifier 前读取并验证该记录：

- `gradeable`：保持现有 Verifier 和 verifier-only retry 行为。
- `ungradeable`：不调用 task Verifier，写入 `candidate-ineligible.json`，返回或抛出专用受信诊断。
- 记录缺失：保持兼容路径，但记录 `eligibility_gate=unavailable`，不能擅自跳过。

trial importer 将专用诊断映射为 `candidate_evidence_unavailable`，不能误归类为 `verifier_infrastructure_failure`，也不能触发 Candidate physical retry。

## 13. 资源感知并发

### 13.1 语义

`max_concurrent` / `execution.max_parallelism` 继续是 per-eval 上限，不是资源许可。

实际并发为：

```text
min(
  eval max_parallelism,
  operator container cap,
  ResourceLedger 当前可容纳的 task resource vectors,
  collision constraints,
  provider capacity/circuit constraints
)
```

### 13.2 要求

- 已知 task 必须使用自己的 reservation，不得用整批最坏值预留一个大 work item。
- physical retry 使用原 task 的精确 reservation。
- Verifier-only 和 collect-only 使用各自资源向量，不能预留完整 Candidate 资源。
- 系统必须暴露 requested、admitted、active 和 effective parallelism。
- operator 可以提高轻任务的并发上限，但 ResourceLedger 必须是硬限制。

本规范不规定固定的 12、14 或 16 并发默认值。目标机器应根据 Docker Engine 可用 CPU/内存、系统保留量和 task reservations 计算 operator cap。

## 14. Baseline 一次性物化

Baseline 的所有权属于 Evolution lineage，而不是单个 Candidate round。一个 lineage 在首次运行时执行一次 Baseline materialization；后续 round 只引用已物化结果，不再提交 Baseline eval。当前 Seed/Heldout 分区设计中，一次 materialization 分别创建一个 Seed Baseline eval 和一个 Heldout Baseline eval，二者都只提交一次。

### 14.1 状态机

Evolution 编排层持久化：

```text
absent -> submitting -> running -> ready
                         |
                         +------> failed
```

建议记录：

```ts
interface EvolutionBaselineV1 {
  schema_version: "1";
  evolution_id: string;
  baseline_fingerprint: string;
  state: "submitting" | "running" | "ready" | "failed";
  seed_eval_id?: string;
  heldout_eval_id?: string;
  seed_result_digest?: string;
  heldout_result_digest?: string;
  created_at: string;
  updated_at: string;
}
```

`ready` 必须同时具有可验证的 Seed Baseline 和 Heldout Baseline 引用。Candidate round 不得修改该记录的 eval identity 或 result digest。

### 14.2 Ensure-once

Evolution 使用持久化 singleflight：

```ts
const baseline = await ensureBaseline(evolutionId, fingerprint, async () => {
  const seed = submit(seedBaselineRequest);
  const heldout = submit(heldoutBaselineRequest);
  return await waitAndSeal({ seed, heldout });
});
```

`ensureBaseline` 必须满足：

1. 同一 `evolution_id + baseline_fingerprint` 的并发调用只有一个 materialization owner。
2. `ready` 时只验证并返回已有引用，Hitch submission 数为 0。
3. `submitting/running` 时其他调用等待同一持久化 operation，不创建重复 eval。
4. `failed` 时停止 Candidate round，要求显式 repair/rerun；不得静默提交一个新 Baseline。
5. fingerprint 不一致时拒绝继续当前 lineage；创建新 Baseline generation 必须是显式操作。
6. 基础设施修复使用原 Baseline eval 的 Hitch rerun/collect 语义，不创建第二个 Baseline submission。

### 14.3 首次运行的并发

首次运行时 Seed Baseline 与 Heldout Baseline 彼此没有计算依赖，可以同时提交到同一个 Hitch daemon：

- Meta Agent 只等待 Seed Baseline ready，即可开始生成 Candidate。
- Heldout Baseline 可以在后台继续执行。
- Heldout Baseline 的 task 输出、reward、日志和聚合结果不得进入 Meta Agent prompt、Candidate workspace 或模型 capture。
- Heldout Baseline 只在 Candidate artifact 已冻结后供比较阶段读取。
- 两个 Baseline eval 共享 ResourceLedger 与跨 eval DRR；同 collision domain 的同 task 仍遵守 mutex。

如果当前安全边界不能证明 Heldout 结果隔离，则 Heldout Baseline 可以延后执行，但在整个 Evolution lineage 中仍只能提交一次。

### 14.4 后续 Candidate round

后续 round 的执行图为：

```text
validate stored Baseline
    -> Meta Agent / Candidate generation
    -> Seed Candidate eval
    -> promotion decision
    -> Heldout Candidate eval
    -> compare with stored Heldout Baseline
```

要求：

- 不创建 Seed Baseline 或 Heldout Baseline submission。
- Seed Candidate 可以读取允许暴露的 Seed Baseline summary，但不能读取 Heldout Baseline 内容。
- Heldout Candidate 保持独立 eval ID、Candidate identity 和 bundle lineage。
- 比较记录同时引用 Candidate eval 和首次物化的 Baseline eval。
- Candidate 的 quota、cancel 或失败不得使编排层重新提交 Baseline。

## 15. Baseline identity、验证与跨 lineage 复用

同一 Evolution lineage 内的一次性 Baseline 是强制语义，不是可选缓存。跨 Evolution lineage 复用既有 Baseline 才是 P2 可选能力，默认关闭，因为它可能改变实验之间的统计独立性。

### 15.1 Exact fingerprint

```text
baseline_fingerprint = H(
  harness revision identity,
  artifact id and runtime contract,
  benchmark id/revision,
  task digests and membership,
  verifier identity,
  model effective identity,
  sampling/attempt count,
  agent args digest,
  timeout and setup protocol,
  environment image digests,
  controller runtime id,
  provider/capture mode,
  credential generation,
  scoring policy version
)
```

不得按 commit、benchmark 名称或模型名称单独匹配。一个 lineage 内每次 Candidate round 开始前都必须重新计算 fingerprint，并与首次 Baseline 的持久化 fingerprint 完全相等。

### 15.2 Lineage 内引用

- Candidate round 直接引用 `EvolutionBaselineV1` 中的原始 eval ID 和 result digest。
- 不把 Baseline run 复制或改写成新的 eval ID。
- 每次比较前重新验证 eval result、planned membership、bundle index、Verifier evidence 和 fingerprint。
- 首次 Baseline 有 invalid/missing trial 时，lineage 不得进入 `ready`；只能显式修复原 eval。
- 任何 identity 不一致都必须停止该 lineage，不能退化为重新提交 Baseline。

### 15.3 跨 lineage 复用

- 不把旧 run 复制或改写成新 eval ID。
- Evolution 记录 `BaselineReuseReceiptV1`，引用原始 terminal eval 和 sealed bundles。
- 复用前重新验证 eval result、planned membership、bundle index、Verifier evidence 和 fingerprint。
- 原始 eval 有 invalid/missing trial 时默认不复用。
- 任何 identity 不一致都视为 cache miss，不允许宽松匹配。
- 跨 lineage 复用必须由实验 policy 显式启用；关闭时，新 lineage 首次运行仍提交一次自己的 Baseline。

## 16. 持久化与恢复

### 16.1 Retry state

新增：

```text
evals/<eval-id>/retry-state.json
```

```ts
interface EvalRetryStateV1 {
  schema_version: "1";
  eval_id: string;
  generation: number;
  decisions: RetryDecisionV1[];
  updated_at: string;
}

interface RetryDecisionV1 {
  decision_id: string;
  slot_id: string;
  trigger_trial_id: string;
  trigger_run_id?: string;
  retry_index: number;
  classification: FailureClassificationV1;
  disposition:
    | "physical-retry"
    | "verifier-only"
    | "collect-only"
    | "no-retry"
    | "operator-required";
  retry_work_id?: string;
  not_before?: string;
  state: "planned" | "running" | "repaired" | "invalid" | "skipped" | "exhausted";
  created_at: string;
  updated_at: string;
}
```

数组按 `(slot_id, retry_index, decision_id)` canonical 排序。更新使用 eval lock 和 atomic rename。

### 16.2 恢复规则

daemon 启动后：

1. 读取 execution plan、progress、retry state 和 leases。
2. `planned` 且没有 active lease：按持久化 `not_before` 重新入队。
3. `running` 且有 active lease：调用 provider recovery，不创建新 retry。
4. lease terminal 但结果未 publication：进入 collection。
5. progress 已有 valid replacement：将对应 decision 幂等标记为 `repaired`。
6. progress 有 retryable invalid 但缺少 decision：重新分类并以确定性 `decision_id` 补写一次。
7. 冲突的 trigger、retry index 或 work identity 必须 fail closed。

`control.json` 的 queued/terminal work items 必须包含动态 retry `work_id`；旧记录没有 retry state 时沿用现有 legacy recovery。

## 17. Schema 与兼容

### 17.1 向后兼容字段

- `BackendWorkItemV1.scheduling?: SchedulingHintV1`
- `EvalResultV1.scheduler_summary?`
- `EvalProgressV1.scheduler_summary?`

旧记录缺字段时：

- scheduling policy 为 `fifo-compat`；
- 不反向构造历史 priority；
- 仍可读取、rerun 和 collect。

### 17.2 Execution plan

保持 `schema_version="1"`，新增字段为可选并进入严格 parser allowlist。计划创建后不可修改 scheduling hint。

### 17.3 Result summary

```ts
interface EvalSchedulerSummaryV1 {
  policy: "fifo-compat" | "critical-path-lpt-v1";
  makespan_ms: number;
  physical_work_ms: number;
  initial_work_ms: number;
  retry_work_ms: number;
  verifier_work_ms: number;
  max_active: number;
  effective_parallelism: number;
  slot_utilization: number;
  single_active_tail_ms: number;
  resource_blocked_ms: number;
  collision_blocked_ms: number;
  backoff_blocked_ms: number;
  verifier_skipped: number;
}
```

所有时间来自 monotonic duration evidence；墙钟仅用于事件排序。

## 18. 可观测性

新增或补充事件：

```text
eval.work.priority-computed
eval.work.ready
eval.work.blocked
eval.retry.decision
eval.retry.ready
eval.retry.admitted
eval.retry.completed
eval.retry.skipped
eval.provider-circuit.opened
eval.provider-circuit.half-open
eval.provider-circuit.closed
eval.verifier.skipped
eval.scheduler.summary
```

关键字段：

- eval/work/slot/task/retry identity；
- priority policy、estimated duration、estimate source；
- queue wait、resource wait、collision wait、backoff wait；
- failure phase、stable code、retryability；
- Candidate 是否执行；
- Verifier 是否执行及跳过原因；
- active/max/effective parallelism。

日志不得包含 prompt、response、credential value 或无界 provider 错误文本。

`GET /health` 补充：

- ready/blocked/active physical work 数；
- initial/retry/collection work 数；
- provider circuit 状态和稳定 code；
- 最近窗口 slot utilization；
- single-active tail duration；
- retry scheduling latency。

## 19. 代码改动范围

### 19.1 Hitch core

| 文件/模块 | 改动 |
| --- | --- |
| `src/evals/planned-execution.ts` | 用 Physical Work Queue 替换首轮 barrier 和事后 retry loop |
| `src/evals/planned-execution-support.ts` | 抽取共享 comparator；将 direct mode 改为 PrioritySemaphore |
| `src/evals/physical-work-queue.ts` | 新增队列、依赖、backoff、settle 和 cancel 逻辑 |
| `src/evals/infrastructure-retry.ts` | 拆成 classify、build-one-retry、execute-one-retry；保留 legacy wrapper |
| `src/evals/remote-infrastructure-retry.ts` | 复用同一 retry decision 和 identity，不再维护独立循环语义 |
| `src/evals/planned-retry-lifecycle.ts` | local retry 使用派生唯一 work ID |
| `src/evals/retry-state.ts` | 新增严格 schema、原子更新和恢复 |
| `src/evals/duration-estimator.ts` | 新增历史统计与 planning-time hint |
| `src/control-plane/work-dispatcher.ts` | DRR lane 内按共享 comparator 选择，而不是插入顺序 |
| `src/control-plane/eval-recovery.ts` | 恢复 planned/running/collecting retry work |
| `src/domain/execution-plan.ts` | 增加 scheduling hint 类型 |
| `src/domain/eval-records.ts` | 增加可选 scheduler summary |
| `src/evals/trial-import.ts` | 导入稳定 failure classification 与 candidate-ineligible 诊断 |

### 19.2 Harbor bridge

| 文件/模块 | 改动 |
| --- | --- |
| `integrations/harbor/hitch_harbor_agent.py` | 写入 TrustedAgentOutcomeV1 和稳定 child error code |
| `integrations/harbor/hitch_harbor_verifier.py` | Verifier 前置 eligibility gate，保留 grade-final-state 语义 |
| `integrations/harbor/hitch_benchmark.py` | 统一 snapshot/response gradeability 检查 |
| `src/evals/harbor-bridge-error.ts` | 将 provider/bridge 诊断归一化为稳定 classification |

### 19.3 Evolution 编排层

- 增加持久化 `ensureBaseline` singleflight 和 `EvolutionBaselineV1` 状态机。
- 首次运行只提交一次 Seed/Heldout Baseline；两个 eval ID 必须在等待前持久化。
- Meta Agent 只消费 Seed Baseline，Heldout Baseline 结果保持隔离。
- 后续 round 只提交 Seed/Heldout Candidate eval，并引用首次 Baseline 的 eval ID 与 result digest。
- 比较阶段验证 Candidate 和已物化 Baseline 的 exact fingerprint 与 bundle evidence。
- 可选增加跨 lineage 的 `BaselineReuseReceiptV1`；不改写 Hitch run/eval identity。

## 20. 实施阶段

### 阶段 0：Trace 与观测基线

1. 记录当前仓库 revision、阿里云部署 revision、Controller Runtime ID 和 Evolution 实际调用入口。
2. 在 plan 创建、daemon dispatch 和 provider start 三处记录 `execution_strategy` 与 `work_item_count`。
3. 若 task membership 已知但仍生成整批单 work item，发布门禁必须失败并给出稳定诊断。
4. 将本轮 142 个 physical trial 的时长、资源和 retry 关系转换成脱敏 trace fixture。
5. 实现确定性虚拟时钟 replay harness。
6. 为现有 FIFO/barrier 调度生成 9.17 小时基线断言。
7. 增加 scheduler summary，但不改变执行行为。

完成条件：CI 可以在数秒内稳定重放本轮调度问题，且 canary 能证明线上标准 benchmark 的 plan 是一 task/slot 一 work item。

### 阶段 1：长任务优先

1. 实现 duration estimator 和 planning-time scheduling hint。
2. WorkItemDispatcher lane 内改用共享 comparator。
3. Direct mode 使用 PrioritySemaphore。
4. 保持 retry barrier 不变，以隔离排序收益。

完成条件：trace replay 不高于 480 分钟，reward/identity fixture 不变。

### 阶段 2：即时 retry

1. 引入 Physical Work Queue 和 retry state。
2. 首轮完成后即时分类和入队 retry。
3. local/remote retry 统一唯一 work identity。
4. 接入取消和 daemon recovery。

完成条件：retry 能在其他首轮 work 运行时开始；所有 crash point 无重复 Candidate。

### 阶段 3：错误分类与 Verifier gate

1. Adapter/bridge 输出稳定 provider code。
2. quota/auth/config 不再进入 retry。
3. 写入并验证 TrustedAgentOutcomeV1。
4. 对不可形成 valid observation 的执行跳过 task Verifier。

完成条件：quota retry 为 0；`grade_final_state` timeout 仍正常评分；无 bundle 的昂贵 Verifier 不启动。

### 阶段 4：Baseline ensure-once 与 Candidate-only rounds

1. 实现 `EvolutionBaselineV1`、exact fingerprint 和持久化 singleflight。
2. 首次运行并发提交 Seed/Heldout Baseline，并证明 Heldout 结果对 Meta Agent 不可见。
3. 后续 round 验证 Baseline 后只提交 Candidate eval。
4. 验证跨 eval DRR、资源限制和 collision mutex。
5. 增加首次物化时间、Candidate-only round 时间和 Baseline submission count 指标。

完成条件：同一 lineage 无论串行或并发启动多少 round，Baseline materialization operation 恒为 1；当前两分区模式下 Seed/Heldout Baseline 各提交一次，后续 round 的 Baseline submission 为 0；固定 trace 的 Candidate-only makespan 不高于 240 分钟。

### 阶段 5：可选跨 lineage Baseline 复用

1. 定义跨 lineage reuse receipt。
2. 实现只读查找和全量证据验证。
3. 默认关闭，通过 Evolution policy canary。

完成条件：任何 fingerprint 变化均 cache miss；命中时新 lineage 不执行 Baseline，但仍引用原始不可变 eval 和 sealed bundles。

## 21. 测试计划

### 21.1 单元测试

- scheduling hint 严格解析、canonical 化和旧 plan 兼容。
- duration estimator 的 evolution-baseline、P75、budget、default 优先级。
- `ensureBaseline` 的 singleflight、ready fast path、failed fail-closed 和 fingerprint mismatch。
- comparator 的稳定排序和 work ID tie-break。
- retry work ID 的确定性、唯一性和 local/remote 一致性。
- failure classification 全矩阵。
- quota/auth/config 不可 retry。
- `Retry-After`、full jitter 上限和持久化 `not_before`。
- TrustedAgentOutcomeV1 的完整、缺失、损坏和不一致情况。
- timed-out + gradeable 必须运行 Verifier。
- ungradeable 必须跳过 task Verifier。
- retry state generation、幂等更新和冲突拒绝。

### 21.2 调度并发测试

1. 十个槽、一个 60 分钟任务和多个短任务：长任务必须在首波启动。
2. 一个 task 在第 10 分钟产生 retry，另一个首轮任务运行 60 分钟：retry 不得等待第 60 分钟才进入 ready。
3. retry 必须重新取得资源 permit 和 collision mutex。
4. 同 task 不同 attempt 继续串行。
5. 两个 eval 同时存在时保持 DRR 公平，小 eval 不饥饿。
6. 大量 transient retry 时，尚未运行的 initial work 最终仍获得调度。
7. resource-fit task 可以回填，无法满足资源向量的 task 保持 blocked。
8. 并发启动多个 Candidate round 时，Baseline materialization owner 只有一个，Seed/Heldout Baseline 各只产生一个 eval ID。

### 21.3 崩溃恢复测试

在以下位置强制终止 daemon/worker：

- initial result 已导入、retry decision 未写入；
- retry decision 已写入、尚未入队；
- retry 已 admission、lease 未创建；
- retry Agent 运行中；
- retry result terminal、progress 未替换；
- progress 已替换、retry state 未标记 repaired；
- provider circuit 已打开、状态尚未 flush。

每个 case 断言：

- Candidate physical execution 数量不超过 policy；
- authoritative run 唯一；
- 没有资源或 collision permit 泄漏；
- retry index 和 work identity 不重绑定；
- 最终状态可解释。

### 21.4 Trace replay

使用动机实验 fixture，至少比较：

| Policy | 预期上界 |
| --- | ---: |
| FIFO + batch retry barrier | 555 分钟 |
| LPT + batch retry barrier | 480 分钟 |
| LPT + immediate retry | 475 分钟 |
| LPT + immediate retry + first-run Baseline ensure-once | 425 分钟 |
| 后续 Candidate-only round | 240 分钟 |

Verifier gate 的 44.6 分钟收益单独断言，避免调度重叠掩盖该回归。

### 21.5 集成与 canary

必须运行现有控制面完整检查，并增加：

```bash
npm run typecheck
npm run build
npm run check:architecture
node --test "dist/test/*.test.js"
npm run canary:resource-load
npm run canary:harbor-load
npm run canary:eval-scheduler-throughput
```

新 canary 使用短时 sleep fixture 模拟长短任务、transient failure、quota failure、Agent timeout 和 Verifier gate，不依赖外部付费模型。

## 22. 发布、开关与回滚

### 22.1 Feature flags

```text
HITCH_EVAL_SCHEDULER=fifo-v1|critical-path-v1
HITCH_EVAL_RETRY_SCHEDULING=batch-v1|immediate-v1
HITCH_EVAL_FAILURE_CLASSIFIER=legacy-v1|typed-v1
HITCH_EVAL_VERIFIER_GATE=off|on
HITCH_PROVIDER_CIRCUIT_BREAKER=off|retry-only|all-pending
```

发布顺序：

1. shadow 计算 priority/decision，只记录不执行；
2. 5% internal eval 启用 critical-path；
3. 5% 启用 immediate retry；
4. 启用 typed classifier 和 retry-only circuit；
5. 启用 Verifier gate；
6. Evolution 启用 Baseline ensure-once，先验证重复 round 的 Baseline submission count 为 0；
7. 首次运行启用 Seed/Heldout Baseline 并发物化；
8. 指标稳定后逐步设为默认。

### 22.2 自动回滚条件

出现以下任一情况立即回到 FIFO/batch retry：

- valid/invalid 或 reward 与语义对照组不一致；
- duplicate Candidate execution；
- authoritative publication 冲突；
- resource/collision lease 泄漏；
- retry scheduling 导致 daemon crash/recovery 失败率上升；
- p95 makespan 连续两个窗口恶化超过 10%。

关闭新 scheduler 不得删除新记录。旧版本必须忽略可选 scheduling summary；包含 active dynamic retry 的 eval 应由新版本完成恢复，不能用旧版本强行接管。

## 23. 验收标准

- [ ] 已知 benchmark task 默认以 task-slot 进入全局 dispatcher。
- [ ] 部署 revision、Controller Runtime ID 和 execution strategy 可追踪，线上已知 task 不再静默退化成整批 work item。
- [ ] 首轮 trial 结束后不需要等待同 eval 其他首轮 trial 即可调度 retry。
- [ ] local 和 remote retry 使用相同确定性 work identity。
- [ ] 每个 retry 都重新经过 resource admission、collision mutex 和 lease。
- [ ] scheduler 只消费稳定 FailureClassification，不解析任意 stderr。
- [ ] quota/auth/config 错误自动 physical retry 数为 0。
- [ ] Agent timeout 不被错误等同于 infrastructure failure。
- [ ] gradeable timeout 继续运行 Verifier。
- [ ] candidate evidence 不可用时不启动 task Verifier。
- [ ] daemon 在所有 retry crash point 恢复后没有重复 Candidate execution。
- [ ] Trace replay 端到端不高于 425 分钟。
- [ ] 同一 Evolution lineage 的 Baseline materialization operation 恒为 1；当前两分区模式下 Seed/Heldout Baseline 各只有一个 eval submission。
- [ ] 后续 Candidate round 的 Baseline submission 数为 0。
- [ ] 后续 Candidate-only trace makespan 不高于 240 分钟。
- [ ] 存在可 admission work 时，调度空闲槽比例不高于 2%。
- [ ] 相同 collision domain 的同 task attempt 不并发。
- [ ] Harbor reward 和 authoritative evidence 语义不变。
- [ ] legacy execution plan、direct eval、history、rerun 和 collect 继续可读可用。
- [ ] 完整 typecheck、architecture、unit、integration 和 canary 通过。

## 24. 明确设计决策

1. 复用现有控制面和 ResourceLedger，不创建第二套 scheduler。
2. 调度单元是 physical work；logical slot 和 physical execution 必须分离。
3. 跨 eval 公平性使用 DRR，eval 内使用预计剩余关键路径降序。
4. retry 不享有无条件最高优先级。
5. retry decision 必须在开始新 Candidate 前持久化。
6. local retry 必须改用唯一派生 work ID，与 remote 语义一致。
7. quota/auth/config 属于不可自动 retry 错误。
8. timeout 是否评分由 benchmark policy 和可信证据完整性共同决定。
9. Baseline 属于 Evolution lineage，只在首次运行物化一次；当前两分区模式各提交一个 eval，Candidate round 不拥有也不重算 Baseline。
10. 首次 Seed/Heldout Baseline 可以并发物化，但 Heldout 结果必须与 Meta Agent 和 Candidate 隔离。
11. Lineage 内 Baseline 引用是强制语义；只有跨 lineage 复用默认关闭。
12. Baseline 只能通过 exact fingerprint 和原始 sealed eval 引用，不能复制或改写成新 eval。
