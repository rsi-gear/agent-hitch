# Hitch 按执行阶段预留资源修改规范

状态：P0 与 P1 的未知资源试跑、采样修正、资源画像和显式配置批准已实现。当前真实 provider 证据仍为 `partial`，不具备可靠终态峰值证明，不能据此给出安全降限数字。P0 验证范围见 §12，P1 实际接口与边界见 §13。
日期：2026-10-21
适用范围：Harbor task 的资源规划、local Docker / remote worker 执行、daemon admission、执行证据与恢复。
依赖：[Harbor control plane 规范](hitch-harbor-control-plane-spec.zh-CN.md)、[吞吐优化规范](hitch-eval-throughput-optimization-spec.zh-CN.md)。

## 1. 修改结论与首版边界

本规范解决两个问题：没有见过的任务如何配置资源，以及 verifier 不依赖存活的 agent 环境时如何重算预留。

1. **资源大小与生命周期分别判断。** 没有历史内存记录，不等于不知道容器何时存活；有历史低内存记录，也不等于可以停止 verifier 所需的服务。
2. **声明表达依赖，backend 契约确定可执行的生命周期，本次执行的停止证据确定能否进入下一阶段。** 不根据 benchmark 名称、提示词、`separate` 单一字段或历史时间戳猜测依赖。
3. **已认证的互斥阶段按阶段需求的逐维最大值预留；已知会重叠的容器在同一阶段相加。** 生命周期未证实时保留保守相加；组件集合本身无法有界确定时拒绝规划。
4. **首版仍持有一笔覆盖整个 trial 的静态 reservation。** 不引入运行中的 ledger 缩容、追加预算或跨 worker 迁移。阶段切换只改变允许存活的容器集合，不释放这笔 trial lease。
5. **不自动降低容器硬限制，不按历史 P95 超卖资源。** 首版修正生命周期重复计费；历史采样用于解释和提出配置建议。
6. **AutomationBench 的所有任务都采用同一快照验证生命周期，MKT 只是其中一个 domain。** 本仓库 adapter 产出的全部受支持任务，其标准单步 separate verifier 都读取已封存的 simulator snapshot，验证时不需要 main 或 simulator 存活。在停止确认能力生效后，保持当前标准配置的硬限制，将资源从 **5 GiB / 3 CPU / 3 容器槽位**改为 **3 GiB / 2 CPU / 2 容器槽位**。配置了其他限额的任务沿用相同阶段公式重新计算，不硬编码 3 GiB。

有资格采用 `phase-envelope-v1` 的新计划已替代原规范 §10.5 的“全部组件相加”；旧计划和未知生命周期仍保持原算法。首版不要求支持所有多步、自定义环境或 live-service verifier；不支持的显式依赖必须在规划时报告，不能改变评分语义以迁就调度。

## 2. 现状、证据与术语

### 2.1 修改前的实现与任务契约

- [task-resources.ts](../src/evals/task-resources.ts) 将 main、task sidecars、separate verifier、provider sidecars 加总。main 与 verifier 的 CPU/内存先统一提升至两者最大值，再计入各自组件。
- [execution-plan-resources.ts](../src/evals/execution-plan-resources.ts) 校验 `reservation == sum(components)`；这个不变量需要按资源模型版本区分。
- [resource ledger](../src/control-plane/resources.ts) 按整个 work item 预留；本规范不改变它的容量不变量。
- [Harbor inspector](../integrations/harbor/hitch_harbor_task_resources.py) 修改前主要解析 task 级 verifier 和 agent Compose，未完整枚举 step 级模式、verifier 自己的 Compose 和自定义动态拓扑；现有认证与拒绝范围见 §12.1。
- [AutomationBench producer](../benchmark-packages/automationbench/import.mjs) 对所有选中任务使用统一模板：main + simulator、来自 simulator 的 `/evidence/snapshot.json`、单步 separate verifier。domain 仅写入 metadata，不影响生命周期或资源模板。[统一评分入口](../benchmark-packages/automationbench/runtime/official.py) 从任务定义和 snapshot 重建状态，再运行官方评分，无需访问原 main/simulator。[v5 资源导入](../benchmark-packages/automationbench/resources.mjs) 保留 task 配置与验证入口，改变构建上下文和资源引用，因此相同生命周期覆盖 v4/v5 的所有受支持 domain。

本文的 AutomationBench 范围为本仓库 public-source adapter 产出的全部受支持任务，不限于已实验的 MKT 子集；上游未接入的 simple/private track 或自定义改造包仍按实际契约判断。**跨 domain 适用的是生命周期和阶段计算规则，内存观测分布不跨 domain 自动复用。**

### 2.2 历史内存证据（MKT 样本）

2026-10-21 的本地历史审计覆盖 100 道 MKT、4,536 份 execution evidence；其中 4,401 份有完整三角色内存字段。角色采样峰值如下，单位 MiB：

| 角色 | 现有限额 | 中位数 | P95 | 最大观测 |
| --- | ---: | ---: | ---: | ---: |
| main | 2048 | 386.691 | 414.393 | 854.578 |
| simulator | 1024 | 263.689 | 271.832 | 428.918 |
| verifier | 2048 | 179.582 | 192.145 | 363.379 |

`max(main_peak + simulator_peak, verifier_peak)` 的中位数为 650.023 MiB、P95 为 707.531 MiB、最大为 1119.840 MiB。这个表达式是阶段用量估算，不是实测同步峰值。所有历史 observation 均标为 `partial`，采样可能漏短峰；旧 CLI fallback 还可能仅保留首次成功内存采样。记录不包括 host/controller/Docker daemon 和镜像构建内存，也不覆盖已查到的云端 32 并发运行。因此这些数据支持修正阶段预算，不能直接证明一个更低硬限制安全。

### 2.3 必须区分的四个值

| 名称 | 含义 |
| --- | --- |
| declared limits | task、Compose 或资源策略提供的配置及其来源 |
| effective limits | backend 最终实际施加的容器硬限制，包含兼容性提升 |
| phase demand | 某个阶段所有存活组件的 effective limits 之和 |
| reservation | 为所有可达阶段提供保障的静态资源向量 |

观测用量另行记录，不得覆盖上述字段。减少 reservation 的前提是减少可能同时存活的组件；在严格准入模式下，不能让它低于任何可达阶段的有效硬限制总量。

## 3. 没见过的场景如何配置

### 3.1 配置入口与优先级

沿用已有入口，不把 `--memory-per-trial` 改成整题总预算：

1. main / separate verifier 在 Harbor `task.toml` 对应的 `[environment]` / `[verifier.environment]` 中声明 CPU 和 `memory_mb`。
2. 各 sidecar 在自己的 Compose service 中声明 CPU、`mem_limit` 或 `deploy.resources.limits.memory`，并明确 replicas。
3. 同一角色有多处硬限制声明时，保留来源并取较大值，记录冲突诊断；较小的默认值不能覆盖已声明的较大限额。
4. 缺失字段依次回退到 submission `default_trial`、daemon operator 默认。现有 `--memory-per-trial` 仍是缺失组件字段的回退值，可能被多个组件使用；不能把“传了 1 GiB”解释为整题只有 1 GiB。
5. 内置回退为每个执行组件分别补齐缺失字段：缺 CPU 时 **1 CPU**，缺内存时 **1024 MiB（1 GiB）**，记录 `estimated: true` 和准确来源。这只是受控试跑的起点，不是充分内存的保证。provider 固定 sidecar 使用其经版本化的 overhead。
6. GPU 必须有固定、可解析的设备需求；磁盘、外部常驻服务和构建资源按各自策略准入，不能用内存默认值推断。

例如，一个新任务决定给 main 2 GiB、verifier 2 GiB、数据库 1 GiB，应分别写入这些角色的配置，planner 再根据存活阶段得到整题预算。不能把测得的 MKT 650 MiB 直接填入这个新任务。

### 3.2 决策矩阵

| 资源声明 | 生命周期与容器集合 | 规划与首次运行行为 |
| --- | --- | --- |
| 全部明确 | 已认证、阶段互斥 | 按 effective limits 计算阶段峰值；没有历史用量也可使用该算法 |
| 全部明确 | 组件可枚举，生命周期未知 | 按所有可能并存组件相加，并记录 fallback 原因；容量足够时可使用请求的并发 |
| 部分缺失 | 已认证或未知 | 缺失字段用上述默认值并标记 estimated；保留对应阶段/相加算法，默认先单任务试跑 |
| 有历史 profile，但 task/harness/image/runtime 不匹配 | 任意 | 不使用旧用量建议；保留当前显式限额，否则回退默认试跑 |
| 组件数量或资源表达式无法有界解析 | 任意 | 规划失败，要求固定 replicas/limits 或提供支持该拓扑的 provider；不能只把已发现部分相加 |

已实现 operator 策略 `resource_profiling.unknown_max_parallelism`，默认 `1`。它限制任一非 provider 固定组件缺少 CPU 或内存声明、且没有与完整身份及当前有效限额精确匹配的显式批准的工作项；不透明任务集合也按 unknown 处理。明确声明全部限额的任务不因“从未运行过”而强制串行。daemon/managed worker 的试跑槽位按 worker 共享，防止多个 eval 各自启动一批未知工作项；它与常规 CPU/内存/container admission 同时满足。direct 模式只限制本进程的未知工作项并发，并明确报告不提供跨进程配额保证。operator 可显式调整该值，计划必须记录原请求、试跑上限和实际准入原因，不能提高容量或绕过 ledger。

AutomationBench 通用 producer 已为所有 domain 的 simulator 补充 **1 CPU / 1024 MiB** 显式限额；v5 导入旧 v4 数据时也仅补齐缺失字段，保留已有自定义声明。重新导出、封存会产生新的 task/dataset 身份，默认 effective limits 不变。未重新导出的旧任务仍可能含 estimated 字段，按新计划的 unknown 策略试跑；MKT 历史 `partial` 观测不能自动批准任何 domain。也可通过 §13.4 的显式批准承认当前限额；没有按 benchmark/domain 名称豁免。补声明与按阶段降预留是两个独立变更。

未知任务若 OOM，应保留失败证据，修改资源配置并生成新计划再运行；不得在原 lease 上自动加内存，或删去失败样本后将配置标为足够。降低已有声明的硬限制也必须产生新配置身份，并明确记录变更。

### 3.3 从未知到有证据的资源配置

已实现的资源画像绑定：task/任务集合 digest、harness artifact、controller/runtime digest、每个角色 image digest、平台、backend/provider 生命周期能力、输入规模和资源相关运行参数。变更使旧画像的用量建议失效，但不会擅自覆盖新的显式硬限制。

生成降低限额建议前必须覆盖冷启动、完整 Agent、artifact collection、verifier 和退出，所有角色及副本均有完整生命周期的可靠内核峰值、OOM 标志和退出结果。`min_complete_trials` 默认 `3` 只是可配置的流程门槛，不代表尾部安全性；任务集合画像还需列出覆盖集合和代表性/压力输入。未验证或不完整的样本也会阻止缩限，不能只挑成功的完整样本；OOM、非零退出和物理重试缺证据都要保留。P95 仅描述分布。建议算法使用观测最大值加明确余量，并列出来源和未覆盖范围，不自动应用配置或下调 reservation。

**当前采集器不能证明退出前最后一次内存峰值，真实 evidence 的 `lifecycle_coverage` 始终为 `partial`。** 因此当前 `resources recommend` 会输出观测值、现有限额和阻断原因，建议保留限额、补采完整生命周期证据，必要时调查 OOM 并用新配置重跑；不会输出安全缩限数字。手工导入 JSON、旧 MKT 记录、运行中读到的 `memory.peak` 或单独的停止 receipt 都不能升级成完整证明。缺少完整角色镜像 digest 或其他身份字段也会阻断画像批准；远端 backend 版本尚未与实际 worker 绑定，不能用 controller 本机版本代替。

## 4. Verifier 到底需要哪些环境存活

### 4.1 依赖必须区分“读取文件”和“访问存活服务”

- **artifacts-only**：verifier 只读取已收集、校验并封存的文件；文件可源自 main 或 simulator，但文件来源不意味着该容器在验证时还须存活。
- **shared**：verifier 在原 main 内执行；main 及该 backend 要保留的 sidecars 必须存活。不能把共享的同一个 main 再算作第二个 verifier 容器。
- **live-services**：独立 verifier 需要访问指定的存活服务，例如 simulator API 或数据库；只有 provider 支持保持服务、网络连通和身份隔离时才能执行。
- **unknown**：信息不足，不能证明某服务可停止。组件可有界枚举时按可能重叠预留，不擅自改生命周期。

规划器复用 Harbor 的有效模式解析，包含默认值与 task/step 继承。不能仅靠用户声称 `artifacts-only` 降额，也不能静态扫描 verifier 脚本“没找到 HTTP 调用”就判定无依赖。

### 4.2 新增可选依赖声明

引入 task 同目录的 `hitch.resources.json` 作为 Hitch 扩展声明，不向 Harbor 原生 `task.toml` 注入未支持字段。文件纳入 dataset/task digest、导入导出和物化闭包；添加或修改文件得到新数据集身份。

```json
{
  "schema_version": "1",
  "verifier_dependencies": {
    "inputs": "artifacts-only",
    "live_services": [],
    "artifacts": [
      { "service": "simulator", "path": "/evidence/snapshot.json" }
    ]
  }
}
```

规则：

- `inputs` 为 `artifacts-only`、`live-services` 或 `backend-defined`；缺省文件时由已认证 native backend 解析契约，无法确定则 unknown。
- `artifacts-only` 要求 `live_services` 为空，artifact 列表与原生声明及实际收集 manifest 一致。
- `live-services` 必须列出准确 service 名称，不能使用通配符；属于有意保留依赖，不授权 provider 改变网络或共享验证语义。
- `backend-defined` 使用 native shared/multi-step 等语义。首版扩展不重新定义 step 继承；多步优化尚未认证时保持保守算法。
- 声明与 native backend 冲突时规划失败。**当前 Harbor 单步 separate 会停止 agent 环境，不支持声明需保留 live main/simulator 后仍沿用该运行方式。** 应报告 `verifier_live_dependency_unsupported`；不能忽略依赖，也不能自动改成 shared。
- 没有该文件的新任务，若已认证 backend 能完整证明单步 separate 的停止顺序和 artifact 交接，仍可推导阶段契约；扩展文件不是普遍必填项。

### 4.3 场景矩阵

| 场景 | 验证时的存活集合 | 预留规则 |
| --- | --- | --- |
| 单步 shared | main + backend 保留的 sidecars/overhead | 该集合总量，无额外 verifier 容器 |
| 单步 separate、artifacts-only、已认证停止能力 | verifier 自身环境及其 sidecars/overhead | agent 组与 verifier 组取阶段最大值 |
| separate 依赖 live simulator | simulator + verifier 自身环境；main 是否保留由契约确定 | 对各阶段存活集合求和，再取最大值；首版无此 provider 能力则拒绝 |
| 多步的中间 separate verifier | agent 环境仍须供后续 step 使用，再加独立 verifier 组 | 必须覆盖两组并存；不能因预计提前结束而降额 |
| 多步最后一次 separate verifier | 可在停止 agent 组后单独验证 | 整题仍覆盖前面任何并存阶段的峰值 |
| verifier-only / regrade | verifier 组；输入为已有合法 artifact manifest | 独立 work item、独立准入，不再预留已结束的 agent 组 |
| 未认证 custom backend | 所有可能并存的已枚举组件 | 保守相加，不推断互斥 |

verifier 自身的 Compose、replicas、egress、helper 也必须枚举。当前 inspector 未完整覆盖的结构不能默认当作“仅一个 verifier 主容器”；若不能建立可信有界集合，应失败而不是给出一个偏小的 fallback。

## 5. 资源计算

对可优化维度 `D = {cpu_millis, memory_bytes, container_slots}`：

```text
E(c, d) = 组件 c 在维度 d 上实际执行的总限额（已含 replicas）
L(p)    = 阶段 p 必须同时存活的组件集合
phase_demand(p, d) = Σ E(c, d), c ∈ L(p)
reservation(d)    = max phase_demand(p, d), p ∈ 所有可达阶段
```

逐维最大值不要求 CPU 峰值与内存峰值来自同一阶段。共享组件按 component identity 去重；当前 `component.resources` 已乘 replicas，不得再次相乘。teardown 阶段在停止证明完成前仍包含原组；跨阶段的 host proxy/helper 若属于 task 预算，须出现在每个相关阶段。

### 5.1 AutomationBench 所有任务的重算

所有 domain 使用相同阶段公式：`max(effective_main + effective_simulator, effective_verifier)`，并计入实际声明的其他组件。下表使用当前统一模板的显式 simulator 限额（数值与旧默认值相同）；任务内容、domain 名称和是否已有历史实验不改变这一生命周期。

| 阶段 | 存活组件 | 内存 | CPU | 运行容器槽位 |
| --- | --- | ---: | ---: | ---: |
| setup / agent | main + simulator | 3 GiB | 2 | 2 |
| main 停止后收集 snapshot | simulator | 1 GiB | 1 | 1 |
| agent 环境 teardown 未获确认 | 仍按整个 agent 组覆盖 | 3 GiB | 2 | 2 |
| verifier setup / run / collection | verifier | 2 GiB | 1 | 1 |
| 整题静态 reservation | 各维度阶段最大值 | **3 GiB** | **2** | **2** |

AutomationBench 的 snapshot 必须先从 simulator 复制到受控 artifact 存储，验证完成性并封存；不能将指向即将停止容器的文件路径当作交接成功。**保留的是已收集的证据，不是 main/simulator 的运行状态。** 可保留停止后的容器以便审计，但不能暂停并宣称已释放内存；容器可写层、卷、snapshot 等仍计入磁盘/保留策略。

### 5.2 必须按实际硬限制计算

首版保留 Harbor 当前 main/verifier 共用较大硬限制的兼容行为。例如 main 声明 1 GiB、verifier 声明 8 GiB、sidecar 1 GiB，effective main/verifier 都为 8 GiB，阶段预算是 `max(8+1, 8)=9 GiB`，不能按原声明算成 8 GiB。

独立 main/verifier hard limit 是后续单独能力；若实现，必须同时修改执行配置与 evidence，并覆盖 local、remote、rerun，不能只修改 planner 的算式。

### 5.3 不套用通用 max 的资源

- GPU 首版保持旧预留及设备绑定，不宣称阶段设备复用；不同阶段需要不同设备身份时必须满足原设备约束。
- ephemeral disk、snapshot、停止容器可写层与缓存可能跨阶段累积，保持原磁盘策略；不能因容器不 running 就释放磁盘额度。
- build resources 单独取得 build lease。构建与存活容器重叠时同时持有两种 reservation；build lane 未计入的实际内存不能当作零，需由显式 build 预算或保留的 worker 系统容量覆盖。
- controller、Docker daemon、常驻模型服务按 host/system 或服务租约覆盖，不重复分摊进每个 task，也不能从可调度总容量中遗漏。

## 6. 可认证的执行契约与停止证明

新增能力 `phase-exclusive-teardown-v1`，绑定 backend adapter、Harbor 版本、controller runtime、provider/worker 实现身份及支持的拓扑。**安装了 Harbor 0.21.0 或解析到了 separate 均不足以宣称能力存在。** 当前 stop 异常可能被吞并继续，因此必须增加能阻止 verifier 启动的实际 barrier，而非仅监听事后日志。

首版认证范围是完整解析的单步原生 shared/separate Docker trial。需要扫描并拒绝将 steps、未知 verifier Compose、自定义环境类、动态副本/服务遗漏后当作这个范围。认证不按 benchmark/domain 名称分支，同一契约覆盖 AutomationBench 全部任务，也适用于其他满足条件的任务。

separate artifacts-only 转换的必要步骤：

1. Agent 结束；按 native 语义收集 main artifacts，停止 main。
2. **在收集任何 sidecar snapshot 前设置独立 barrier**：provider 检查准确的 main 容器和执行进程，确认已退出、非 running、非 paused，持久化 `main.stopped-confirmed`。失败或状态不明时禁止收集、封存 sidecar snapshot，也禁止验证；之后整组停止成功不能追认此前 snapshot 有效。
3. 收集 sidecar artifacts，验证 artifact manifest、内容完整性和可在原环境消失后读取；封存归属 work/attempt，并绑定上述 main 停止证明。
4. 停止整组 agent 容器，包括 task sidecars、所属 egress、task helper；仍须存活的组件必须显式列入下一阶段。
5. provider 依据精确 root/work/lease/epoch 标签和容器 ID 重新检查：所有待释放组件均非 running、非 paused，相关执行进程退出，且没有未枚举的归属容器。无法确定状态视为未停止。
6. 若 provider 仍保留可计费的内存状态，须清理或把它作为下一阶段的残留 overhead 计入；不能仅凭 Agent 进程退出宣称整个组已释放。
7. 写入持久化 `environment.stopped-confirmed` 证明后，才能允许创建/启动下一 verifier 组。仅发出 stop 请求、等待固定秒数或捕捉到 Agent exit 都不构成证明。

两类停止证明均绑定 plan digest、work ID、attempt、lease ID/epoch、组件和容器 ID、检查结果、provider 身份与时间。artifact manifest 引用先产生的 main 停止证明；全组停止证明再绑定 manifest digest。恢复后必须重新检查当前真实状态，不能凭旧进程的证明继续启动。运行状态证明和 artifact 安全边界都必须位于可信 controller/provider 中，不能由 candidate 写入。

### 6.1 失败处理

- stop 超时、Compose stop/down 返回错误、残留 running/paused 容器、Docker 无法连接、artifact 不完整：禁止启动 verifier，记录 `phase_transition_unconfirmed` 或具体 artifact 错误，保留 trial lease 并交给现有清理/恢复流程。
- **不能拿到 3 GiB lease 后降级为旧 5 GiB 拓扑继续运行。** fallback 只能发生在规划/准入前；运行中不能静默超卖或就地扩大预算。
- 不以清理成功之前的终态结果释放预算。epoch fencing、取消、reaper 和结果收集继续遵守现有 ownership 规则。
- live-service 依赖在支持的未来 provider 上只能释放不再需要的服务；保留服务必须可达、身份正确并进入相应阶段预算。保守多预留内存不能弥补 backend 实际停止依赖服务的语义错误。

## 7. 计划结构与兼容

在 `EvalExecutionPlan` 新增 `resource_contract_version: "2"`，使用下列结构（省略原有逐字段汇总证据）。该标记进入不可变计划 digest；旧计划缺失该字段视为 V1，不重新计算原 reservation。P0 中保守相加的任务继续使用原 V1 结构，不写入 `resource_model`；V2 计划可以同时含有这样的保守任务。

版本边界必须覆盖实际执行协议：新增版本化 backend work item 与 remote offer，携带资源契约版本、完整契约或可校验引用、契约 digest 以及 required capabilities，并纳入 work/offer 的不可变身份。不能只改顶层 plan，再把降低后的 reservation 编码为未变更的 `BackendWorkItemV1` 发送给旧 worker。协商和接单解析均须在创建容器前拒绝不支持的版本/能力；该拒绝不能降级重试为 V1 编码。

```ts
interface TaskResourceRequirementV2 {
  task_id: string;
  resource_model: "phase-envelope-v1";
  reservation: ResourceVectorV1;
  declared_limits: ComponentDeclaration[]; // 保留每字段来源/estimated
  components: TaskResourceComponentV1[]; // effective limits，已含副本和 backend 提升
  main_limits: ResourceVectorV1; // 首版保留现有执行接口
  lifecycle: {
    capability_identity: "phase-exclusive-teardown-v1";
    backend_contract: "harbor-native-docker-single-step-v1";
    verifier_inputs: "artifacts-only" | "shared";
    retained_services: string[];
    artifacts: Array<{ service: string; path: string }>;
    phases: Array<{ id: string; live_components: string[]; demand: ResourceVectorV1 }>;
    transitions: Array<{ from: string; to: string; requires_stop: string[] }>;
  };
  diagnostics: string[];
}
```

`ComponentDeclaration` 为 `{ component, fields }`；`fields` 保留每个资源维度的 `value/source/estimated`，不包含候选可执行控制指令。精确 schema 见 [eval-execution-plan.schema.json](schemas/eval-execution-plan.schema.json)。unknown 生命周期使用 V1 相加并记录 fallback reason，不得伪造已验证的单阶段契约。

校验规则：

- V1 继续校验旧 sum，不把读取旧计划当成资源迁移。
- 保守任务校验完整组件之和；`phase-envelope-v1` 验证所有可达阶段、转换和 capability，从 `components` 重新计算每个 `phase.demand`，再对允许的三个维度取 envelope。不得信任序列化的 demand/reservation 自报值；其他维度遵守 §5.3。
- `components` 必须与实际执行配置一致：校验 `main_limits`、verifier 限额、所有 service/role overlay 与各组件的有效角色限额相等；按每副本限额与副本总量正确换算，且能由目标 backend 准确施加。不能沿用仅检查 `component <= main_limits` 的宽松关系，接受“组件写 1 GiB，实际主容器限制 8 GiB”的计划。无法表达或施加该契约时拒绝执行。
- 未识别的 contract version、worker capability、component 引用、重复/缺失组件、未覆盖的执行分支必须拒绝，不能忽略新增字段后启动。
- 同一阶段是组件 ID 集合，不因多个依赖边而重复加值；所有实际创建的容器必须映射到预先声明的组件、副本和阶段。
- snapshot-only 的 verifier 阶段不得包含已证明可释放的 main/simulator，反之 live dependency 不得被遗漏。
- 不能在恢复时根据新代码重写已有 plan。重新规划或改硬限制产生新 execution identity；旧结果与评分保持原绑定。
- direct 与 daemon 都执行相同阶段 barrier；只有 daemon 提供全局账本，不能因 direct 模式没有全局账本而跳过生命周期契约。
- remote worker 在接单前校验 capability/contract，停止证明来自实际执行节点；controller 不能用本地观察代替远端状态。首版没有该能力的 remote provider 保持旧算法，新阶段计划不得派给它。
- verifier-only work item 按自己实际创建的 verifier 组重新准入；有效 artifact handoff 是前提，旧 agent 组的额度只能由旧节点的停止/清理证据释放。

## 8. 内存观测修正（P1 已实现，生命周期仍为 partial）

[采样类型](../src/domain/memory-observation.ts) 与 [证据校验](../src/evals/memory-observation.ts) 将观测值和硬限额分开记录：

1. Engine stats 持续采样；不可用时 CLI fallback 每轮重试和更新，不再只保留首次成功结果。
2. 每容器记录来源、时间、实际间隔、缺口、保留样本数和截断计数。Engine usage 使用 `cgroup-usage` 口径；CLI 使用 `cli-working-set`，不能不加区分地合并。可用时读取 Engine `max_usage`，或在 Linux host 校验容器身份后只读 cgroup v2 `memory.peak`，单独标明内核峰值来源、启动及 reset 边界。
3. 角色与可能阶段来自冻结拓扑；同轮 `groups` 记录组用量、时间跨度、Engine 源时间跨度及 `approximate`。`complete` 仅表示本轮发现的运行容器均已采样，不表示覆盖整题生命周期。`group_peaks` 按组、阶段、测量口径和质量分类保留全程观测最大值，避免有限长度的原始样本截断后丢掉较早峰值。
4. `max_container_sampled_peak_bytes` 是最大单容器采样峰值，`sum_container_sampled_peaks_bytes` 是各容器独立峰值之和；二者均不是整题同步峰值。报告保留组峰值的时间与近似标记。旧 `peak_memory_bytes` 保持历史解释，不重写旧 bundle，也不补造旧样本。
5. 缺采样明确记录 unavailable/partial 和 gaps，零值与未测得分开。容器停止、消失、采样失败或区间超时不能被当成用量为零；OOM 与退出状态仍进入画像。

这些修正改善可解释性，但未实现可靠终态内核峰值证明：运行中读到峰值，随后容器停止，并不能排除最后一次读取之后出现新峰。当前 provider 和画像实际收集路径仍只产生 `lifecycle_coverage: "partial"`，不能用于宣称低硬限额安全。P0 的停止屏障证明阶段互斥，不证明完整内存用量。画像调优与阶段预算优化分别验收，历史 partial 证据不会被自动升级。

## 9. 实施顺序

### P0：契约与可验证的阶段预留（已实现）

1. 扩展 inspector：完整解析有效 verifier 模式、step 存在性、两侧环境组件、artifact 交接与可认证能力；新增依赖扩展文件校验。
2. 为 local Docker 增加真正阻止 verifier 提前启动的 barrier 和停止确认，修正吞异常后继续的问题；认证之前仍使用旧 sum。
3. 增加 V2 资源计划、版本化 work/offer 和 parser，采用 effective component limits 推导 phases/envelope，校验执行 overlay 一致性；保留 V1 读取、恢复和旧算法。
4. 让 local/daemon/direct 的执行与 evidence 消费同一个冻结契约；remote 在 capability 支持之前保守处理。
5. 对 AutomationBench 全部受支持任务执行契约/计划校验，并按已导入 domain 选择代表任务做生命周期与固定 snapshot 验证，覆盖 v4/v5；另加入至少一个非 AutomationBench 单步 fixture。当前标准配置的所有 AutomationBench 任务都应为 3 GiB / 2 CPU / 2 slots，硬限制和 verifier 评分契约保持不变。自定义限额按实际 effective limits 重算，不能把 3 GiB 当作 benchmark 常量。
6. planner 输出逐角色限额、每阶段存活集合、最终 reservation、estimated 和 fallback reason，让操作者知道为何仍是 sum 或被限制并发。

### P1：采样证据、未知场景试跑与显式配置（已实现）

已实现 §3 的试跑策略、画像身份与显式批准，以及 §8 的持续采样和口径修正；实际 CLI 见 §13。建议器严格检查完整证据门槛，当前真实采集路径因缺终态证明而阻断缩限，只输出观测描述和后续操作。可靠终态峰值证明、独立 main/verifier 限额、多步精确阶段图、live-service retention provider、动态 ledger resize 和 GPU 阶段复用不在本次实现范围。

## 10. 验收标准

| 类别 | 必须验证的行为 |
| --- | --- |
| AutomationBench 全部任务 | 跨 domain、v4/v5 使用相同阶段规则；标准配置 2 GiB main + 1 GiB simulator → 2 GiB verifier，reservation=3 GiB/2 CPU/2 slots；snapshot 可在原容器全部停止后重评分；自定义限额按实际配置重算 |
| 未见资源 | 缺失字段非零、来源及 estimated 正确；不套用 MKT 画像；试跑并发上限与普通资源准入同时生效 |
| 未知生命周期 | 已知有界组件回退完整 sum 并显示原因；无法枚举全部组件或副本时规划失败 |
| Shared | main/所需sidecars存活，verifier不创建第二份main预算，禁止过早停止环境 |
| Live dependency | 当前单步 separate provider 明确拒绝 live simulator 依赖，不静默改为 shared 或 artifacts-only |
| 多步 | `agent1 → separate verifier1 → agent2` 不错误使用互斥峰值；首版未认证时保守，后续精确实现必须覆盖并存阶段 |
| 不对称限额 | main=1、verifier=8、sidecar=1 GiB，当前共享 effective limit 下预留9 GiB；不能按原声明算8 GiB |
| 副本/overhead | replicas只乘一次，共享组件去重，agent/verifier各自egress/helper都按实际阶段计入 |
| 停止失败 | stop失败、paused容器、残留sidecar、Docker不可达均禁止启动下一组；不释放lease、不临时按sum继续跑 |
| 快照前 barrier | main 单独停止失败时不得收集/封存 simulator snapshot；即使随后整组停止成功也不得继续验证 |
| 执行限额一致性 | 篡改 phase demand/reservation，或 effective component=1 GiB 而实际 main/service overlay=8 GiB，均在创建容器前拒绝 |
| 远端版本边界 | V2 work/offer 绑定契约 digest 和必要能力；旧 worker 拒绝，禁止将降低后的预算以未变更 V1 work 编码发送 |
| AutomationBench 未知策略 | 各 domain 的 simulator 未补显式/批准配置时遵守未知试跑上限；通用模板补 1 CPU/1024 MiB 后重新导出产生新身份，默认 effective limits 不变，无按 benchmark/domain 名称豁免 |
| 恢复/取消 | controller崩溃、epoch变化、迟到事件、重复stop回执不提前启动/释放，不把旧证明用于新容器 |
| 资源不变量 | daemon/managed worker 中多eval、build与sandbox重叠时始终满足全局预算；单题放不下时报不可满足，忙碌时正常排队；direct 明示缺少跨进程配额保证 |
| 兼容 | 旧计划保持5 GiB等原值；未知V2/capability的worker拒绝；重规划形成新身份 |
| Remote/regrade | 目标worker独立准入，artifact完整性和原worker清理独立证明；无live依赖才允许独立snapshot重评分 |
| 观测 | CLI每轮更新、可用时采集cgroup峰值、缺样可见；最大单容器/峰值之和/阶段组观测不混为一谈 |
| GPU/磁盘 | 不因阶段max擅自复用设备或释放保留数据容量 |

真实验收需在明确记录 Docker 容量的环境进行，记录实际同时运行组、阶段交接、硬限制、OOM/退出和评分结果。首个并发 canary 按阶段声明需求计算并发，不以历史低 usage 超卖；证明无 overlap 后才能开启新模型默认路径。无需以一次模型分数变化证明资源改动等价，应使用固定 snapshot 的 verifier 重评分和生命周期证据验证隔离及结果收集语义。

## 11. 完成条件

- 未见任务的默认、回退、试跑、画像失效和显式资源配置路径均可解释、可测试。
- 能准确回答 verifier 需要哪些存活服务、哪些仅是文件来源，并把依赖写入冻结计划。
- 已认证 AutomationBench 全部任务按阶段重算；当前标准配置的内存/CPU/槽位预留降到 3 GiB/2/2，自定义限额按实际 effective limits 计算，且正常与失败路径都不超出预留。
- 未知或需要重叠的场景不误降额，旧计划不被隐式迁移。
- 不再用当前最大单容器采样值冒充整题同步峰值，也不把 observed usage 与 reserved limit 混为一谈。

## 12. P0 阶段预留实现与验证记录（2026-10-21）

### 12.1 已实现的接口与边界

- [planner](../src/evals/phase-resources.ts) 对已认证 local Docker 单任务 work 使用阶段峰值。适用条件由原生单步拓扑、effective limits 和生命周期能力决定，没有 AutomationBench/domain 名称分支。标准配置为 `max(2 GiB main + 1 GiB simulator, 2 GiB verifier) = 3 GiB`；CPU、容器槽位同样取阶段最大值。容器硬限制保持不变。
- [inspector](../integrations/harbor/hitch_harbor_task_resources.py) 解析有效 shared/separate 模式、artifact 来源和完整 agent/verifier 组件。多步、自定义 verifier Compose、动态拓扑、自动重启及不支持的 live 依赖在规划时报错；缺少生命周期能力的有界声明保守相加。GPU 不启用 P0 阶段复用。
- [执行屏障](../integrations/harbor/hitch_phase_resources.py) 绑定 Harbor 0.21.0、本次计划、task/attempt、ownership/lease epoch、Docker daemon ID 和确切容器 ID。main 停止确认后才允许 sidecar snapshot；全组停止及 artifact seal 确认后才允许 verifier。吞并的 stop 异常会留下不可清除的失败状态。receipt 写入 trial 的 `hitch-phase-resources-agent.json` / `hitch-phase-resources-verifier.json`，包括 `main.stopped-confirmed`、`environment.stopped-confirmed`、`verifier.start-authorized` 或 `phase_transition_unconfirmed`。
- V2 plan、work 与 offer 绑定资源契约 digest/capability；所有执行 overlay 从冻结的角色限额生成。P0 remote provider 仍生成保守 V1 sum 计划，任何 V2 远端执行请求在接单/下载前拒绝。禁止运行中把小预算退回旧拓扑。
- 普通执行、physical retry、candidate restart 都使用冻结预算和新的 ownership。local verifier-only 使用独立 verifier 阶段预算；源 receipt、snapshot seal 和原 Docker 节点清理状态须重新验证。V2 remote regrade 暂不支持。
- V2 清理未确认时保留全局 admission allocation，并停止本 eval 等待准入的任务。为兼容现有 reaper，execution lease 可先转为 `released` 以允许清理；**该状态本身不释放账本额度**。daemon 启动扫描包括 terminal eval/rerun 在内的 V2 lease，清理错误、残留或未确认释放的执行会阻止恢复调度。
- 所有 local V2 work（包括 shared 和混合计划中的保守任务）先在 `leases/<lease-id>.docker-binding.json` 持久化 `not-started`，再于 Harbor 启动前写入 `bound` 和实际 Docker daemon ID。执行与清理各自固定 Docker selector，清理前后核对 daemon ID，另一个 context 的空列表不能证明原节点已清理。无启动记录也无有效 receipt 时拒绝认定清理成功。成功清理会写入绑定 lease/epoch、独立节点记录、receipt digest 和原 daemon 的持久记录；重启时只有这些证据精确匹配，才可免于再次访问已完成的旧节点。
- 旧计划恢复复用原资源向量、runtime、artifact、镜像和本地 Git transport；不重新调用 inspector、不使用当前默认预算重新打包，也不把 5 GiB 旧计划迁移为 3 GiB。新配置需创建新计划。
- 操作者可在 `execution-plan.json` 查看逐角色 `declared_limits/components`、`lifecycle.phases/transitions`、最终 `reservation`、`estimated` 和 `diagnostics`；`eval.planned` 事件带资源契约版本及计划路径。

### 12.2 验证范围

- 规划审计：本地 1,049 个真实 AutomationBench task 目录（100 道 Marketing 题）均通过 inspector、V1/V2 parser 和资源计算校验；标准配置全部从 5 GiB/3 CPU/3 slots 变为 3 GiB/2 CPU/2 slots。其他 domain、v5 角色目录及非 AutomationBench 任务由通用 fixture 覆盖；不声称已运行本地不存在的真实 domain 数据。
- [真实 Docker canary](../test-support/harbor_phase_resources_docker_canary.py)：Harbor 0.21.0，Docker 27.4.0，10 CPU、8,217,968,640 bytes 内存；两个并发合成任务，每容器硬限制 1 CPU/256 MiB，静态每题峰值 512 MiB，观察到最多 4 个存活容器。243 次采样无同 trial 跨阶段重叠；固定 snapshot 初次验证和独立 regrade 均为 1；故障注入证明 main stop 失败时不收集 snapshot、不启动 verifier。除采样外，每次交接还执行准确容器身份和 Docker 状态屏障。
- [真实 AutomationBench snapshot parity](../test-support/automationbench_snapshot_parity.py)：`marketing.social_crisis_response` 使用原任务、原缓存 verifier 镜像、原 snapshot，在没有 main/simulator 且 `--network=none` 下重评分。`reward=0`、`total_score=0`、`process_score=0.6666666666666666` 与历史输出完全一致；snapshot 不变，镜像内 `test.sh/task.json/official.py` 与原 task 文件 digest 一致。此项验证评分输入独立性，不代表跨 domain 模型效果实验。
- 自动回归覆盖阶段算式、不对称限额、replicas/egress、版本降级拒绝、V1 恢复、停止失败、清理持有额度、daemon 重启、candidate restart 和 verifier-only 路径；shared 和混合计划中没有 Python 阶段 receipt 的 V2 work 也必须验证独立节点绑定与清理结果。
- P0/P1 初始基线（0.2.16）回归：**930 项，923 通过、7 跳过、0 失败、0 取消**（并发 4）。最终 daemon policy 持久化与未知资源准入复测 **12/12 通过**。`typecheck`、`build`、`check:architecture`（468 个源文件、1000 条跨模块边）、语法检查与 `git diff --check` 均通过。

以上 P0 验证记录说明阶段预留与停止证明；P1 已启用未知资源试跑策略、冻结画像身份、显式配置批准及持续采样，见下节。旧任务和旧计划不会因模板更新而原地迁移，历史 partial 用量也不会变成降低硬限额的依据。

## 13. P1 实际接口与使用边界（2026-10-21）

### 13.1 未知资源准入与计划冻结

[unknown 判断](../src/evals/resource-profiling-plan.ts) 检查各非 provider 固定组件的原始 CPU/内存声明。缺任何字段即为 unknown，即使 Harbor 的 main/verifier 共用较大有效限额后掩盖了该缺失，也不能变成已明确配置。缺失字段仍分别回退到 1 CPU 或 1 GiB；这不会把多组件整题预算固定成 1 GiB。provider 固定 overhead、GPU、磁盘、镜像构建及正常资源容量继续按各自规则计算。

未知试跑上限默认 `1`，可以通过 daemon/worker 的 `--unknown-max-parallelism` 或 `HITCH_RESOURCE_PROFILING_UNKNOWN_MAX_PARALLELISM` 设置为 1–10000 的整数；显式策略优先于环境变量。提高试跑上限不会提高 CPU/内存/槽位容量。

```bash
hitch daemon start --unknown-max-parallelism 1
```

| 执行范围 | 已实现行为与限制 |
| --- | --- |
| daemon / managed worker | unknown 槽位在同一 worker 的 eval/rerun 之间共享，并同时满足普通资源准入；远端 worker 还要独立检查自身容量与上限 |
| direct | 同一进程中的 eval/rerun 共享 unknown 计数；不提供跨进程、跨 root 或整台机器的全局配额保证 |
| known task-slot | 每个工作项冻结 unknown 状态、原因、槽位和批准 digest；显式声明完整的任务可按请求并发调度 |
| shard / opaque | unknown shard 整体收紧内部并发，不透明集合按请求并发计入 unknown 槽位；不根据当前尚未枚举出的任务猜测大小 |
| 旧 plan 恢复 | 继续使用原计划、原预算和原 policy；没有 `resource_profiling` 的历史计划不自动补入新策略，不因新的默认值或模板变化重新 inspect/repack |

新计划保存 `resource_profiling` 的原请求并发、unknown 上限、`worker`/`process` scope、批准引用和 `identity_manifest_digest`；work 的 `resource_profiling` 也参与 work identity。身份清单写在 `evals/<eval-id>/resource-profile-identities.json`。恢复与画像收集校验冻结 digest，不能以今天的 task 文件重建旧执行身份。带新 policy 的远端 work 要求 worker 声明 `resource_profiling: "1"`；旧 worker 不能默默忽略该准入约束。

**资源准入与容器清理证明的覆盖范围仍须区分。** 带新 `resource_profiling` 的 local 单 task-slot（包括 V1 sum、unknown 和明确声明资源的任务）使用持久 Docker daemon 绑定与确认清理后释放额度的流程，覆盖普通执行、physical retry、candidate restart 和 verifier-only；daemon 重启也核查相应 lease/fence。清理失败或身份不明时保留 allocation 并阻止继续调度。旧无 profile 计划以及 coarse/opaque batch 保留原执行路径，不能仅凭 backend 进程结束证明全部容器生命周期已经结束；其并发计数不等于容器级清理保证。远端 allocation 生命周期也不能被本地清理 helper 当作远端容器已清理的证据。

### 13.2 AutomationBench 模板升级

[通用 v4 producer](../benchmark-packages/automationbench/import.mjs) 已为 simulator 写入 `cpus: 1`、`mem_limit: "1024m"`；[v5 resource producer](../benchmark-packages/automationbench/resources.mjs) 对旧导出仅补缺失字段，保留自定义限额及 `deploy.resources.limits` 写法。修改适用于全部受支持 domain，没有 MKT 特例。

重新导出和封存生成新的 task/dataset 身份。新模板的 main/verifier 仍各为 1 CPU/2 GiB，simulator 为 1 CPU/1 GiB；认证阶段预留仍为 2 CPU/3 GiB/2 slots。没有修改旧数据目录、旧计划、snapshot 或评分脚本，也不将旧 MKT partial 用量当作新任务的充分资源证明。

### 13.3 从已有 eval 收集画像与查看建议

将下列 `EVAL_ID`、`TASK_ID` 替换为已有 eval 和其中任务的准确 ID。可加 `--root` 指定该 eval 所在状态目录。

```bash
hitch resources profile --eval EVAL_ID --task TASK_ID --output profile.json
hitch resources recommend --eval EVAL_ID --task TASK_ID \
  --min-complete-trials 3 --output recommendation.json
```

[收集器](../src/evals/resource-profile-collection.ts) 读取冻结 execution plan、身份清单、run bundle 及已知 backend 证据路径，合并同一物理 lease/epoch 的重复观测。它保留 OOM、非零退出、物理重试和缺 execution evidence 的已知执行；重复记录不能增加完整 trial 数，修复后的成功样本不能覆盖此前失败。无法归属的物理执行会留下阻断原因。

画像的完整身份包含 task/集合 digest、harness artifact、controller/runtime、各角色不可变 image digest、平台、backend 版本/provider/lifecycle、输入规模和资源运行参数；任何一项变更都使旧建议或批准不匹配。旧计划没有身份清单、角色镜像 digest 未解析、backend 版本不可用等情况会明确阻断，不从当前磁盘补造身份。目前远端 backend 版本还未与实际执行 worker 绑定，因此返回 `backend_version_unverified_on_provider`，本机 inspector 的版本不能代替它。

[建议报告](../src/evals/resource-profile-recommendation.ts) 包含：

- `current_role_limits`：冻结身份中的各角色每容器 CPU/内存及 replicas；身份不足时不能伪造当前限额。
- `roles`：观测最大值、描述性 P95、测量口径与来源 digest；无样本的角色保留为未测得。
- `group_observations`：阶段/组采样峰值与时间跨度、近似标记；独立容器峰值之和另列，不能充当同时峰值。
- `blocked_reasons`、逐 trial eligibility、覆盖范围和 `actions`：保留限额、补齐生命周期证据；有 OOM/失败时调查后使用新配置重跑。

严格门槛通过时，建议算法为 `observed_max + max(observed_max × 25%, 64 MiB)`，再向上取整到 1 MiB；这仍不是尾部安全保证。当前真实来源始终缺少可靠终态证明，**实际输出 `lowering_eligible: false`，不输出 `suggested_memory_bytes`**。`automatic_application` 始终为 false，CPU/GPU/磁盘及 reservation 不会因该报告自动修改。

`resources profile --input FILE` 可以导入引用 execution evidence 的列表并注明压力输入；`resources recommend --profile FILE` 可以阅读导出的画像。这些文件输入按 `operator-import` 处理，不能凭自填的 complete 或 digest 获得 provider 证明；建议优先用 `--eval/--task` 重新核验冻结来源。单任务 CLI 不自动合并不同任务、输入规模或身份的画像。

### 13.4 显式批准当前资源配置

显式批准是操作者承认当前配置的可审计路径，不要求把 partial 观测伪装成完整证明，也不自动修改硬限制。批准文件记录完整 identity、逐角色 CPU/内存、actor、reason、时间和内容 digest；其结构见 [approval schema](schemas/approved-resource-configuration.schema.json)。它只在身份精确匹配、所有缺失字段所属角色均被覆盖、批准值与当前 effective limits 一致时解除该任务的 unknown 标记；其他任务不因此豁免。

可从上一步报告制作待审配置。此命令仅写出当前限额，没有执行批准：

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync('profile.json', 'utf8'));
const report = JSON.parse(readFileSync('recommendation.json', 'utf8'));
if (!profile.identity || !report.current_role_limits.length) throw new Error('完整冻结身份或当前限额不可用');
const role_limits = report.current_role_limits.map(({ component_id, cpu_millis, memory_bytes }) =>
  ({ component_id, cpu_millis, memory_bytes }));
writeFileSync('resource-config.json', JSON.stringify({ identity: profile.identity, role_limits }, null, 2));
JS
```

操作者审查身份和限额后，显式写入批准记录，并把它用于一个新 eval：

```bash
hitch resources approve --config resource-config.json \
  --actor operator-name --reason "已审查并接受此任务当前的角色限额" \
  --output approved-resource-config.json
hitch eval run --dataset DATASET --harness HARNESS_REF --model MODEL \
  --resource-config approved-resource-config.json
```

HTTP/结构化 eval request 使用 `resource_config` 携带同一批准对象。批准匹配失败会保留 unknown 和具体原因；不能仅按 task ID、benchmark 名称或历史观测免除试跑。若需要改硬限制，先修改 task/Compose 或适用的默认资源策略，生成新计划和身份，再审查相应配置；不能把批准文件当成 overlay。image digest 缺失、旧身份不完整或远端版本未验证时，手工填写 actor/reason 也不能绕过身份门槛。

### 13.5 P1 验证范围

自动测试覆盖未知字段识别、worker/process 共享试跑计数、普通资源容量同时约束、shard/opaque 并发限制、旧 plan 冻结、显式批准匹配与失效、真实 eval 证据入口、OOM/失败及重试保留、CLI 持续采样和内存口径。local task-slot 的清理失败保留额度与重启检查单独覆盖；这些测试不将 coarse/opaque 或 remote 路径升级为已具备完整容器清理证明。

完整 trial 的建议门槛与最大值加余量算法有确定性测试，但不能把测试中的合成完整样本当成真实 provider 已提供可靠终态证明。真实来源仍为 partial，安全降限数字仍被阻断。最终测试数量与检查结果见 §12.2。

### 13.6 合入 dev 前的兼容复核（2026-10-22）

已对齐 `dev@6120740`，保留该分支的环境准备、逐角色镜像绑定、external endpoint 和 shared runtime 行为。画像身份同时绑定冻结 endpoint（包含 generation）、environment binding 与 artifact pins；恢复执行仍复用原 artifact，并可从已验证内容准备 readonly-bind 快照。未知 shard 的初次执行和 infrastructure retry 均使用冻结并发上限。eval、rerun 和 work dispatcher 在取得 collision lock 前检查当前资源及未知额度，避免等待额度时通过锁释放通知形成忙循环；取消和后续准入有回归覆盖。

最终回归合计 **1,076 项，1,059 通过、17 跳过、0 失败、0 取消**：按 macOS CI 约定先单独运行 environment binding 的 14 项，再以并发 4 运行其余 1,062 项。失败项修复后的定向复测另有 **53 通过、1 项平台跳过**。`typecheck`、`build`、`check:architecture`（466 个源文件、993 条跨模块边）、语法检查、中英文 CLI 文档检查、相对 dev 的 `git diff --check` 及 `npm pack --dry-run` 均通过；发布包包含新增阶段屏障、资源画像 CLI 与 schema。平台和外部环境相关跳过不作为真实 provider 的完整生命周期证明，§13.3 的 partial 限制不变。
