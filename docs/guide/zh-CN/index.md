# Hitch 用户指南

Hitch 同时评测模型与智能体 Harness：固定 Harness 比较模型，或固定模型比较 Harness 版本。Daemon 在统一资源预算内调度并行任务，并依据持久化执行记录恢复支持场景下的中断评测。

Hitch 接受 Harbor 兼容的任务定义，接入已有 Benchmark 和自定义任务。[Benchmark Package](../../benchmark-packages.md) 定义输入、工具、生命周期与评分规则；Hitch 管理执行编排和结果证据。当前执行后端为 Harbor。

## Quick Start：快速开始

需要 Node.js 22+、Git、模型访问权限，以及一个干净的 Git 仓库。从该仓库运行以下命令；使用 `worktree` 模式时，`git status --short` 必须没有变更输出。Login 命令会启动 Codex 的认证流程。

在 0.2.10 发布到 npm 前，请按[源码安装说明](model-inference.md#使用当前-dev-构建)使用当前 dev。

```bash
npm install --global agent-hitch@0.2.10
npx --yes @openai/codex@0.92.0 login
git status --short
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "总结这个仓库，不要修改文件。" \
  --timeout 5m \
  --output json
```

把 `RUN_ID` 换成返回的 `run_id`，查看结果：

```bash
hitch runs inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
```

除了答案，还要检查运行状态和退出码。[Quick Start：快速开始](quickstart.md) 包含详细认证说明、工作区选择，以及下一步：向 daemon 提交两个独立任务。

## 并行执行与中断恢复

同一状态目录中的 Run 和 Evaluation 由一个 daemon 协调。多个提交共享 CPU、内存和容器容量；任务成员已知的评测按任务轮转调度。调用方断开后，可以凭原 Eval ID 重新观察同一次评测。

Daemon 崩溃后，支持恢复的本地 Docker 评测可以重新接管经过身份验证的存活 Harbor 进程，或收集其已完成结果，再继续尚未启动的任务。普通 Harness Run 和执行状态不明确的任务有不同恢复规则。[Daemon：并行与恢复](daemon.md) 给出可运行配置、并发计算示例和具体恢复边界。

## 从这里开始

1. [Quick Start：快速开始](quickstart.md)：安装、认证、运行任务，再提交并行任务。
2. [本地与远程模型推理](model-inference.md)：选择模型 API、本机 SGLang 或远程模型节点。
3. [固定版本与隔离工作区](versions-and-workspaces.md)：选择实际执行的程序及其工作文件。
4. [查看运行与证据](runs-and-evidence.md)：查询结果、轨迹、Verifier 输出和反馈。
5. [第一次评测](evaluations.md)：检查 Docker 和 Harbor，运行一个示例任务，理解分数。
6. [Daemon：并行与恢复](daemon.md)：理解调度、统一资源预算、持久化提交和崩溃恢复。
7. [日常运行与排错](operations.md)：取消任务、查询状态和诊断失败。
8. [CLI 命令参考](cli-reference.md)：查询所有命令、参数、筛选条件和集成入口。

## Hitch 连接的四个概念

| 概念 | 含义 |
| --- | --- |
| Harness | Codex、Claude Code、Pi、OpenCode 或 DeepSeek Harness 等智能体程序，与程序调用的模型不同。 |
| Revision 与 Artifact | 选择的软件包版本或 Git 提交，以及从它准备并验证过的可执行文件。 |
| Run | 一次调用，包含提示词、工作区、模型选择、生命周期和结果。ID 以 `run_` 开头。 |
| Evaluation | 在数据集任务上评测一组模型与 Harness 配置。兼容的无工具任务使用可信的 `model-call` 驱动。ID 以 `eval_` 开头，各 Trial 会引用普通 Hitch Run。 |

```text
模型 + Harness + 任务 → 版本化实验 → 执行 → 结果与证据
```

固定 Harness 能标识实际执行的程序。重复实验还需要保留提示词、工作区、数据集、模型配置和环境。远端模型仍可能生成不同答案。

## 开始前准备

- 安装 Node.js 22 或更高版本。Git worktree 隔离和从源码准备 Harness 还需要 Git。
- 配置所选 Harness 和模型服务的认证。Hitch 本身不提供模型访问权限。
- 本地运行不需要 Docker。Harbor 评测需要 Python 3.12 或更高版本，以及正常运行的 Docker daemon。
- 示例使用 macOS 或 Linux 的 POSIX Shell。Windows 用户可使用对应 PowerShell 写法或 POSIX Shell；恢复能力的限制见[日常运行](operations.md)。

本指南对应处于 pre-alpha 阶段的 Hitch 0.2.10。运行 `hitch --version` 查看本机版本；使用其他版本时，以该版本的命令和 Schema 为准。

## 深入阅读

本指南围绕用户操作组织。详细约定见[工作区隔离](../../workspaces.md)、[Harbor 评测](../../evals.md)、[Verifier evidence](../../verifier-evidence.md)、[Benchmark packages](../../benchmark-packages.md)和[架构设计](../../design.md)。
