# Hitch

[![npm version](https://img.shields.io/npm/v/agent-hitch.svg)](https://www.npmjs.com/package/agent-hitch)
[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/agent-hitch)](https://github.com/rsi-gear/agent-hitch/releases)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord&logoColor=white)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md)

**面向智能体 Harness 的内容寻址版本控制与证据存储。**

Hitch 让每一次智能体运行都可以追溯到确定的 Harness 版本。它将 Harness
引用解析为不可变身份，准备内容寻址的可运行制品，通过稳定接口执行这些
制品，并保存每次运行产生的轨迹与评测证据。

Git 可以标识发生变化的 Harness 源代码，而 Hitch 将这个身份贯穿构建与
执行的全过程：

```text
Harness 引用
  -> 已解析版本
  -> 已准备制品
  -> 运行 / 评测
  -> 轨迹
  -> 反馈与评测证据

Hitch 控制器
  -> 内容寻址的运行时包
  -> 由容器化评测引用
```

Hitch 是开发、比较和演化智能体 Harness 的系统基础设施。它负责版本解析、
可运行制品、执行记录和证据；候选方案生成、比较策略与晋级决策则由使用
Hitch 的上层系统负责。

> **状态：** pre-alpha。核心身份与证据链路已经实现，包括不可变版本解析、
> 制品准备与缓存、直接运行与守护进程运行、Harbor 评测、内容寻址的控制器
> 运行时、兼容 DSH 的规范化轨迹，以及消息反馈。

## 为什么 Harness 需要版本控制？

智能体 Harness 不只是一次源代码提交。实际运行的内容还可能取决于软件包
版本、构建产物、控制器代码、工作区模式、原生适配器，以及机器上可变的
已安装可执行文件。如果分数或记录没有关联这些身份，就很难审计，更难复现。

Hitch 保存从请求的 Harness 引用到执行证据的完整、显式链路：

| 记录 | 标识的内容 |
| --- | --- |
| Harness 引用 | 调用方请求的软件版本、提交、本地源码或已安装可执行文件 |
| 已解析版本 | 为本次运行选定的不可变源码身份 |
| 已准备制品 | 经过验证、采用内容寻址的可运行构建产物 |
| 控制器运行时 | 上传到容器化评测中的确切 Hitch 运行时 |
| 运行或评测记录 | 请求、工作区、生命周期、结果以及各身份之间的关联 |
| 规范化轨迹 | 采用稳定、兼容 DSH 格式记录的智能体消息与工具活动 |
| 反馈与评测证据 | 消息级反馈、验证器输出、奖励及后端记录 |

它是一个本地版本与证据层，不是 Git 的替代品，目前也不是远端制品注册表。
Hitch 当前尚未提供分支、标签、差异比较、候选晋级或回滚策略。

## 快速开始

Hitch 要求 Node.js 22 或更高版本。通过 npm 安装：

```bash
npm install --global agent-hitch
hitch --version
hitch list --json
```

解析并准备一个确定的 Harness 版本：

```bash
hitch resolve codex@version:0.92.0 --json
hitch prepare codex@version:0.92.0 --json
```

在隔离的 Git worktree 中运行这个确定版本：

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --model gpt-5.6-terra \
  --cwd /workspace/project \
  --workspace-mode worktree \
  --prompt-file task.md \
  --output jsonl
```

每次运行都会在 `~/.hitch/runs/RUN_ID` 下写入原子的 manifest 与结果、原始
进程日志、规范化事件和规范化轨迹。可以通过 CLI 检查轨迹：

```bash
hitch trajectory inspect RUN_ID --json
```

从源码检出进行开发：

```bash
npm install
npm run check
npm link
hitch list --json
```

## Harness 引用

每次运行都需要显式选择 Harness。确定的软件包版本与 Git 提交会被解析为
不可变身份，并在 Hitch 的制品存储中完成准备。

```bash
# 使用并指纹识别本机已经安装的可执行文件。
hitch run --harness codex@installed --prompt "Inspect this repository"

# 解析、准备或运行一个确定的已发布版本。
hitch resolve codex@version:0.92.0 --json
hitch prepare codex@version:0.92.0 --json
hitch run --harness codex@version:0.92.0 --prompt "Inspect this repository"

# 从已注册的上游仓库构建一个提交。
hitch run --harness codex@commit:0123456789abcdef --prompt "Inspect this repository"

# 从本地 Harness 仓库构建一个干净的提交。
hitch run \
  --harness 'pi@git+file:///workspace/pi#0123456789abcdef' \
  --prompt "Inspect this repository"
```

`codex` 之类的裸名称是 `codex@installed` 的兼容别名。已安装的可执行文件
适合本地使用；如果需要可移植性，应优先选择确定的版本或提交引用。

版本选择器必须使用确定的语义化版本，不接受版本范围和 `latest` 等可变
标签。短提交 ID 会被展开，并且必须没有歧义。本地 Git 仓库必须处于干净
状态。Codex、Pi 和 DeepSeek Harness 支持从源码提交准备制品；Claude Code
与 OpenCode 目前支持已安装版本和确定的软件包版本。

准备过程会以 Hitch 进程的权限执行已注册的软件包生命周期命令或源码构建
命令。内容寻址让制品可以审计和缓存，但不会让不可信的构建代码变得安全。

## 每次运行的证据

Hitch 将生命周期事件与智能体轨迹保存为两类相关但相互独立的记录：

- 规范化 JSONL 事件描述 Hitch 的控制平面，包括解析、准备、进程生命周期、
  取消和最终状态；
- 兼容 DSH 的规范化轨迹以明确的保真度记录智能体会话、消息、工具调用与
  工具结果；
- `trajectory.ref.json` 将运行与规范化轨迹及其 SHA-256 摘要绑定；
- 反馈 sidecar 可以为助手消息附加带版本的正向或负向评分与备注，而无需
  改写不可变轨迹。

```bash
hitch trajectory inspect RUN_ID
hitch feedback list RUN_ID --json
hitch feedback put RUN_ID \
  --message MESSAGE_ID \
  --rating positive \
  --note "修改保持了足够聚焦" \
  --json
```

带版本的机器接口 Schema 位于 [`docs/schemas`](docs/schemas)。运行时校验会
拒绝未知的请求字段，并在守护进程 HTTP 边界两侧保留类型化错误。

## Harbor 评测

Hitch 可以通过 [Harbor](https://github.com/harbor-framework/harbor) 评测一个
确定且可移植的 Harness 版本：

```bash
# 将固定版本的 Harbor 安装到 ~/.hitch/tools，不修改系统 Python。
hitch eval setup harbor
hitch eval doctor

hitch eval run \
  --backend harbor \
  --dataset terminal-bench@2.0 \
  --harness codex@version:0.92.0 \
  --model openai/gpt-5.6 \
  --attempts 1 \
  --max-concurrent 4

hitch eval list
hitch eval inspect EVAL_ID --json
```

Harbor 负责任务发现、Docker 生命周期、验证与奖励。它的自定义 Hitch agent
会将最小化、采用 SHA-256 寻址的 Hitch 控制器运行时上传到每个任务容器，
并在 `/app` 中执行选定的 Harness 版本。生成的评测记录会关联请求、已解析
版本、控制器运行时、后端配置与日志、规范化结果、奖励摘要和轨迹证据。

评测接受确定的 `version:`、已注册远端的 `commit:`，以及显式本地
`git+file:///绝对路径#<完整小写commit>` 引用。本地 Git 评测只会将该提交
所需并经过校验的 Git 对象包传入 Harbor trial；未提交文件、Git 配置、凭证
和无关历史不会被携带。仓库必须干净，缩写 commit、分支、tag、`HEAD` 和
已安装可执行文件会被拒绝。常用模型供应商凭证通过环境变量引用转发；使用
`--pass-env NAME` 可以额外传入一个环境变量。

有关安装、可移植性规则和执行边界，请参阅
[Harbor 智能体评测](docs/evals.md)。

## 稳定执行层

带版本的制品仍然需要一致的运行方式。Hitch 为 Codex CLI、Claude Code、
Pi、OpenCode 和 DeepSeek Harness 提供适配器，并通过一个面向机器的统一
接口规范化它们的调用方式和生命周期行为。

```text
调用方 -> Hitch CLI / 守护进程 -> 共享运行引擎 -> Codex CLI
                                         \----> Claude Code
                                         \----> Pi
                                         \----> OpenCode
                                         \----> DeepSeek Harness
```

直接 CLI 与持久化守护进程使用同一个运行引擎，因此版本解析、记录、超时、
取消和事件行为不会发生偏移。当前运行时提供：

- 可执行文件发现、版本探测和可执行文件指纹；
- 确定的软件包版本与 Git 提交解析；
- 带完整性校验缓存的不可变制品；
- 输出规范化 JSONL 事件的直接执行；
- 具备并发上限的持久化本地守护进程；
- 队列中及运行中任务的取消、超时与完整进程树清理；
- 受管理的共享、Git worktree 和独立副本工作区模式；
- 原子的 manifest 与结果，以及原始 stdout 和 stderr 日志；
- 守护进程重启后对中断记录的保守恢复。

需要长期运行的队列时，可以通过守护进程执行：

```bash
hitch daemon start --max-concurrent 4

hitch run \
  --daemon \
  --harness codex@version:0.92.0 \
  --cwd /workspace/project \
  --prompt-file task.md \
  --output jsonl

hitch daemon status --json
hitch daemon stop
```

也可以异步提交并取消：

```bash
hitch daemon submit \
  --harness claude@version:EXACT_VERSION \
  --cwd /workspace/project \
  --prompt-file task.md

hitch daemon cancel RUN_ID
```

## 状态与隔离

状态默认存储在 `~/.hitch` 下。可以使用 `--root <path>` 或 `HITCH_ROOT`
修改位置。每个 root 都拥有独立的制品存储、控制器运行时存储、运行与评测
记录、守护进程令牌和队列。

可以通过 `HITCH_CODEX_PATH`、`HITCH_CLAUDE_PATH`、`HITCH_PI_PATH`、
`HITCH_OPENCODE_PATH` 和 `HITCH_DEEPSEEK_PATH` 覆盖原生可执行文件路径。

工作区模式会明确数据修改的边界：

- `shared` 直接在源码目录中运行；
- `worktree` 从干净的 `HEAD` 创建 detached Git worktree；
- `copy` 创建独立的文件系统副本。

工作区隔离并不等同于进程安全沙箱。

## 设计原则

- **默认可追溯：** 每次运行都会关联请求的引用、已解析版本、可运行制品、
  执行记录与证据。
- **不可变解析：** 在准备或执行前将可变输入解析为不可变身份，并记录该
  身份。
- **内容寻址复用：** 通过摘要复用经过验证的制品与控制器运行时，而不是为
  每次运行重复复制。
- **不以有损抽象换取证据统一：** 稳定的规范化记录与原始 Harness 输出并存，
  并明确记录轨迹保真度。
- **机器优先的接口：** 结构化输出、带版本的 Schema 和类型化错误构成公共
  接口。
- **策略位于 Hitch 之上：** 变更、排序、晋级与回滚都是调用方系统的显式
  决策。
- **安全中断：** 取消操作覆盖完整子进程树，涉及工作区修改的中断运行绝不
  隐式重放。

## 计划中的工作

- [ ] Harness 版本及其证据的比较原语
- [ ] 命名的候选与 champion 引用
- [ ] 不内嵌晋级策略的晋级与回滚记录
- [ ] 远端制品与证据同步
- [ ] 更多 Harness 适配器
- [ ] 更多 API 供应商支持
- [ ] 本地模型推理支持

## 动态

- **2026-08-20：** Hitch 0.2 开发版将项目迁移到编译为 ESM 的严格
  TypeScript，加入共享 SHA-256 控制器运行时缓存，为每次运行记录兼容 DSH
  的规范化轨迹，并引入与生命周期绑定的消息反馈。
- **2026-08-13：** Hitch 加入对 DeepSeek Harness 的支持。

## 文档

- [Hitch 0.2 开发规范](docs/hitch-0.2-development-spec.md)
- [设计文档](docs/design.md)
- [智能体守护进程分析与移植](docs/daemon.md)
- [工作区隔离](docs/workspaces.md)
- [Harbor 评测](docs/evals.md)
- [发布流程](docs/releasing.md)

## 社区

加入 [Hitch Discord 社区](https://discord.gg/cZ4NBbHDk)，提问、分享反馈，
并讨论智能体 Harness 基础设施。

## 致谢

Hitch 的设计受到 [Multica](https://github.com/multica-ai/multica) 启发，并
使用 [Harbor](https://github.com/harbor-framework/harbor) 作为评测后端。感谢
这两个项目提供的基础。

## 命名

代码仓库名为 `agent-hitch`；产品与可执行文件分别命名为 `Hitch` 和 `hitch`。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。
