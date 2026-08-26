# Hitch

[![npm version](https://img.shields.io/npm/v/agent-hitch.svg)](https://www.npmjs.com/package/agent-hitch)
[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/agent-hitch)](https://github.com/rsi-gear/agent-hitch/releases)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md)

**让智能体 Harness 的每次运行都可复现。**

Hitch 可以从确定的软件版本或 Git 提交运行 Codex、Claude Code、Pi、OpenCode
和 DeepSeek Harness。每次运行都会关联 Harness 版本、不可变制品、工作区、
轨迹、日志和评测证据。

```text
版本或提交 -> 不可变制品 -> 运行或评测 -> 可验证证据
```

```bash
npm install --global agent-hitch

hitch run \
  --harness codex@version:0.92.0 \
  --prompt "Inspect this repository"
```

> **状态：** pre-alpha。核心运行、来源追踪、轨迹、反馈、守护进程和 Harbor
> 评测链路已经实现。

## 为什么使用 Hitch？

Git 告诉你哪些源码发生了变化，Hitch 则告诉你究竟运行了什么，以及它产生了
哪些证据。

- **复现：** 从确定的软件包版本或源码提交重新运行。
- **比较：** 通过统一的执行契约比较不同 Harness 和模型。
- **审计：** 用不可变制品、原生事件、规范化轨迹、日志、反馈和评测记录验证
  结果。

Hitch 适合构建智能体评测、Harness 实验、Coding Agent 基础设施和自动晋级
流水线的团队。

## 快速开始

Hitch 要求 Node.js 22 或更高版本。

```bash
npm install --global agent-hitch
hitch --version
```

在隔离的 Git worktree 中运行一个确定的 Harness 版本：

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --workspace-mode worktree \
  --prompt "Inspect this repository" \
  --output jsonl
```

输出中包含 run ID，可以用它查看保存的轨迹：

```bash
hitch trajectory inspect RUN_ID
```

每次运行的 manifest、结果、事件、日志和轨迹都会保存在
`~/.hitch/runs/RUN_ID` 下。

## 固定任意 Harness 版本

每次运行都会显式选择 Harness：

```bash
# 对本机已经安装的可执行文件生成指纹并运行。
hitch run --harness codex@installed --prompt "Inspect this repository"

# 解析并运行一个确定的已发布版本。
hitch run --harness codex@version:0.92.0 --prompt "Inspect this repository"

# 从已注册的上游仓库构建并运行一个确定的提交。
hitch run --harness codex@commit:0123456789abcdef --prompt "Inspect this repository"
```

| Harness | 已安装版本 | 确定的软件包版本 | 源码提交 |
| --- | :---: | :---: | :---: |
| Codex | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | — |
| Pi | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | — |
| DeepSeek Harness | ✓ | ✓ | ✓ |

确定的版本和提交会被准备为经过验证、采用内容寻址的制品，并从 Hitch 的本地
缓存中复用。已安装的可执行文件适合本地工作；需要可移植性时，应使用不可变
引用。

## 每次运行都会留下证据

Hitch 记录从请求到结果的完整链路：

- 请求的引用及解析后的不可变版本；
- 经过验证、采用内容寻址的可运行制品；
- 工作区、模型身份、生命周期与最终结果；
- 规范化控制面事件与原始进程日志；
- 支持场景下经过脱敏的 provider-native 事件；
- 采用 SHA-256 绑定文件、兼容 DSH 的规范化轨迹；
- 带版本的消息反馈与评测证据。

可以通过 CLI 查询运行，并在不改写轨迹的情况下附加反馈：

```bash
hitch runs list --json
hitch feedback list RUN_ID --json
hitch feedback put RUN_ID \
  --message MESSAGE_ID \
  --rating positive \
  --note "修改保持了足够聚焦"
```

带版本的机器接口 Schema 位于 [`docs/schemas`](docs/schemas)。

## 可复现的智能体评测

Hitch 集成了 [Harbor](https://github.com/harbor-framework/harbor)，可以在 Docker
中评测确定且可移植的 Harness 版本：

```bash
hitch eval setup harbor
hitch eval doctor

hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --model openai/gpt-5.6
```

每次评测都会关联已解析的 Harness 版本、采用内容寻址的 Hitch 控制器运行时、
后端配置、奖励、日志和轨迹证据。安装方法和可移植性规则参见
[Harbor 智能体评测](docs/evals.md)。

## 为自动化而设计

- 提供 JSON 和 JSONL 输出、带版本的 Schema 与类型化错误
- 支持直接执行或具有并发上限的持久化守护进程
- 支持共享、detached Git worktree 和独立副本工作区
- 支持超时、取消、进程树清理和中断运行恢复
- 通过 `--root <path>` 或 `HITCH_ROOT` 隔离本地状态

需要长期执行队列时，可以启动守护进程：

```bash
hitch daemon start --max-concurrent 4
hitch run --daemon --harness codex@version:0.92.0 --prompt-file task.md
```

## 文档

- [设计与架构](docs/design.md)
- [Harbor 评测](docs/evals.md)
- [工作区隔离](docs/workspaces.md)
- [守护进程设计](docs/daemon.md)
- [Hitch 0.2 开发规范](docs/hitch-0.2-development-spec.md)
- [发布流程](docs/releasing.md)

## 项目状态

Hitch 是 pre-alpha 阶段的本地版本与证据层。它是 Git 的补充，目前不提供远端
制品注册表、分支、标签、候选晋级或回滚策略。

远端制品同步、命名候选、晋级记录和更多 Harness 适配器已列入计划。

## 社区

加入 [Hitch Discord 社区](https://discord.gg/cZ4NBbHDk)，提问、分享反馈，
并讨论智能体 Harness 基础设施。

Hitch 的设计受到 [Multica](https://github.com/multica-ai/multica) 启发，并使用
[Harbor](https://github.com/harbor-framework/harbor) 作为评测后端。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。
