# 日常运行与排错

所有命令与参数见 [CLI 命令参考](cli-reference.md)。

单次交互流程可以直接运行。需要让任务在提交命令结束后继续执行，或共享受管理的队列时，使用 daemon。调度模型和崩溃恢复流程见 [Daemon：并行与恢复](daemon.md)。

## 提交后台运行

从已配置所需 Harness 认证的 Shell 启动 daemon。长期运行的 daemon 使用自身进程环境，之后在其他 Shell 导出变量不会更新它。

```bash
hitch daemon start --max-concurrent 2
hitch daemon status --json
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不修改文件" \
  --timeout 5m
```

提交后立即返回 Run ID，不等待执行完成。用 `hitch runs inspect RUN_ID --json` 查询。希望命令等待结果时，使用 `hitch run --daemon ...` 或 `hitch daemon submit ... --wait`。

```bash
hitch daemon cancel RUN_ID
hitch daemon logs -n 50
```

取消操作针对该 daemon 的运行。删除保留的工作区前，先保存需要的结果。

## 排队执行评测

Daemon 启动后，从评测教程使用的源码仓库提交：

这个 Codex 示例需要在启动 daemon 前，为其进程环境配置 `CODEX_API_KEY`，详见[评测准备](evaluations.md)。下面的 Codex 权限参数仅作用于可信任务容器。

```bash
hitch eval submit \
  --dataset docs/guide/examples \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 \
  --max-concurrent 1 \
  --timeout 5m \
  --setup-timeout 15m \
  --idempotency-key hello-hitch-01
hitch eval watch EVAL_ID --output jsonl
```

仅在希望用相同输入取回同一次提交时复用幂等键。同一键配合不同请求会报 `idempotency_conflict`；新实验应使用新键。

```bash
hitch eval cancel EVAL_ID
```

评测的 `--max-concurrent` 是上限，实际并发还取决于共享 CPU、内存和容器容量。Daemon 会尽可能检测 Docker 容量；提高并发前检查状态并阅读[并行度由什么决定](daemon.md#并行度由什么决定)。Daemon 占用同一 Hitch root 时，直接评测会被拒绝，应通过 daemon 提交，或明确选择独立 root。

## 使用独立状态目录

```bash
hitch --root /absolute/path/to/hitch-state runs list --json
```

`--root` 优先于 `HITCH_ROOT`，默认是 `~/.hitch`。启动 daemon、提交、查询和取消时使用相同 root。状态目录放在被管理源码仓库之外。独立 root 隔离状态和队列，但不会协调同一 Docker 主机的总资源。

不再需要 daemon，并已检查其活动任务后，可以停止它：

```bash
hitch daemon stop
```

停止会在关闭期间取消活动任务，不能用于暂停后续跑。

## 诊断失败

| 现象 | 下一步检查 |
| --- | --- |
| 找不到 `hitch` | 检查 Node.js 和全局 npm 可执行目录是否在 `PATH`。 |
| 找不到已安装 Harness | 运行 `hitch list` 和 `hitch inspect HARNESS --json`；未安装时可选择支持的精确软件包引用。 |
| 认证或模型访问失败 | 检查 Harness 登录、模型 ID 和服务权限。评测要确认认证传入容器；daemon 任务要检查其进程环境。 |
| Worktree 创建失败 | 运行 `git status --short`，包含未跟踪文件。保存变更或选择 `copy`，把状态目录移出源码。 |
| 模型在宿主机可用，评测无法连接 | 检查容器地址与凭据传递，见[模型服务访问](model-inference.md#从-docker-评测访问模型)。 |
| Copy 准备失败 | 停止对源目录的并发写入，检查已初始化 submodule 或链接式嵌套工作区。 |
| Eval doctor 报错 | 启动 Docker，选择 Python 3.12+，完成 `hitch eval setup harbor`。使用本地模型时，缺少认证可能只是警告。 |
| 评测持续排队 | 检查 `hitch daemon status --json` 和资源容量，再决定是否提高并发。 |
| 没有评测分数 | 检查 Trial 的 Run 和 Verifier evidence，诊断无效 observation，不要记成零分。 |
| 轨迹缺失或读取被拒绝 | 检查启动是否完成、轨迹引用是否有 canonical checksum。不要修改存储证据来绕过校验。 |
| 查询不到已有 ID | 确认 `run_` 或 `eval_` 前缀，以及所选状态目录。 |

报告问题时，记录 Hitch 版本、移除密钥后的命令、退出码及相关 Run/Eval ID。分享日志前先在本地检查。可以通过 [Issue tracker](https://github.com/rsi-gear/agent-hitch/issues) 或 [Discord](https://discord.gg/cZ4NBbHDk) 提问。

## 恢复边界

Daemon 崩溃后，评测恢复利用持久化请求、计划、租约和发布进度，将已接收的评测重新入队、接管身份可核验的本地执行、补收完整结果，并继续确认尚未启动的工作。本地存活 Harbor 进程接管仅支持 POSIX。

没有终态结果的未完成普通 Harness Run 会以 `daemon_restarted` 标记失败；执行状态不明确的 Candidate 不会被静默重放。Hitch 保留证据和托管工作区，不会自动合并智能体修改。提交替代任务前，先按[中断场景与恢复步骤](daemon.md#不同中断会发生什么)检查原执行。
