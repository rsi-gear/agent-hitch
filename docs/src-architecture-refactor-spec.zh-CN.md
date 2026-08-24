# Hitch `src` 架构优化与渐进式重构规范

- 状态：Implemented
- 目标版本：`0.2.x` 完成目录收口并移除旧程序化入口
- 适用范围：`src/`、对应测试、构建与架构检查脚本
- 变更类型：内部架构重构；默认不改变产品行为、公开 CLI 或持久化格式

## 1. 摘要

当前 `src/` 同时存在两种组织方式：较新的能力使用领域目录，较早的能力仍以大型根级文件平铺。结果是逻辑边界已经出现在设计文档中，但物理目录、依赖方向和测试入口尚未统一。

本规范要求将代码组织为五层：

1. 纯领域契约；
2. 基础设施原语；
3. 可独立测试的核心能力；
4. 业务编排与运行时；
5. 用户接口。

迁移完成后仅保留各顶层模块的 `index.ts` facade；原根级模块、领域聚合兼容文件和对应 package 子路径全部删除。

## 2. 背景与问题

### 2.1 当前事实

当前最大的四个实现文件为：

| 文件 | 行数（基线） | 混合的主要职责 |
| --- | ---: | --- |
| `artifacts.ts` | 1255 | revision resolution、npm/git 获取、缓存、锁、完整性校验、制品准备 |
| `workspaces.ts` | 996 | 规划、生命周期、Git worktree、目录复制、摘要、锁、恢复与删除 |
| `engine.ts` | 911 | 请求校验、manifest、执行、进程监管、事件、轨迹、结果持久化 |
| `cli.ts` | 859 | 命令路由、参数解析、业务调用、渲染、daemon 进程管理 |

设计文档已经提出 `domain/`、`revisions/`、`artifacts/`、`runs/`、`evals/`、`daemon/`、`cli/` 等边界，但当前只有部分边界形成目录。评测相关逻辑还分散在 `evals.ts`、`eval-runs.ts`、`eval-tools.ts`、`harbor-backend.ts` 和 `local-git-transport.ts` 中。

当前运行时 import graph 没有循环依赖，但存在跨模块的类型依赖环。这说明实现仍可安全渐进重构，但边界继续扩张前需要自动化约束。

### 2.2 根因

1. 功能以纵向增量快速加入，目录治理滞后于功能交付。
2. 文件最初按“一个能力一个文件”创建，能力增长后没有继续拆分。
3. 设计文档描述了目标依赖方向，但构建流程没有检查边界、循环或兼容层滥用。
4. 测试直接导入具体实现文件，使物理路径逐渐变成隐式接口。
5. npm 包包含 `dist/src/`，但没有通过 `exports` 明确区分公开 API 与内部实现。

## 3. 目标

重构完成后必须满足：

1. 从目录即可判断代码所属业务边界和依赖层级。
2. CLI、daemon、eval 和 run orchestration 不再与底层存储或 provider 实现混在同一文件。
3. 每个模块提供小而稳定的 facade；跨模块调用优先通过 facade。
4. 跨模块不存在运行时或类型依赖环。
5. `domain/` 保持纯函数与纯类型，不依赖 Node.js API、文件系统、进程或网络。
6. 迁移期间保持 CLI、退出码、事件、Schema、状态目录和内容摘要兼容。
7. 架构约束由 CI 自动检查，而不是仅依赖文档和评审记忆。

## 4. 非目标

本次重构不包含：

- 修改 CLI 命令、参数或默认值；
- 修改 daemon HTTP API；
- 修改已发布 JSON Schema 或磁盘路径；
- 修改 artifact、workspace、run、eval 或 trajectory 的身份计算；
- 引入依赖注入框架、Web 框架或新的运行时 npm 依赖；
- 同时重写所有业务逻辑；
- 为追求文件数量而拆分天然内聚的小模块。

任何确需改变上述行为的工作必须单独立项，并使用独立的 Schema/协议版本和迁移说明。

## 5. 架构原则

### 5.1 领域优先，技术细节下沉

顶层目录表示稳定的业务边界。文件名表示边界内部的角色，例如 `request.ts`、`store.ts`、`executor.ts`，而不是再次重复模块名称。

### 5.2 编排与机制分离

应用服务负责“按什么顺序做什么”；文件系统、Git、子进程、HTTP 和格式编解码负责“具体怎样做”。编排模块不得复制底层机制。

### 5.3 依赖指向稳定契约

provider、backend 和存储实现依赖纯契约；高层服务选择具体实现。不得让底层实现反向导入高层 service 类型来复用一个 interface。

### 5.4 显式 facade

每个顶层业务模块提供 `index.ts`，只导出允许跨边界使用的符号。跨模块代码不得深层导入另一个模块的内部文件；测试内部细节时可以使用明确标记的内部路径。

### 5.5 Facade 优先的渐进迁移

文件移动与行为修改分开提交。先建立 facade，再移动实现并迁移调用方，最后删除旧入口和拆分职责。每一步都必须可构建、可测试、可回退。

## 6. 目标目录

```text
src/
  domain/
    ids.ts
    revisions.ts
    artifacts.ts
    workspaces.ts
    runs.ts
    evals.ts
    trajectories.ts
    feedback.ts
    controller-runtime.ts
    eval-records.ts
    validation.ts
    index.ts

  foundation/
    config.ts
    errors.ts
    fs.ts
    locks.ts
    process.ts
    executable.ts
    hash.ts
    line-stream.ts
    package-root.ts
    index.ts

  adapters/
    contract.ts
    catalog.ts
    discovery.ts
    providers/
      claude.ts
      codex.ts
      deepseek.ts
      opencode.ts
      pi.ts
      shared.ts
    index.ts

  revisions/
    reference.ts
    resolver.ts
    sources/
      installed.ts
      npm.ts
      git.ts
    index.ts

  artifacts/
    types.ts
    preparer.ts
    store.ts
    integrity.ts
    index.ts

  controller-runtime/
    hash.ts
    store.ts
    index.ts

  trajectories/
    contract.ts
    format.ts
    projector.ts
    store.ts
    provider-capture.ts
    providers/
      deepseek.ts
    index.ts

  feedback/
    service.ts
    index.ts

  workspaces/
    types.ts
    planner.ts
    lifecycle.ts
    store.ts
    git.ts
    copy.ts
    digest.ts
    utils.ts
    index.ts

  runs/
    request.ts
    manifest.ts
    identity.ts
    executor.ts
    finalizer.ts
    events.ts
    records.ts
    query.ts
    compare.ts
    queued.ts
    outcome.ts
    index.ts

  backends/
    contract.ts
    harbor/
      backend.ts
      tools.ts
      local-git-transport.ts
      index.ts
    index.ts

  evals/
    request.ts
    service.ts
    trial-import.ts
    records.ts
    events.ts
    index.ts

  daemon/
    auth.ts
    client.ts
    launcher.ts
    server.ts
    scheduler.ts
    index.ts

  cli/
    main.ts
    arguments.ts
    output.ts
    commands/
      list.ts
      inspect.ts
      resolve.ts
      prepare.ts
      run.ts
      runs.ts
      compare.ts
      eval.ts
      workspace.ts
      trajectory.ts
      feedback.ts
      daemon.ts
    index.ts
```

`src/` 根目录不包含 TypeScript 源文件；所有程序化入口均由上述模块 facade 提供。

## 7. 模块职责

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `domain` | branded IDs、跨边界 wire types、纯校验、状态枚举、稳定 DTO | I/O、日志、进程、路径解析、服务编排 |
| `foundation` | 配置、错误、原子文件操作、锁、进程监管、通用流处理 | 业务状态机和 provider 规则 |
| `adapters` | agent 能力声明、请求规范化、启动规格、事件翻译、发现 | artifact 缓存、run 生命周期、eval 编排 |
| `revisions` | harness reference 解析、revision 解析、source selection | 制品安装缓存和执行 |
| `artifacts` | prepared artifact 创建、缓存、完整性与调用入口 | revision 语法、run 生命周期 |
| `controller-runtime` | controller payload 的 hash、cache、verify 和引用 | Harbor trial 编排 |
| `trajectories` | canonical session 投影、provider capture、存取和校验 | run 的总体成功/失败决策 |
| `feedback` | trajectory 绑定的 message feedback 生命周期 | CLI 渲染和 run 执行 |
| `workspaces` | workspace 规划、准备、恢复、终结、删除、摘要 | agent 执行和 eval 聚合 |
| `runs` | run 请求、manifest、执行编排、终结、记录、查询、比较 | daemon HTTP、CLI 参数、具体 eval backend |
| `backends` | 外部 evaluation backend 契约与 Harbor 实现 | eval 记录所有权和 CLI |
| `evals` | eval 请求、backend 选择、trial 导入、eval 记录与聚合 | Harbor 子进程细节、run 内部执行机制 |
| `daemon` | 本地认证控制面、队列、调度、取消和恢复 | agent/provider 语义、CLI 输出 |
| `cli` | 命令路由、参数转换、调用 application facade、用户输出 | 核心业务规则和持久化实现 |

## 8. 依赖规则

### 8.1 允许的总体方向

```text
cli
  -> daemon, evals, runs, feedback, trajectories, artifacts, revisions, adapters

daemon
  -> runs, workspaces

evals
  -> backends, runs, artifacts, revisions, controller-runtime, workspaces

runs
  -> artifacts, revisions, adapters, workspaces, trajectories

feedback
  -> trajectories

backends
  -> domain, foundation

core capabilities
  -> domain, foundation

foundation
  -> domain

domain
  -> nothing outside domain
```

“允许”不表示必须依赖。任何未列出的跨边界依赖默认禁止。

### 8.2 强制规则

1. `domain/` 不得导入 `node:*` 或其他顶层模块。
2. `foundation/` 不得导入 adapters、revisions、artifacts、runs、evals、daemon 或 cli。
3. 任何模块不得导入 `cli/`。
4. 除 `cli/` 外，任何模块不得导入 `daemon/`。
5. backend 不得导入 `evals/service.ts` 或 `runs/executor.ts`。
6. 跨顶层边界只能导入对方 `index.ts` 或被白名单声明的 contract 文件。
7. 顶层模块之间不得存在运行时或 `import type` 依赖环。
8. `src/` 根目录不得存在 TypeScript 源文件。
9. 新增 provider 必须落在 `adapters/providers/`；新增 eval backend 必须落在 `backends/`。
10. 共享类型若只属于一个领域，保留在该领域；只有跨三个以上边界且语义稳定的 wire type 才进入 `domain/`。

### 8.3 Backend 契约

`backends/contract.ts` 定义最小 backend 接口。它只接受 domain DTO、已解析的不可变身份和显式资源路径，不接受 `EvalService`、CLI 参数对象或 daemon 状态。

backend 返回标准化结果和产物引用；由 `evals/service.ts` 决定如何写 EvalRecord、导入 trial run 和生成聚合结果。这样可以消除当前 `evals` 与 Harbor 类型互相引用的问题。

## 9. 现有文件迁移映射

| 当前文件 | 目标位置 |
| --- | --- |
| `adapters.ts` | `adapters/contract.ts`、`catalog.ts`、`providers/*.ts` |
| `registry.ts` | agent 发现移入 `adapters/discovery.ts`；通用 executable 查找、版本探测和指纹移入 `foundation/executable.ts` |
| `harness-reference.ts` | `revisions/reference.ts` |
| `artifacts.ts` | `revisions/resolver.ts`、`artifacts/preparer.ts`、`store.ts`、`integrity.ts` |
| `workspaces.ts` | `workspaces/planner.ts`、`lifecycle.ts`、`git.ts`、`copy.ts`、`digest.ts` |
| `engine.ts` | `runs/request.ts`、`manifest.ts`、`executor.ts`、`finalizer.ts` |
| `events.ts` | `runs/events.ts` |
| `run-records.ts` | `runs/records.ts`、`query.ts`、`compare.ts`、`identity.ts`；通用 canonical JSON 与 SHA-256 原语移入 `foundation/hash.ts` |
| `evals.ts` | `evals/request.ts`、`service.ts`、`records.ts` |
| `eval-runs.ts` | `evals/trial-import.ts` |
| `eval-tools.ts` | `backends/harbor/tools.ts` |
| `harbor-backend.ts` | `backends/harbor/backend.ts` |
| `local-git-transport.ts` | `backends/harbor/local-git-transport.ts` |
| `daemon.ts` | `daemon/auth.ts`、`client.ts`、`launcher.ts`、`server.ts` |
| `scheduler.ts` | `daemon/scheduler.ts` |
| `cli.ts` | `cli/main.ts`、`arguments.ts`、`output.ts`、`commands/*.ts` |
| `config.ts`、`errors.ts`、`fs.ts`、`locks.ts`、`process.ts`、`line-stream.ts`、`package-root.ts` | `foundation/` |
| `trajectories/native.ts` | `trajectories/provider-capture.ts` |
| `trajectories/deepseek-native.ts` | `trajectories/providers/deepseek.ts` |

`controller-runtime/` 和 `feedback/` 已基本符合目标边界，只需增加 facade 并调整依赖。`domain/types.ts` 和 `domain/validate.ts` 应按稳定领域拆分，避免重新形成新的公共大文件。

## 10. 文件与 API 设计规则

### 10.1 文件规模

- 实现文件目标不超过 400 行。
- 超过 500 行视为架构检查失败，除非在白名单中记录原因和拆分计划。
- 文件规模不是唯一拆分依据；优先按变化原因和依赖边界拆分。
- `index.ts` 只做导出，不包含业务逻辑。

### 10.2 导出规则

- 默认不导出内部 helper。
- facade 仅导出跨边界真正需要的类型和操作。
- 不使用跨模块的 `export *`。
- provider-specific 类型不得泄漏到 `runs` 或 CLI 公共请求对象。
- 文件名和导出名称避免 `Manager`、`Utils`、`Common` 等无法表达所有权的泛化命名。

### 10.3 编排函数

每个高层编排函数应：

1. 显式接收根目录、环境变量、signal 和外部实现；
2. 返回领域结果或明确的产物引用；
3. 不直接格式化 CLI 文本；
4. 不读取全局 argv；
5. 对可恢复步骤使用幂等状态转换；
6. 在调用边界将外部 `unknown` 校验为 domain DTO。

## 11. 兼容性要求

### 11.1 必须保持不变

- `hitch` bin 名称；
- 所有现有命令、选项、默认值和退出码；
- stdout/stderr 与 `--json` 的机器可读结构；
- daemon endpoint、认证 token 和请求/响应字段；
- `statePaths()` 计算出的目录；
- run、eval、artifact、workspace、trajectory 和 controller-runtime 文件布局；
- Schema version、事件类型和错误 code；
- 内容寻址摘要和 canonical JSON 规则；
- Node.js `>=22` 与零运行时 npm 依赖约束。

### 11.2 程序化入口

`package.json` 仅声明顶层模块 facade 和 `package.json` 自身为公开子路径。原根级文件、`domain/types.ts`、`domain/validate.ts` 及其旧 package 子路径不再提供兼容转发；调用方必须迁移到所属模块 facade。

## 12. 自动化架构检查

新增 `scripts/check-architecture.ts`，编译后由 `npm run check` 调用。检查器至少验证：

1. 顶层模块依赖满足第 8 节规则；
2. 跨模块不存在运行时或类型依赖环；
3. `domain/` 不导入 Node.js builtin；
4. `src/` 根目录不存在 TypeScript 源文件；
5. 跨模块不存在未授权 deep import；
6. 实现文件行数不超过阈值；
7. `index.ts` 不包含非导出业务逻辑。

检查脚本不得引入新的运行时依赖。失败输出必须包含源文件、行号、违反的规则和建议入口。

建议脚本顺序：

```text
typecheck
build
check-architecture
check-syntax
test
```

## 13. 测试策略

### 13.1 迁移前保护

移动实现前，为下列边界补齐 characterization tests：

- CLI help、JSON 输出和退出码；
- run 成功、失败、取消、超时和轨迹终结；
- workspace shared/worktree/copy 生命周期和恢复；
- artifact installed/npm/git resolution 与缓存命中；
- eval Harbor 调用、trial 导入和失败诊断；
- daemon submit/status/cancel/stop；
- 已发布 Schema 对典型记录的校验；
- 内容摘要在重构前后的固定 fixture 一致。

### 13.2 测试导入规范

- 集成测试从模块 facade 导入。
- 单元测试可以导入内部文件，但必须与对应模块同名分组，并避免把内部路径视为公开 API。
- 所有测试均从模块 facade 导入，不使用已删除的旧入口。
- 测试目录最终镜像业务边界，例如 `test/runs/`、`test/evals/` 和 `test/cli/`。

### 13.3 每阶段验证

每个迁移阶段必须通过：

```bash
npm run typecheck
npm run build
npm test
npm run coverage
npm pack --dry-run
```

涉及执行、文件布局或摘要代码时，还必须比较重构前后的 fixture 输出；仅“测试通过”不足以证明格式兼容。

## 14. 迁移计划

### 阶段 0：建立基线与护栏

1. 固化当前行数、import graph、CLI 和持久化 fixture。
2. 新增架构检查器，但先对现有违规使用显式 baseline。
3. 禁止新增根级业务实现文件。
4. 为每个目标模块建立 facade。

完成条件：CI 能阻止违规数量增加，所有现有行为测试通过。

### 阶段 1：迁移低风险基础模块

1. 将通用原语移入 `foundation/`。
2. 将 `harness-reference.ts` 移入 `revisions/`。
3. 为 `controller-runtime/`、`trajectories/` 和 `feedback/` 增加 facade。
4. 调用方迁移完成后删除原路径。

完成条件：内部代码只通过新路径导入，根级文件不再包含实现。

### 阶段 2：拆分 adapters、artifacts 与 workspaces

1. 先提取 contract 和 types，不改变行为。
2. 将 provider 定义逐个移入独立文件。
3. 将 revision resolution 从 artifact preparation 中分离。
4. 将 workspace 的 Git、copy、digest 与生命周期分离。
5. 每移动一个能力即迁移对应测试。

完成条件：三个模块均通过 facade 暴露 API，单个实现文件不超过 500 行，不存在反向依赖。

### 阶段 3：拆分 runs、evals 与 Harbor backend

1. 从 `engine.ts` 提取 request、manifest、executor 和 finalizer。
2. 将 run records、query 和 compare 归入 `runs/`。
3. 定义 backend contract，将 Harbor 进程与 local Git transport 下沉。
4. 让 eval service 只负责编排和记录所有权。
5. 消除所有类型依赖环。

完成条件：run executor 不导入 eval/daemon/cli；Harbor backend 不导入 eval service；跨模块图为 DAG。

### 阶段 4：拆分 daemon 与 CLI

1. 分离 daemon auth、client、server 和 scheduler。
2. 每个 CLI 一级命令迁入独立 command 文件。
3. 参数解析集中在 `arguments.ts`，输出集中在 `output.ts`。
4. `bin/hitch.ts` 只导入 `cli/index.ts` 的 `main`。

完成条件：CLI command 不直接操作底层文件系统状态；`cli/main.ts` 只做根参数与一级路由。

### 阶段 5：收紧与发布

1. 将架构检查从 baseline 模式切换为零违规。
2. 更新 README、开发文档和贡献指南。
3. 为支持的程序化 API 声明 package `exports`。
4. 删除根级、领域聚合与 package exports 中的旧兼容入口。

完成条件：满足第 15 节所有验收标准。

## 15. 验收标准

重构仅在以下条件全部满足时完成：

- [x] `src/` 根目录不包含 TypeScript 源文件。
- [x] 所有顶层模块都有 `index.ts` facade。
- [x] 跨模块没有运行时或类型依赖环。
- [x] 架构检查无 baseline、无白名单外违规。
- [x] `domain/` 不导入 Node.js 或 I/O 模块。
- [x] `runs` 不依赖 `evals`、`daemon` 或 `cli`。
- [x] `backends` 不依赖 eval/run service 实现。
- [x] CLI command 不直接读写 Hitch 状态文件。
- [x] 无实现文件超过 500 行；超过 400 行的文件有清晰单一职责。
- [x] 原 CLI、daemon、Schema、磁盘布局、错误 code 和摘要 fixture 保持一致。
- [x] typecheck、build、architecture check、syntax check、tests、coverage 和 package smoke test 全部通过。
- [x] 新增 provider 或 backend 各只需要在所属边界内实现并在 catalog 注册，不需要修改 run executor。
- [x] 文档中的目录树、依赖图与实际代码一致。

## 16. 变更管理

- 一个提交只做一种结构动作：建立 facade、移动文件、拆分实现或改变行为，不混合进行。
- 移动文件时优先保留 Git rename 可追踪性。
- 对共享接口的修改先提交 consumer migration，再收紧 producer。
- 任何磁盘格式或摘要差异都视为行为变更，必须停止当前重构并单独评审。
- 若发现目标边界无法表达真实所有权，应先更新本规范，再继续迁移；不得用新的 `utils.ts` 绕过边界。

## 17. 最终决策记录

本规范采用以下决策：

1. 使用领域目录，不使用按 MVC 或纯技术层横切的全局 `services/`、`models/`、`utils/`。
2. 引入 `foundation/` 承载 Node.js 原语，补足原设计中缺失的基础设施边界。
3. Harbor 是 backend，不是 eval 核心领域的一部分。
4. run 是执行事实的所有者；eval 只负责编排、关联和聚合 run。
5. CLI 与 daemon 是接口层，不拥有核心业务规则。
6. 使用仓库内架构检查脚本，不为此增加运行时依赖。
7. 通过明确的模块 facade 和 package exports 管理公开 API，不保留双入口。
