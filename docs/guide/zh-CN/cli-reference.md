# CLI 命令参考

这里集中列出 Hitch 0.2.10 的所有用户命令，已对照 CLI 分发与参数解析器核对。首次使用请先看 [Quick Start](quickstart.md)。在 0.2.10 发布到 npm 前，请按[源码安装说明](model-inference.md#使用当前-dev-构建)使用当前 dev。

语法中，`VALUE` 是占位符，`[OPTIONS]` 表示可选，`A|B` 表示二选一。运行时替换占位符、去掉方括号，参数名和取值用空格分隔。下面是查询用的命令参考，不是需要从头执行的脚本。

时长支持 `ms`、`s`、`m`、`h`，例如 `500ms` 或 `5m`；不带单位的数字表示毫秒。

## 按用途查找

- [帮助与状态目录](#帮助与状态目录): `help, --version, capabilities`
- [Harness 与制品](#harness-与制品): `list, inspect, resolve, prepare`
- [运行任务](#运行任务): `run`
- [评测](#评测): `eval`
- [Benchmark 包](#benchmark-包): `benchmark`
- [模型与推理](#模型与推理): `models, local, model-node`
- [Daemon 与容量](#daemon-与容量): `daemon`
- [远程 Worker](#远程-worker): `worker`
- [结果与对比](#结果与对比): `runs, compare`
- [工作区](#工作区): `workspace`
- [轨迹与验证证据](#轨迹与验证证据): `trajectory, verifier`
- [反馈](#反馈): `feedback`
- [镜像缓存](#镜像缓存): `images`
- [训练集成](#训练集成): `training`

## 帮助与状态目录

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch help` | 输出命令总览。`hitch`、`hitch --help`、`hitch -h` 等价。 |
| `hitch --version` | 查看安装版本；别名为 `hitch -V`。 |
| `hitch capabilities [--json]` | 查询带版本的机器接口能力。 |
| `--root PATH` | 选择状态目录，优先级为此参数、`HITCH_ROOT`、`~/.hitch`。提交和查看同一任务时使用同一个 root。 |

使用顶层 `hitch --help`；子命令没有独立的 `--help`。仅在明确列出的命令上使用 `--json`。`run`、`eval run`、`eval watch` 使用 `--output json|jsonl`；部分集成命令始终输出 JSON，无需输出参数。

## Harness 与制品

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch list [--json]` | 列出受支持的 Harness 及本机程序发现结果。 |
| `hitch inspect HARNESS [--json]` | 查看适配器及其能力。 |
| `hitch resolve HARNESS_REF [--json]` | 将引用解析为确定的版本身份。 |
| `hitch prepare HARNESS_REF [--json]` | 准备或复用已验证的可执行制品。 |

引用包括 `codex@installed`、`codex@version:0.92.0`、`codex@commit:COMMIT` 和 `codex@git+file:///absolute/repository#FULL_COMMIT`。只写 Harness 名称会选择本机已安装程序。评测需要可移植的不可变引用；本地 Git 评测要求干净仓库和完整的小写提交哈希。详见[固定版本与隔离工作区](versions-and-workspaces.md)。

## 运行任务

```text
hitch run --harness HARNESS_REF [--prompt TEXT | --prompt-file PATH] [RUN_OPTIONS] [--daemon] [--output json|jsonl]
```

运行 Harness 并等待结果。提示词也可以来自非交互 stdin。直接运行默认输出 JSONL；`--daemon` 提交给 daemon 并跟踪执行。托管 `local/…` 模型会按需启动本地推理 daemon。[运行教程](quickstart.md)。

### 共享 Run 参数

以下参数也适用于 `hitch daemon submit`。

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `--harness REF` | 必需的 Harness 引用。 |
| `--model ID` | Harness 接受的模型 ID；省略时使用其默认值。托管模型使用 `local/NAME` 或 `local/sha256:DIGEST`。 |
| `--prompt TEXT`, `--prompt-file PATH` | 二选一；未提供时可从非交互 stdin 读取。 |
| `--cwd PATH` | 源工作区，默认为当前目录。 |
| `--workspace-mode shared\|worktree\|copy` | 默认 `shared` 直接使用源目录。`worktree` 隔离干净的 Git HEAD；`copy` 包含当前文件修改。 |
| `--timeout DURATION` | 运行时限，默认 `0` 表示不设时限。 |
| `--agent-arg VALUE` | 可重复，每次向 Harness 传递一个参数。 |
| `--context-file JSON`, `--parent-file JSON` | 附加符合 Schema 的任务上下文或父级关系。 |
| `--model-identity-file JSON`, `--protocol-identity-file JSON` | 在集成流程中附加结构化模型身份或协议身份。 |
| `--device auto\|cpu\|cuda`, `--local-profile baseline\|throughput`, `--offline` | 托管推理选择，默认 `auto` 和 `baseline`；离线运行要求必要文件已在本地。 |
| `--inference SHA256`, `--model-node-file JSON` | 使用精确的推理锁和可选远程节点绑定。以锁内配置为准，省略 device/profile 覆盖参数。 |
| `--agent NAME` | `--harness` 的兼容旧参数，只接受名称并选择已安装程序；两者互斥。 |

## 评测

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch eval setup harbor [--version VERSION] [--python PATH] [--force] [--json]` | 在隔离工具目录安装 Hitch 固定的 Harbor；`--force` 重建该安装。 |
| `hitch eval doctor [--harbor PATH] [--python PATH] [--docker PATH] [--json]` | 检查依赖，不启动评测。 |
| `hitch eval run --dataset REF --harness REF [EVAL_OPTIONS]` | 执行并等待结果，默认输出 JSON。 |
| `hitch eval submit --dataset REF --harness REF [EVAL_OPTIONS]` | 提交给已运行的 daemon，立即以 JSON 返回受理 ID。 |
| `hitch eval watch EVAL_ID [--output json\|jsonl]` | 跟踪 daemon 评测，默认 JSONL。 |
| `hitch eval cancel EVAL_ID` | 通过 daemon 请求取消，始终返回 JSON。 |
| `hitch eval list [--json]` | 列出当前 root 下的评测。 |
| `hitch eval inspect EVAL_ID [--json]` | 查看请求、计划、状态、结果和运行时引用。 |
| `hitch eval rerun EVAL_ID (--invalid \| --task NAME ...) [RERUN_OPTIONS]` | 修复选中的无效或缺失 attempt，保留有效结果。多个任务需逐个重复 `--task`。 |
| `hitch eval rerun-cancel EVAL_ID RERUN_ID` | 取消一个 daemon 修复操作，始终返回 JSON。 |
| `hitch eval control --file INTENT.json` | 通过 daemon 应用持久化的有序 start/pause 指令，始终返回 JSON。 |

### 评测参数

除明确限定外，以下参数由 `eval run` 与 `eval submit` 共享。入门见[单任务评测](evaluations.md)，恢复范围见 [daemon](daemon.md)。

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `--backend harbor` | 当前后端，默认 `harbor`。 |
| `--dataset REF`, `--harness REF` | 必需的数据集和不可变 Harness 引用。 |
| `--model ID` | 独立于 Harness 选择模型。 |
| `--attempts N`, `--max-concurrent N` | 正整数；普通数据集默认 1 次 attempt、最多 4 个并行 Trial，实际还受资源约束。 |
| `--timeout DURATION`, `--setup-timeout DURATION` | 候选执行和准备阶段的预算。标准编译任务保留任务预算，除非显式覆盖；其他默认值见[评测契约](../../evals.md)。 |
| `--infrastructure-retries N`, `--infrastructure-retry-backoff DURATION` | 控制符合条件的基础设施重试；N 可为 0，表示禁用。 |
| `--agent-arg VALUE`, `--pass-env NAME` | 可重复，分别传递 Harness 参数和转发到容器的认证/环境变量名称。 |
| `--device auto\|cpu\|cuda`, `--local-profile baseline\|throughput`, `--offline` | 托管模型推理，硬件与 Harness 要求见[模型推理](model-inference.md)。 |
| `--inference SHA256`, `--model-node-file JSON` | 使用精确推理锁及远程节点绑定，省略 device/profile 覆盖参数。 |
| `--training-binding-file JSON` | 将受支持的训练 episode 绑定到外部训练网关，见[训练集成](../../slime-training-binding.zh-CN.md)。 |
| `--daemon` | 仅 `eval run`：提交给 daemon 并等待。托管模型的数据集评测自动使用此路径。 |
| `--output json\|jsonl` | 仅 `eval run`，默认 `json`。`eval submit` 始终返回受理 JSON。 |
| `--idempotency-key KEY` | 仅用于 daemon 提交，相同不可变请求可复用同一 key。 |
| `--eval-id EVAL_ID`, `--harbor PATH` | 仅直接 `eval run`：指定评测 ID 或 Harbor 程序。Daemon 模式分配 ID 并使用自身的 Harbor 环境。 |
| `--benchmark DIRECTORY`, `--benchmark-lock FILE` | `eval run` 的兼容输入，用于代替 `--dataset`；仅支持本地直接执行。推荐先 `benchmark compile` 再评测数据集。 |
| `--control-file INTENT.json` | 仅 `eval submit`：附加有序控制指令，与 `--idempotency-key` 互斥。 |

### 执行策略

以下参数要求使用 `eval run --daemon` 或 `eval submit`。

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `--provider ID` | 选择执行 Provider，默认 `local-docker`。 |
| `--cpu-per-trial N` | 每个 Trial 预留的正整数 CPU 核数。 |
| `--memory-per-trial SIZE` | 接受 B、KiB、MiB、GiB，换算后必须是正整数 MiB，例如 `2GiB`。 |
| `--build-mode backend\|prebuild-preferred\|prebuild-required` | 由后端构建、优先 Hitch 预构建且允许回退、或强制预构建。 |
| `--model-capture off\|native\|proxy\|hybrid` | 选择模型交互采集方式，支持情况取决于 Harness 和端点。 |
| `--require-model-capture` | 必需采集不可用时拒绝执行，不可与 `off` 模式组合。 |

### 修复与有序控制

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `--type TYPE` | 默认 `candidate-restart`；`collect-only` 只补收已完成证据。`verifier-only` 要求受支持的保留产物。`candidate-resume`、`trajectory-replay` 依赖尚不具备的检查点/适配能力，可能被拒绝。 |
| `--verifier-runtime SHA256` | 仅用于 `--type verifier-only`，指定精确 Verifier 运行时。 |
| `--daemon`, `--rerun-id RERUN_ID` | 使用 daemon 修复；显式修复 ID 要求 daemon 模式。已有控制面评测也会路由到 daemon。 |
| `--harbor PATH` | 仅用于直接修复，不可与 daemon 修复组合。 |
| `--output json` | 修复唯一的输出格式。 |
| `--control-file INTENT.json` | 附加有序指令并启用 daemon 模式。 |

有序控制面向集成流程：保留评测 key，改变 start/pause 指令时递增 sequence。参见[控制 Schema](../../schemas/ordered-eval-control.schema.json) 和[集成契约](../../slime-training-binding.zh-CN.md)。普通评测直接使用 watch、cancel 和 rerun。

## Benchmark 包

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch benchmark validate --package DIRECTORY` | 校验本地评测包，始终输出 JSON。 |
| `hitch benchmark lock --package DIRECTORY [--out FILE]` | 生成内容锁，可指定输出路径。 |
| `hitch benchmark compile --package DIRECTORY --out DATASET_DIRECTORY` | 编译为 Harbor 兼容数据集，输出目录不能已存在。 |

每个命令都需要 `--package`。Lock 可选 `--out`，compile 必须提供，validate 不接受。输出本身就是 JSON，因此均不接受 `--json`。详见 [Benchmark Package](../../benchmark-packages.md)。

## 模型与推理

这些命令管理 checkpoint 身份、SGLang 运行时和远程模型节点。模型节点提供推理；[Worker](#远程-worker) 执行评测任务。安装、硬件、精确 Codex 版本及连接/绑定文件格式见[模型推理](model-inference.md)。

### 模型存储

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch models add DIRECTORY --name NAME [--force] [--json]` | 导入完整 safetensors checkpoint 为 `local/NAME`；force 允许重新绑定名称。 |
| `hitch models add-node SNAPSHOT.json --model-node-file BINDING.json --name NAME [--force] [--json]` | 注册模型节点上的快照，始终输出 JSON。 |
| `hitch models inspect MODEL [--verify] [--model-node-file BINDING.json] [--json]` | 查看名称或摘要引用；verify 校验本地文件，提供绑定时校验节点副本。 |
| `hitch models gc [--dry-run \| --apply] [--json]` | 默认预览无引用模型清理。`--apply` 删除符合条件的文件；两个模式参数互斥。 |

### 推理准备与服务

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch local plan MODEL --harness REF --gpu GPU-UUID [--model-node-file BINDING.json] [--offline] [--json]` | 准备精确的 CUDA/baseline 运行时和推理锁，不启动候选任务；可能准备运行时文件。 |
| `hitch local prepare MODEL [--device auto\|cpu\|cuda] [--profile baseline\|throughput] [--inference SHA256] [--model-node-file BINDING.json] [--offline] [--json]` | 通过 daemon 准备并验证托管推理，按需启动 daemon。 |
| `hitch local inspect SHA256 [--json]` | 读取精确推理锁，始终输出 JSON。 |
| `hitch local inspect-service SERVICE_ID [--json]` | 读取托管模型节点服务记录及用量证据，始终输出 JSON。 |
| `hitch local doctor [--device auto\|cpu\|cuda] [--json]` | 检查静态硬件/运行时条件，实际加载和协议验证由 prepare 完成。 |
| `hitch local status [--json]` | 通过 daemon 查询服务；daemon 离线时读取持久化记录。 |
| `hitch local stop [SERVICE_ID] [--force] [--json]` | 停止一个服务；省略 ID 时停止所有未终止服务。Force 请求在有活动使用时也停止。 |

`local prepare` 使用 `--profile`，run/eval 使用 `--local-profile`。设备解析器识别 `metal`，但当前预览没有可用运行时。使用精确推理锁时省略 device/profile 覆盖。服务 ID 形如 `inference_…`，锁 ID 形如 `sha256:…`。

### 远程模型节点

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch model-node register --file CONNECTION.json [--json]` | 保存连接并检查节点注册信息。 |
| `hitch model-node inspect --file BINDING.json [--json]` | 通过绑定查询已注册节点。 |
| `hitch model-node recover-service SERVICE_ID --file CURRENT_BINDING.json [--json]` | 使用当前节点身份核对并恢复已有服务状态。 |

所有 model-node 命令均输出 JSON。Connection 文件包含连接信息，binding 记录选定节点身份；各命令按要求使用对应文件。

## Daemon 与容量

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch daemon start [--foreground] [--port N] [--max-concurrent N] [CAPACITY_OPTIONS]` | 默认后台启动；foreground 保持在当前终端。默认端口 7463，`0` 选择空闲端口；默认并发上限 4。 |
| `hitch daemon serve [--port N] [--max-concurrent N] [CAPACITY_OPTIONS]` | 底层前台服务入口，后台启动也会使用它。 |
| `hitch daemon stop` | 请求关闭 daemon。 |
| `hitch daemon status [--json]` | 查询状态、队列、容量和健康信息。 |
| `hitch daemon logs [-n LINES]` | 查看最近日志，默认 50 行。 |
| `hitch daemon submit --harness REF [RUN_OPTIONS] [--wait] [--output json\|jsonl]` | 使用共享 Run 参数提交任务。默认立即返回受理 JSON；`--wait` 等待完成，等待时默认输出 JSON。 |
| `hitch daemon cancel RUN_ID` | 请求取消 daemon 中的 Run。 |

### 容量参数

用于 daemon start 和 serve。CPU 使用 millicores（`1000` 为一核）；内存和磁盘使用 MiB；GPU 使用整张设备数。CLI 值覆盖对应的 `HITCH_…` 环境变量。[配置与恢复](daemon.md)。

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `--capacity-cpu-millis N`, `--capacity-memory-mib N` | 总 CPU 与内存准入容量；可用时从 Docker 推断，否则使用保守默认值。 |
| `--container-slots N`, `--build-slots N` | 独立的容器/构建并发预算；构建槽位默认 1。 |
| `--capacity-gpus N`, `--eval-gpus N` | 总 GPU 容量和每 Trial 默认预留，均默认 0；GPU 任务需显式配置。 |
| `--capacity-ephemeral-disk-mib N`, `--eval-ephemeral-disk-mib N` | 临时磁盘总预算和每 Trial 预算，默认 0，仅用于准入计账。 |
| `--run-cpu-millis N`, `--run-memory-mib N` | 普通 Run 默认预留：1000 millicores、512 MiB。 |
| `--eval-cpu-millis N`, `--eval-memory-mib N` | Trial 默认预留：1000 millicores、1024 MiB；任务声明可能要求更多。 |

## 远程 Worker

```text
hitch worker list [--json]
hitch worker observe PROVIDER [--nonce HEX] [--json]
hitch worker register --server URL --registration JSON --admin-token-file FILE --credential-file FILE
hitch worker run --server URL --registration JSON --credential-file FILE [--harbor PATH] [--docker PATH] [--once] [--poll-interval DURATION] [--heartbeat-interval DURATION]
```

`list` 从 daemon 查询 Worker 状态。`observe` 返回新的执行观测，可选 nonce 为 32 位小写十六进制字符串。`register` 轮换 Worker 凭据并写入指定文件。`run` 下载并校验输入，执行接受的任务、回报结果并处理获准的资源清理。每个 Worker 主机使用独立的状态目录。

`--once` 在处理工作、完成待处理任务与清理后退出，可能需要等待任务到达。默认轮询间隔 1s、心跳间隔 10s；每个间隔范围为 50ms 到 5m。注册文件遵循 [Worker 注册 Schema](../../schemas/remote-worker-registration.schema.json)，执行能力见[执行 Provider 契约](../../hitch-harbor-control-plane-implementation-status.md)。

## 结果与对比

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch runs list [FILTERS] [--json]` | 查询运行记录。 |
| `hitch runs inspect RUN_ID [--json]` | 查看 Run 并校验关联轨迹证据。 |
| `hitch runs rebuild-index [--json]` | 从已存 Run 重建查询索引。 |
| `hitch runs candidate RUN_ID [--context-license allowed\|denied\|unknown] [--capture-required] [--redaction-policy ID] [--json]` | 从验证过的结果包派生训练数据候选。许可默认 unknown，策略标签默认 `hitch-provider-redaction-v1`。 |
| `hitch compare model [FILTERS] [--reference-run RUN_ID] [--json]` | 比较模型结果，并报告是否满足严格可比条件。 |
| `hitch compare harness [FILTERS] [--reference-run RUN_ID] [--json]` | 在兼容条件下比较 Harness 结果。 |

### 共享查询筛选

用于 `runs list` 和两个 compare 命令。筛选参数选择已有记录；对比不会发起新的模型调用。[证据教程](runs-and-evidence.md)。

```text
--context-kind KIND
--benchmark ID           --benchmark-revision REVISION
--task ID                --task-digest SHA256
--seed-task ID           --seed-digest SHA256
--iteration ID
--harness ID             --harness-revision IDENTITY
--provider MODEL_PROVIDER
--requested-model ID     --effective-model ID
--eval EVAL_ID           --status STATUS
--from TIMESTAMP         --to TIMESTAMP
```

查询中的 `--provider` 指模型 Provider，`--harness` 指 Harness ID。评测执行中的 `--provider` 选择执行 Provider，`--harness` 接受版本引用。`--from`、`--to` 筛选创建时间。

## 工作区

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch workspace inspect RUN_ID [--json]` | 查看源目录、执行目录、模式、保留状态和可用的变更信息。 |
| `hitch workspace path RUN_ID` | 输出保留的执行目录；未保留时返回错误。 |
| `hitch workspace remove RUN_ID [--force] [--json]` | 删除托管工作区。Force 允许删除已修改的工作区；共享源目录受保护。 |

详见[工作区模式与保留](versions-and-workspaces.md)。

## 轨迹与验证证据

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch trajectory inspect RUN_ID [--json]` | 查看规范化轨迹；JSON 包含完整事件数组。 |
| `hitch trajectory project RUN_ID [--profile analysis] [--max-bytes N] [--json]` | 生成大小受限的分析视图。 |
| `hitch trajectory events RUN_ID [EVENT_OPTIONS] [--json]` | 分页读取大小受限的事件。 |
| `hitch verifier inspect RUN_ID [--json]` | 读取经过脱敏的 Verifier 结果和诊断信息。 |

```text
--types TYPE_A,TYPE_B
--seq-start N           --seq-end N
--field PATH            --canonical-sha256 SHA256
--limit N               --max-bytes N
--cursor OPAQUE_CURSOR
```

上面的参数用于 events。字段查看要求精确序号范围和先前视图返回的 canonical SHA-256。Cursor 为不透明值，继续翻页时保持查询条件。详见[查看运行与证据](runs-and-evidence.md)。

## 反馈

```text
hitch feedback list RUN_ID [--json]
hitch feedback put RUN_ID --message MESSAGE_ID --rating positive|negative [--note TEXT] [--if-version VERSION] [--json]
hitch feedback delete RUN_ID --message MESSAGE_ID [--if-version VERSION] [--json]
```

为规范化轨迹中的消息附加反馈。`--if-version` 使用服务返回的版本，执行有条件的更新或删除。反馈单独存储，不写入已封存的 Run 证据。

## 镜像缓存

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch images gc [--minimum-age DURATION] [--apply] [--json]` | 默认预览可清理镜像；apply 执行删除。默认最小年龄 24h。 |
| `hitch images pin SHA256 [--reason TEXT]` | 保护 Hitch 环境镜像，避免被垃圾回收。 |
| `hitch images unpin SHA256` | 移除显式保护，正常引用保护仍生效。 |

镜像 ID 标识 Hitch 环境镜像清单。垃圾回收保留活动和被引用的镜像，并检查所有权。详见[环境镜像](../../environment-images.md)。

## 训练集成

| 命令 / 参数 | 用途与说明 |
| --- | --- |
| `hitch training register --file PATH` | 注册外部训练端点；`--file -` 从 stdin 读取 JSON。始终输出 JSON，不接受 `--json`。 |
| `hitch training runtime [--json]` | 查询控制器运行时身份与能力，始终输出 JSON。 |
| `hitch training evidence RUN_ID [--json]` | 查看训练绑定与精确策略/token 证据，始终输出 JSON。 |

这些命令用于训练系统集成。按[训练契约](../../slime-training-binding.zh-CN.md)配置受支持的训练 Harness、外部网关及 eval 的 `--training-binding-file`。从结果派生训练数据候选使用 `runs candidate`。

## 兼容与内部参数

本页覆盖用户命令路径与参数。`--internal-*` 保留给 Hitch 的 Harbor 桥接，在该上下文之外会被拒绝。JSON 集成文件需符合[带版本的 Schema](../../schemas)，不能任意添加字段。确认版本差异时，结合 `hitch --version`、`hitch capabilities --json` 与源码版本检查。
