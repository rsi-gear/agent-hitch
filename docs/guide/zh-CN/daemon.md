# Daemon：并行与恢复

Daemon 是 Hitch 长时间运行任务的协调者。它独立于提交命令接收请求，让 Run 和评测共享资源，并持久化执行状态，以便在中断后恢复受支持的评测。断开连接后，可以随时通过原 ID 回来查看进展。

## 启动统一的协调者

每个 Hitch 状态目录使用一个 daemon。普通后台 Run 和评测共享 CPU、内存预算；评测还会预留容器与镜像构建槽位。不同 root 拥有独立调度器，不会共同协调同一主机的容量。

先完成[评测环境准备](evaluations.md)，包括 Harbor、Docker 和容器认证。这个 Codex 示例需要从已经配置 `CODEX_API_KEY` 的 Shell 启动 daemon；之后在其他 Shell 修改环境变量，不会更新运行中的 daemon。

```bash
hitch daemon status --json
```

若处于停止状态，再按实际可供 Hitch 使用的容量启动。下面分配 4 个 CPU、8 GiB 内存、4 个容器槽位，并允许同时构建 1 个镜像：

```bash
hitch daemon start \
  --max-concurrent 4 \
  --capacity-cpu-millis 4000 \
  --capacity-memory-mib 8192 \
  --container-slots 4 \
  --build-slots 1
```

记录这些资源参数，后续启动时继续使用。如果 daemon 已在运行，先检查并使用现有配置。需要更改配置时，应先处理其活动任务；`hitch daemon stop` 会在关闭时取消活动任务，不是暂停命令。

## 提交后立即返回

把下面的数据集路径替换为包含多个独立任务的本地 Harbor 数据集。指南的 `docs/guide/examples` 也可用于验证提交，但其中只有一个任务，不能展示同一评测内多个 Trial 并行。Codex 权限参数仅用于这些可信任务容器。

```bash
hitch eval submit \
  --dataset /absolute/path/to/harbor-dataset \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --provider local-docker \
  --cpu-per-trial 2 \
  --memory-per-trial 4GiB \
  --attempts 1 \
  --max-concurrent 8 \
  --timeout 5m \
  --setup-timeout 15m \
  --idempotency-key parallel-demo-01
```

提交会持久化请求并返回 `eval_id`。用该值替换下面的 `EVAL_ID`：

```bash
hitch eval watch EVAL_ID --output jsonl
hitch eval inspect EVAL_ID --json
hitch daemon status --json
```

Watch 只观察进展；重新连接同一 ID 不会启动另一场评测。希望在一个命令中提交并等待时，使用 `hitch eval run --daemon`，配合相同的执行参数。

要提交第二场评测，重复提交命令，并换用新幂等键，例如 `parallel-demo-02`。两场评测共享 daemon 的总容量。如果提交响应丢失，用原幂等键重试原请求，会取回同一次评测；同一键配合不同输入会报 `idempotency_conflict`。

## 并行度由什么决定

三类限制共同决定实际并行度：

| 控制项 | 限制范围 |
| --- | --- |
| `hitch daemon start --max-concurrent` | 普通 Harness Run 的并发数。未显式配置容器槽位时，还参与默认槽位数量计算；它不是统一的评测数量上限。 |
| `hitch eval submit --max-concurrent` | 当前评测请求的 Trial 并行度，不会立即预留这么多 Worker。 |
| Daemon 总资源与单个 Trial 的需求 | 所有评测和普通后台 Run 合计能同时执行多少工作。CPU、内存、容器槽位及其他已配置资源必须一起满足。 |

在上面的预算下，每个 Trial 需要 2 CPU、4 GiB，所以最多同时运行两个。即使评测请求并发 8、总容器槽位为 4，也不能突破 CPU 和内存预算。这个计算假设任务相互独立、没有其他活动工作，且任务元数据或 Sidecar 没有额外资源需求。两场评测共享这两个可用 Trial 槽位，不是各自获得两个。

```text
评测 A ────┐
评测 B ────┼─ 共享 CPU / 内存 / 容器预算 ─ 满足条件的任务槽位
宿主机 Run ─┘
```

对任务成员已知的数据集，调度器在任务边界轮转不同评测的队列，启动前统一预留所需资源，并检查任务冲突锁。不同且满足条件的任务可以并行；同一冲突域内，同一任务的多次 Attempt 保持顺序。某个任务暂时无法执行时，其他符合条件的任务仍有机会获得调度。任务成员不可见的数据集使用较粗粒度的分配路径，不具备相同的细粒度调度保证。

Docker Trial 会获得 CPU 和内存限制。普通宿主机 Run 的预留用于调度记账，不是操作系统对进程的资源硬限制。省略容量参数时，Hitch 尝试检测 Docker 容量，并在无法检测时采用保守默认值；提高并发前，先用 `hitch daemon status --json` 查看实际预算和占用。

托管本机 SGLang 的服务预留进入统一账本，远程模型节点管理自己的 GPU；外部模型服务的资源和请求队列则需单独预算。并发设置与模型服务恢复见[模型推理容量](model-inference.md#协调-daemon-与推理容量)。

## 评测为什么能够恢复

恢复依靠持久化的执行状态衔接原评测：

1. **持久化请求与计划。** Hitch 保存已接收的请求、解析后的输入、Task/Attempt 计划和发布进度。重启后，尚在排队的评测可以重新进入队列。
2. **执行租约与进程身份。** 租约记录当前执行的归属。恢复本地执行时，同时核验进程启动身份和 PID，避免把复用的 PID 误认为原进程。接管会推进租约 epoch，使旧持有者无法更新新租约。
3. **可补收的输出与幂等发布。** 本地执行独立于 daemon 记录退出状态和输出。恢复时可以收集已完成的结果，并以幂等方式发布；已发布的槽位会被跳过，确认尚未启动的槽位则可以按保存的计划继续调度。

这些机制让评测围绕已有 Candidate 执行恢复进展。它们不会从轨迹重建智能体会话，也不会自动重放执行状态不明确的 Candidate。

## 不同中断会发生什么

| 中断事件或已保存状态 | 恢复行为 |
| --- | --- |
| 提交 CLI 或 Watcher 断开 | Daemon 继续执行已接收的任务；使用原 ID 重新观察。 |
| Daemon 重启，评测仍在排队 | 根据持久化提交重新入队。 |
| 受支持的本地 Harbor 执行仍存活 | 在 POSIX 上核验并接管原进程，等待结束并收集结果。 |
| 执行已结束，但结果尚未收集 | 补收完整证据并协调发布，不启动新 Candidate。 |
| 部分任务已发布，其他任务从未启动 | 保存的执行计划完整且一致时，跳过已发布槽位，继续调度未启动工作。 |
| 进程身份、执行状态或保存的计划不明确 | 报告失败，例如 `execution_state_ambiguous`；先检查，再显式选择修复方式。 |
| Daemon 崩溃时，普通 Harness Run 处于 queued、preparing 或 running | 重启后，没有终态结果的未完成 Run 会以 `daemon_restarted` 标记失败，不会自动续跑。 |

Daemon 硬崩溃后的本地存活进程接管仅支持 POSIX。Windows 可以利用已记录的终态证据和显式修复路径，但不具备这种实时重连保证。主机重启、容器丢失或状态目录被删除，也不同于仅 daemon 进程退出。

## 回到中断的评测

先检查 daemon 状态。如果已经停止，使用与之前相同的状态目录、认证和资源配置启动。默认 root 为 `~/.hitch`；自定义 `--root` 时，每条命令都要保持一致。让恢复流程协调保存的状态，然后查看原评测：

```bash
hitch eval inspect EVAL_ID --json
hitch eval watch EVAL_ID --output jsonl
hitch daemon logs -n 50
```

需要修复时，显式选择对应方式：

| 修复方式 | 含义 |
| --- | --- |
| `hitch eval rerun EVAL_ID --invalid` | 默认 `candidate-restart`：为选中的无效或缺失槽位重新执行 Candidate，可能再次调用模型。有效零分不属于无效槽位。 |
| `hitch eval rerun EVAL_ID --invalid --type collect-only` | 在能够确认隔离执行及其证据时，导入完整的迟到结果；不重跑智能体，缺少证据则拒绝。 |
| `verifier-only` | 仅对受支持的冻结 Benchmark 执行重新评分，要求完整 Candidate 制品与独立 Verifier。它不适用于所有任务，也不适用于本指南的共享环境示例。 |
| `candidate-resume` / `trajectory-replay` | 预留模式；目前缺少所需沙箱 Checkpoint 和适配器原生支持时会被拒绝，不会静默转换成重新执行。 |

取消意图也会持久化：原评测使用 `hitch eval cancel EVAL_ID`，重跑使用 `hitch eval rerun-cancel EVAL_ID RERUN_ID`。Daemon 重启不会清除取消意图。

命令契约和修复前提见 [Harbor 评测参考](../../evals.md)。选择状态目录、取消任务和常见排错见[日常运行与排错](operations.md)。
