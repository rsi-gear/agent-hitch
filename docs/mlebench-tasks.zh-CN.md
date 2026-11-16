# MLE-bench 通用任务

MLE-bench 使用 Hitch 通用 task/resource/eval 执行链。一轮 Target 执行在同一个 sandbox 内完成分析、训练、预测和交付，结束后自动收集产物并运行独立 verifier。Agent 使用所选 harness 的普通终端、文件和代码工具，具体建模方法由 harness 与 Agent 决定。

这是破坏性替换。旧 research CLI、provider、checkpoint、carrier、专用 schema 和独立 refit/export 已删除，旧项目不能恢复、重放或自动转换。切换前用原执行器完成或取消旧运行；切换后重新导入任务并登记预算。旧日志仅作为静态审计材料保存，不改写成新协议结果。

## 任务与评分

`agent-hitch/mlebench` 提供 `produceTask`、`importCompetition`、`inspectMlebench` 和 `importMlebench`。`hitch-mlebench --help` 列出当前 importer CLI。导入后的任务包含 `instruction.md`、`task.toml`、`parameters.json`、环境与 verifier 入口，并通过 `resource.lock.json` 绑定公开数据和私有评分资源。资源路径和镜像身份遵循[资源合同](resource-storage.zh-CN.md)。

先配置执行宿主的资源策略。`runtime-host.json` 中的摘要必须是目标 Linux 平台的 manifest digest，不能用可变 tag 或多平台 index 代替。以下使用 `cache-first`，首次准入可拉取镜像并验证身份：

```json
{
  "protocol": "hitch-resource-host@1",
  "transport": { "sha256:PLATFORM_DIGEST": "registry.example/runtime@sha256:PLATFORM_DIGEST" },
  "imagePolicy": "cache-first",
  "platform": "linux/arm64",
  "workspace": { "mode": "auto", "maxCopyBytes": 536870912, "maxWorkspaces": 2 }
}
```

```sh
hitch --root /absolute/hitch-state resources request configure --input runtime-host.json
hitch-mlebench --config task.json --out /absolute/new-task --root /absolute/hitch-state
```

`task.json` 包含 `instruction`、`publicDirectory`、`baseImage`、`platform` 和下述 `delivery`、`evaluation` 字段；可评分任务还声明私有 `expected` CSV。输入路径相对于配置文件。镜像需要普通训练工具和 verifier 的实际 Python 依赖；上游 native grader 还需要其导入依赖，参考 `benchmark-packages/kaggle/runtime/requirements.txt`。Hitch 状态根必须与运行时 `--root` 相同。

普通任务可分别配置候选和独立 verifier 的资源，单位为 CPU 核数和 MiB：

```json
{
  "timeoutSeconds": 3600,
  "cpus": 1,
  "memoryMb": 1024,
  "verifierCpus": 1,
  "verifierMemoryMb": 256
}
```

这个 Titanic 配置让每次实验的候选使用 1 CPU／1 GiB，verifier 使用 1 CPU／256 MiB；宿主为完整执行保留两者之和，即 2 CPU／1280 MiB／2 个容器槽。两次并行需要至少 4 CPU／2560 MiB／4 个容器槽；三次并行需要至少 6 CPU／3840 MiB／6 个容器槽，并且资源宿主的 `workspace.maxWorkspaces` 至少为相应并发数。调度器仍会检查可用容量，配置并发数不会绕过资源额度。容器的实际 CPU、内存限制分别出现在封存执行证据的候选和 verifier 记录中。

未指定时，普通任务保持 `cpus: 2`、`memoryMb: 4096`、`verifierCpus: 1`、`verifierMemoryMb: 1024`、`timeoutSeconds: 3600` 的默认值。`verifierCpus` 必须是正整数，`verifierMemoryMb` 必须是至少 128 的整数。CLI 对应选项是 `--cpus`、`--memory-mb`、`--verifier-cpus`、`--verifier-memory-mb` 和 `--timeout-seconds`。`timeoutSeconds` 是单次 Agent 的任务时限，verifier 另有 120 秒时限；运行时 CLI 也应显式传入 `--timeout 1h`，Gear profile 使用 `timeoutMs: 3600000`，以免更短的外层时限提前中断任务。

调整资源或时限后导入到新的 dataset 路径，重新封存任务并选择新 profile；已经完成或冻结的旧任务、运行记录和产物保持原样。低内存配置需要实际运行验证，声明额度本身不证明模型或 grader 能在该额度内完成。

上游 checksum 清单未覆盖的公开辅助资产必须通过 `--public-assets ASSET_MANIFEST.json` 显式声明，每项包含相对 `path`、`digest: "sha256:…"` 和 `bytes`。导入器验证完整公开清单，不能仅凭文件名猜测归属或静默丢弃几何等辅助资产。

导入正式上游任务可使用：

```sh
hitch-mlebench --repository /absolute/mle-bench \
  --data-root /absolute/prepared-data --competition COMPETITION_ID \
  --base-image registry.example/runtime@sha256:PLATFORM_DIGEST \
  --platform linux/arm64 --out /absolute/new-task --root /absolute/hitch-state
```

任务必须明确声明交付和评估合同：

```json
{
  "delivery": {
    "format": "csv",
    "path": "submission.csv",
    "idColumn": "id",
    "targetColumns": ["label"],
    "predictIds": ["101", "102"],
    "valueType": "label",
    "labels": ["0", "1"],
    "maxBytes": 16777216
  },
  "evaluation": { "mode": "delivery", "version": "prediction-v1" }
}
```

这是无标签预测交付任务，只验证文件及格式，质量分不可用。官方 Titanic train/test 数据也遵循此规则：训练内 CV 不能称为官方测试准确率。要建立可评分开发任务，应自行准备隔离评分划分，使用明确的自定义评估版本，并以 verifier 私有资源提供答案。

可评分任务使用 `evaluation.mode: scored`，声明指标、版本和 grader。正式 MLE-bench 导入保留上游原始任务说明、公开数据、私有答案、grader 源码及其摘要；正式质量分来自独立 verifier。私有答案及评分代码不进入候选镜像或 Meta 材料。verifier 仅读取提交 CSV，不加载 Agent 的 Python 模块或 pickle。

## 参数与能力

`parameters.json` 分离参数默认值、JSON schema、精确 JSON Pointer 权限及能力要求。导入配置的 `parameters` 是任务作者的完整合同；`userParameters` 提供准入时的完整有效参数，`parameterPolicy` 仅收紧包权限，这两个用户覆盖字段会单独封存在 `parameter-overrides.json`，不会改写包合同。用户准入覆盖放在任务的 `parameter-overrides.json`，格式为 `{ "version": 1, "parameters": { /* 完整有效参数 */ }, "parameter_policy": { /* 可选收紧规则 */ } }`。Meta 候选默认读取封存 harness 中的 `source/task-parameters.json`，格式为 `{ "version": 1, "tasks": { "TASK_ID": { /* 完整有效参数 */ } } }`；任务也可通过 `candidate_parameters` 明确声明候选参数文件。参数解析顺序为默认值、用户准入覆盖、Meta 候选覆盖、Target 动作取值。未知路径默认不可改；父对象替换、字段删除、另写配置文件或修改 sandbox 副本不能改变权威权限。

`method.cv` 是训练内部方法；`evaluation` 是正式评分协议。修改允许的内部 CV 折数或模型参数可在共同 grader 下比较最终质量，修改正式评分数据、grader 或指标必须创建新评估版本并重新评估 baseline。

`mutable: true` 需要声明主体、范围及 `apply_at`。`task_start` 值在 Agent 启动前确定，`training_start` 值在对应训练动作开始时冻结。Target 用 `python3 /tmp/hitch-parameters.py show` 查看有效配置，用 `python3 /tmp/hitch-parameters.py submit ACTION_ID FULL_PARAMETERS_JSON_FILE` 在训练前提交完整参数。相同动作 ID 的相同请求可幂等读取；更换值必须使用新动作 ID，旧动作不能改写。已接受和拒绝的配置变更均记录主体、路径、旧值、新值、规则、阶段和原因。权限策略在准入时冻结，sandbox 副本不是权威存储。

默认 `fit_accounting: observed`、`cv_execution: agent`、`max_fits: null` 和 `freeze_selection: false` 允许普通训练脚本。观测或自报 fit/CV 信息不是强制执行证据。非空硬 fit 上限、可信 CV 或冻结选择需要任务声明且运行环境真实支持的能力；未提供足够覆盖时返回 `unsupported_constraint`，不会启动收费模型。不能仅包装某个 `fit` 函数便声称限制所有训练行为。

## 执行和结果

导入并配置环境后，通过标准命令运行完整任务：

```sh
hitch --root /absolute/hitch-state eval run \
  --dataset /absolute/new-task \
  --harness 'codex@version:EXACT_VERSION' \
  --model MODEL \
  --attempts 1 \
  --timeout 1h \
  --infrastructure-retries 0 \
  --output json
```

模型、不可变 harness 版本、资源额度与实际路径由操作者填写。`--attempts 2` 表示两次完整执行；基线和两个候选各两次执行共六次 Agent 采样。任务内比较多个模型不生成额外 Target 会话，也不需要用户补跑最终 refit。失败、新评估版本和重新采样继续消耗已授权预算。

同一个任务可以使用 `--attempts 2 --max-concurrent 2` 运行两次独立实验，或用 `--attempts 3 --max-concurrent 3` 同时运行三次；`--max-concurrent 1` 则串行运行。daemon 的全局并发容量、容器槽、构建槽及 CPU／内存余量共同决定实际并行度。Gear 的 `profile.maxConcurrent` 是一次 operation 中所有 task/repetition 的总并发上限，跨 operation 仍由 Hitch daemon 的全局容量约束。

同 task 并发只对宿主验证支持 `hitch-attempt-isolation@1` 的冻结本地 Docker runtime 和任务开放。声明固定容器名、宿主端口、宿主可写 bind、外部 volume／network／config／secret 或宿主 namespace 等无法证明隔离的任务保留 task 锁并串行执行；远端 worker 当前也保守串行。因此 `--max-concurrent` 是上限，不保证任意任务都会同时启动。

每个实验得到单独的 materialized task 目录、Compose project／容器与可写数据副本。资源工作目录位于 `HITCH_ROOT/store/benchmark-resources/workspaces/WORKSPACE_ID/TASK_ID`，结束并封存结果后删除，审计记录保留在同级 `workspace-records/WORKSPACE_ID.json`。每个 run 的输出独立保存在 `HITCH_ROOT/runs/RUN_ID/output-artifacts/files/`，清单 `output-artifacts/manifest.json` 绑定 run、eval、attempt、任务摘要及各文件 SHA-256。相同的 `/app`、`/output` 容器内路径不表示跨实验共享目录；下一次实验不会自动继承上一次的代码、模型或输出文件。镜像及不可变输入缓存可以复用，已训练模型若需保存必须由任务程序显式写入声明产物目录；保存产物不会自动启用续训。

进程结束、交付存在、格式合法、约束验证和质量可用是不同事实。缺少必需文件属于交付失败；无标签数据只返回交付有效性；verifier 或证据故障属于基础设施错误，不伪装成质量零分。训练失败的退出状态及有界错误通过通用轨迹和产物接口保留。Gear 只能使用显式配置且来源可信的正式指标晋升候选。

使用 `hitch verifier artifact RUN_ID parameter-evidence.json --json` 读取已封存、经脱敏的权威配置与变更审计，使用 `hitch trajectory project RUN_ID --profile analysis --json` 查看授权诊断，使用[运行产物接口](run-output-artifacts.zh-CN.md)读取交付文件。私有标签、隐藏评分细节和私有推理不进入 Meta 诊断。

## 验证范围

`npm run test:mlebench` 验证确定性任务与评分合同；`npm run test:mlebench:package` 验证安装包 API、CLI 和旧执行链缺失；通用测试覆盖 Terminal-Bench、AutomationBench 和 Harbor 回归。

验收应分别登记静态/确定性测试、真实 Linux sandbox 执行和真实模型执行。前两类不能代替真实模型验证，CSV 格式通过也不能描述为模型质量通过。

参数合同可声明 `evaluation_inputs`（任务目录中的不可变普通文件）以及 `candidate_inputs`（候选文件或目录）。宿主按内容、路径和可执行位计算身份：原始任务、正式评分配置与 frozen policy 决定 `evaluation_id`；实际候选内容、harness 和 Meta 参数决定 `candidate_id`；编译后 dataset、运行时、重复序号和完整有效参数进入 `execution_id`。因此仅修改候选 prompt 或获准方法参数不会产生新的评价版本，评分输入或权限变化会产生新的评价版本。

编译器通过公开 `agent-hitch/parameters` 的 `prepareParameterCandidateInputs(taskDirectory, candidateInputPath)` 保存 `evaluation_inputs` 的原始副本，再注入候选文件。副本位于保留的 `gear-evaluation/`，`evaluation_input_origins` 记录一对一原逻辑路径，使直接运行与编译运行保持同一评价身份。重复编译保持副本不变；保留目录碰撞、路径逃逸、符号链接和缺失文件被拒绝。该帮助函数只调整身份输入声明，不修改参数默认值、schema 或权限。通用资源 materializer 也会在替换镜像运输引用和追加计划标签前保存原文件，并复用编译器已有副本。

任务作者可显式设置 `trustedTraining: { version: 1, coverage: "trusted-service-top-level-attempts" }` 启用已安装的 tabular 服务；普通任务继续使用开放代码路径。默认 verifier 为 1 CPU／512 MiB，此时服务的最低总资源为 `cpus: 3`、`memoryMb: 1536`。启用服务后 `cpus`／`memoryMb` 表示候选、trainer 和 verifier 三者总预算：候选固定 1 CPU／512 MiB，先扣除显式或默认 verifier 额度，剩余额度全部分配给 trainer，trainer 至少需要 1 CPU／512 MiB。例如总预算 3 CPU／2048 MiB、verifier 1 CPU／256 MiB 时，trainer 获得 1 CPU／1280 MiB。运行镜像必须满足安装包 manifest 的固定摘要及 Python / NumPy / pandas / sklearn 版本。以 `defaultParameters("trusted-service-top-level-attempts")` 构造参数合同时，可设置 `training.max_fits: 9`、`training.fit_accounting: "enforced"`、`training.cv_execution: "trusted"`、`delivery.freeze_selection: true`。此计数仅覆盖该隔离服务中的顶层训练尝试：每个 CV fold 和 final fit 各计一次，失败尝试照计；不声称覆盖 Agent 在其他工具中的任意训练。`all-training` 强约束仍须拒绝。

Agent 使用同一通用入口 `python3 /tmp/hitch-parameters.py call REQUEST_JSON_FILE` 调用服务。`evaluate` 请求指定 `binding: "trainer"`、不可变 `id`、已登记的 `parameter_action`（或任务初始值 `"task"`），以及 `arguments.model`。当前服务支持数值特征的 `logistic_regression` 与 `decision_tree`，可选标准化并自动做中位数填补；具体参数界限写入任务说明。`deliver` 使用已完成的 `source_action`，在当前任务内 final fit 并写出 CSV。宿主先保留整次操作所需配额再执行；相同 ID 重放不增加尝试，缺失执行证据不会被视为成功，冻结交付后不能替换方案。受信 CV 依然是诊断指标，独立 verifier 的外部质量评分单独提供。

权威审计中的 `counters.reserved` 表示已保留但尚未开始的尝试，`counters.consumed` 表示已开始的尝试（含失败和取消），两者之和不得超过任务开始时冻结的 quota。`state.capability_runtime` 保存实际隔离服务的 cgroup、源码摘要和依赖探测；不能用候选自行提交的标签、日志或计数代替这些证据。

当前适配器将 `maxActionSeconds` 保守地用作整个受信服务会话的上限（含两次调用之间的等待），并受 Agent 墙钟期限约束。宿主在首次实际 runtime probe 时持久化 `capability_deadline_ms`；后续准备只会收紧该期限，超时后拒绝新的 reserve / start，恢复执行不能续期。
