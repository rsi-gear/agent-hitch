# Quick Start：快速开始

安装 Hitch，在仓库里运行 Codex，查看证据，再向 daemon 提交两个独立任务。示例要求智能体检查文件，不修改内容。步骤 1–5 不需要 Docker；并行示例会显式声明一份较小的宿主机资源预算。

## 1. 安装 Hitch

在 0.2.10 发布到 npm 前，请按[源码安装说明](model-inference.md#使用当前-dev-构建)使用当前 dev。

```bash
node --version
npm install --global agent-hitch@0.2.10
hitch --version
hitch list
```

Node 版本必须为 22 或更高。`hitch list` 发现支持的 Harness 并报告本地可用情况；即使没有全局安装 Harness，也可以从确定的软件包引用准备它。

## 2. 完成 Harness 认证

Hitch 以非交互方式启动 Harness，所以应先完成认证。对于示例中的 Codex 版本：

```bash
npx --yes @openai/codex@0.92.0 login
```

按 Codex 提示完成登录。API key 和无界面环境的配置见 [Codex 认证文档](https://developers.openai.com/codex/auth)。认证方式和模型可用性取决于你的账号。这里固定的 Harness 版本用于示例，不代表最新版本。

如果已在使用其他支持的 Harness，可用 `hitch inspect pi --json` 查看其要求，把 `pi` 换成对应 ID，完成该 Harness 的认证后再选择其引用。

## 3. 选择干净的仓库

进入希望智能体检查的 Git 仓库，确认当前状态：

```bash
git status --short
```

使用 `worktree` 模式时，这条命令应没有输出：暂存、未暂存和未跟踪的文件都算变更。先提交或妥善保存这些变更。若希望把当前未提交内容一起交给智能体，可使用 `--workspace-mode copy`，详见[工作区模式](versions-and-workspaces.md)。

## 4. 运行任务

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "总结这个仓库和它的测试命令，不要修改文件。" \
  --timeout 5m \
  --output json
```

首次运行会解析并准备软件包，可能需要访问网络。后续运行会复用经过验证的缓存制品。`--output json` 输出最终结果；想实时观察生命周期事件时，使用 `--output jsonl`。

示例使用 Harness 配置的默认模型。可以添加 `--model MODEL_ID` 显式选择模型，把 `MODEL_ID` 替换为该 Harness 接受、且你的账号可用的 ID。Hitch 会把选择传给 Harness，不同适配器的 provider 前缀写法不能直接互换。

本地 SGLang、远程模型节点和自建 API 的配置方式见[本地与远程模型推理](model-inference.md)。

## 5. 确认结果

从输出复制 `run_id`。把下面的 `RUN_ID` 替换为完整值，包括 `run_` 前缀：

```bash
hitch runs inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
hitch workspace path RUN_ID
```

命令结束不一定意味着任务成功。检查运行状态、退出码、最终输出和错误。轨迹视图展示可用的对话与工具证据；如果 Harness 在采集开始前就启动失败，可能没有轨迹。

运行记录保存在 `~/.hitch/runs/RUN_ID/`。Hitch 会保留托管工作区，不会自动把智能体修改合并回源码仓库。

## 6. 提交两个并行运行

从已完成认证的 Shell 启动一个 daemon。下面给 Hitch 分配 2 CPU、2 GiB 预算，请按宿主机可用容量调整。如果这个 root 已有 daemon，先检查状态并使用现有实例，不要重复启动。

```bash
hitch daemon start \
  --max-concurrent 2 \
  --capacity-cpu-millis 2000 \
  --capacity-memory-mib 2048 \
  --container-slots 2
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "总结架构，不要修改文件。" \
  --timeout 5m
hitch daemon submit \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "找出测试命令，不要修改文件。" \
  --timeout 5m
hitch daemon status --json
hitch runs list --json
```

每次 submit 返回不同的 Run ID，不等待执行结束，所以不需要 Shell 的 `&`。每个 Run 都有独立 worktree。两者同时处于活动状态且资源预算足够时，就可以重叠执行；较快的任务也可能在查询前已经完成。分别使用返回的 ID 执行前面的 `hitch runs inspect` 和 `hitch trajectory project`。声明两个容器槽位不会启动 Docker，这两个普通 Run 仍在宿主机上执行。

提交 CLI 退出后，daemon 会继续已接受的工作。Daemon 自身崩溃则是另一种情况：未完成的普通 Run 会标记为 `daemon_restarted`，支持场景下的 Evaluation 则有租约恢复机制。依赖无人值守恢复前，请阅读 [Daemon：并行与恢复](daemon.md)。

下一步[运行小规模 Docker 评测](evaluations.md)。如果上面的 daemon 仍在运行，把教程命令改为 `hitch eval run --daemon`，让评测使用同一资源预算。失败时参照[排错表](operations.md)。
