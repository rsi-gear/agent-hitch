# Gear / Slime 训练绑定

本文说明 Hitch 与 Gear / Slime 的训练绑定、独立评估及恢复合同。已验收的拓扑是本地 Harbor 配合远程单卡训练 / SGLang 进程节点。远程 Harbor / Docker、双卡以及真实主机重启恢复仍待实机验收；完整 remote capability 和 Gear 完整远程准入保持关闭。

## 注册与提交

`hitch training runtime --json` 输出版本化的 CLI 包观察：实际编译代码、training-tool 和 Harbor bridge 的 runtime digest、Node/package 版本，以及包自身 Git checkout 的 commit/代码修改状态。没有自身 checkout 时明确报告源码身份不可观察，不使用父目录仓库或 package version 代替 commit。Gear v2 冻结部署会绑定此观察，训练 preflight 会核对 runtime lock 的 `hitchCommit`；这不替代常驻 daemon、执行 worker 或实际 Docker/模型链路的验收。

`hitch training register --file PATH|-` 接收版本化 training-external binding 和控制端私有 gateway credential。binding 注册不可变；私有文件权限 0600。eval 提交只保存 endpointRef / credentialRef，Harbor 获得独立的 run-scoped Hitch proxy route 和非秘密 sentinel，不能调用 Slime 的原生 `/generate`、权重管理或会话管理接口。

训练提交使用以下模板，将 `...` 替换为一个已知 Harbor task 的选择参数：

```sh
hitch eval submit ... \
  --training-binding-file BINDING.json \
  --harness training-tool@git+file:///source/hitch#COMMIT \
  --model training/BINDING_ID \
  --attempts 1 --infrastructure-retries 0 \
  --provider local-docker \
  --model-capture proxy --require-model-capture
```

训练绑定仅允许一个已知 task、一次 attempt、无参数/env 覆盖、无自动重试。绑定加入 request、execution plan、candidate identity、capture route 和 canonical run；恢复仍使用同一 binding。训练 logical slot 由 Gear batch coordinator 修复，普通 `eval rerun` 不能替代这项操作。

每次代理调用验证 policy fence、expiration，并将 token 凭据与一个 canonical runId 绑定。gateway 在首次生成前收到私有 `/v1/hitch/run` 注册。精确 receipts 由 Gear gateway 使用 native SGLang token/logprob 元数据保存，Hitch HTTP capture 不会被宣称为精确 token 证据。

固定 `training-tool` runner 使用 Chat Completions，按顺序追加 assistant/tool 消息，不做 compaction、分支或辅助模型调用。退出时提供明确的 terminated/truncated 标记；`hitch training evidence RUN --json` 验证 canonical run 完整性后公开训练身份和终止原因。有效 task reward=0 仍是有效观察。

完整配置、Slime 固定版本与 export patch、checkpoint/replay 语义、GPU 探针和训练操作见 [Gear 训练文档](https://github.com/rsi-gear/gear/blob/codex/slime-model-training/docs/training/README.zh-CN.md)。发布只更新 Gear 的 immutable model 指针，现有 Hitch episode 继续使用原模型 ID。

## 独立评估与有序暂停

评估导入模型使用既有 immutable `local/sha256:…` 管线。`hitch local plan MODEL --harness REF --gpu GPU-UUID --offline --json` 在不启动候选任务的情况下准备 runtime/lock；`hitch local inspect INFERENCE_DIGEST --json` 读取精确锁。training-tool 使用明确的 Chat Completions lock，并检查流式/非流式终态；Codex 保留 Responses 路径。

Gear v2 独立评估通过 `ordered_eval_control="2"` 能力使用持久 start/pause 指令。指令只包含 `schema_version="2"`、`key`、冻结请求的 `subject_digest`、非负整数 `sequence` 和 `action`，Gear 自动保存不可变指令文件。公开调试入口：

```sh
hitch eval control --file INTENT.json
hitch eval submit ... --control-file START.json
hitch eval rerun EVAL_ID --invalid --daemon --rerun-id RERUN_ID --control-file START.json
```

`eval control` 首次调用即保留原 key 和 eval ID，暂停可以先于提交到达且不启动任务。后到的较小序号被拒绝，相同序号不能更换 action；恢复使用更高 start 序号和原 eval ID。提交/修复附带同一指令文件，并与暂停在 daemon 中串行。暂停持久登记已取消的 rerun ID；新修复轮次必须使用新 ID，仍保留原有效观察。进入该协议的评估拒绝旧无序 cancel/rerun/submit 修改接口，普通 v1 评估不受影响。完整 HTTP 命令形状见 [ordered-eval-control schema](schemas/ordered-eval-control.schema.json)。

回复中的 `submitted` 区分保留身份与实际提交，`pending_reruns` 仅表示修复任务状态；它们不能代替模型节点的物理释放证明。Gear 通过 `local status` 和 `local inspect-service` 读取原服务累计 GPU 用量，按评估 key 的累计增量入账，超预算使用上述有序暂停收尾。

## 远程 worker 合同

### 能力与执行身份

远程 worker 路径使用 work spec v2，复用现有输入制品、generation/lease/epoch、事件与结果协议。训练 worker 必须显式声明 `features.training_external_binding="2"`，受管理模型需 `features.managed_model_node="2"`，两者都要求 Docker 与 model proxy。旧 worker 拒绝这些绑定。控制端私有模型路由位于 `worker-protocol/model-routes`（实际状态根由 Hitch 配置解析），模型地址和凭据不会进入 work spec 或 task 环境。worker 本机 relay 经认证的 worker HTTP 转发生成；在首次生成前声明一个 canonical run，控制端保存确认，回包丢失可按同一身份重试。

远程 `candidate-restart` 复用 worker 调度器。支持的 worker 额外声明 `features.physical_work="2"`，work spec v2 携带 `physical_execution`：保留原始 v1 plan 和摘要，按 rerun ID 或基础设施重试记录推导新的 work ID，worker 核对冻结的 logical slot、任务、制品和资源。普通 API 重跑可使用不含 model binding 的 v2 spec。旧 lease 必须确认释放，`lost`/`expired` 状态不能授权新的重跑；已发出的不明执行不会自动补发。训练 slot 仍由 Gear batch coordinator 修复，不开放 Hitch candidate 重跑。

managed-node 重跑使用独立的 `evalId:rerunId` 模型服务作用域。远程重跑的 lease 事件和执行 journal 写入 `evals/<evalId>/reruns/<rerunId>/remote-work`；完成结果可幂等重放。普通远程 eval 的 daemon 恢复导入也会核对模型绑定确认，基础设施重试使用 `replace-invalid` 发布语义。

远程 `verifier-only` 使用独立评分派发、assessment 导入、原候选冻结选择与完成交接；worker 必须显式声明 `verifier_only="2"`、`physical_work="2"` 与 Docker。

### 接受与进程授权

公开 Harbor worker 在接受任务时使用独立的 `POST /v2/workers/:worker/offers/:offer/accept`。请求包含 `schema_version: "2"`、原 `offer_id`、`generation`、`nonce`、固定的 `sent_at` 和 `ownership`；后者绑定原 work/输入/lease/resource epoch、root ID 与路径摘要、主机启动摘要、Docker engine ID 和原 worker 的 PID/启动身份。控制端响应 `{schema_version: "2", offer, admission}`，其中 offer 保留 v1 格式，admission 遵循 [独立归属合同](schemas/remote-worker-execution-admission.schema.json)。接受后的 v1 任务不能补录归属，也不能用 v1 重试降级已有 v2 归属。未使用归属扩展的旧 worker 仍走原接口；新版公开 worker 需要支持上述接口的 daemon。

新任务的嵌套 `ownership` 使用 schema 3，额外保存 `host_identity={schema_version:"1", platform, host_id, boot_id}`，`boot_digest` 等于该对象的摘要。本地 journal 对应 schema 2。主机身份来自 Linux machine-id 或 macOS IOPlatformUUID，启动身份来自内核 boot ID/启动时间；只保存摘要，不返回原始硬件标识。控制端在原 generation 接受任务前保存这项身份，之后不能替换。旧 ownership schema 2 与本地 journal schema 1 仍按原格式读取，不会事后补录主机身份或自动升级。

Harbor supervisor 在本地身份持久化后、真正启动 Harbor 前，还需调用 `POST /v2/workers/:worker/offers/:offer/process`，提交 `schema_version: "2"`、`offer_id`、`generation`、`ownership_digest` 和 `process`。控制端仅为原 accepted generation 记录一个不可替换的进程身份，返回 `{schema_version: "2", admission}`；两个接口均经 bearer 认证并返回 `Cache-Control: no-store`。归属与进程写入复用 offer 锁和最终 generation 保护，轮换后迟到的提交拒绝。worker 根目录明文不进入合同；这些记录只证明原身份曾获准执行，不是物理资源释放确认。

任务接受、事件、完成、释放和进程授权在响应丢失后重试时保留原时间、事件序号与进程身份。释放已落盘导致 offer 从列表消失时，runner 仍重放原释放请求并结束本地记账，已成功的清理不重复执行。接受写入在归属落盘后中断时，重试保留首次记录的接受时间；未完成接受的记录不能授权启动。

### 凭据轮换与隔离

worker generation 的在途提交与凭据轮换/撤销协调：创建 offer、接受任务、完成/释放回执、事件和制品发布在最终写入前核对原 generation，并在控制端与注册/撤销使用同一 worker 记录锁。上传接收与摘要校验不持此锁，心跳可以继续；轮换或撤销后到达的旧上传不能发布 blob/回执，临时内容会清理。HTTP 入口还将请求中的 generation 与该 bearer 实际认证的 generation 对照，慢请求不能在正文中改称新 generation。

旧 worker 收到明确的凭据拒绝后会自行停止：控制接口返回 401，或 403/409 携带 `worker_revoked` / `worker_generation_mismatch` 时，客户端中断本 generation 的在途请求并停止重试，runner 同时取消候选/verifier，等待执行器结束后调用本地清理。公开 CLI 以 `remote_worker_fenced`（退出码 11）退出。401 在响应头到达时即可触发，不等待错误正文。模型代理中的上游 401/403/409 不代表 worker 凭据失效；daemon 自己的认证拒绝带专用标记，上游同名标记不会转发。连接重置、503 和任务范围的错误不会触发 generation 撤销。

凭据失效后的自行停止只确认旧 worker 本地执行结束。失效的旧凭据不会再发送完成/释放回执；控制端旧 offer、原 resource epoch 和未确认预占保留。新 generation 的零 allocation 心跳不能替代清理回执。原 generation 的启动/资源归属凭据已保存到控制端，新 generation 可通过下面的独立协议确认原执行清理；跨主机启动周期还需原始主机身份记录。

执行或恢复期间发现 worker generation 已变化，会立即隔离旧 execution lease，不再等待离线重连期限；原 resource epoch 和尚未释放的 offer 预留继续保留，不能凭新 worker 的零 allocation 心跳放行重复占用。隔离本身不构成物理资源释放确认。

## 中断恢复与资源释放

### daemon 与重跑恢复

daemon 在恢复期间先开放 worker 认证、心跳、上传和释放通道，普通新任务返回 `daemon_recovering`。中断的远程 candidate 重跑先恢复原有 leases，再按原 `request.json` 的任务/attempt 选择继续；不因新发布的 progress 改选任务。sealed work spec、逻辑计划、请求和 journal 必须一致。已上传结果先记为 `collected`，确认 worker 释放后才成为 `completed`；释放超时报错并保留 fenced lease。未被接受的 offer 必须持久撤销并确认 lease 释放，才能标记 `not-started` 并补发。已完成的历史重跑不重新覆盖后来发布的逻辑 slot。所有选中 work 都完成时，只回收结果，不重新启动模型服务。

远程 candidate 完成时先写 `completion-pending.json`，保存完整结果及其摘要、对应 source result 摘要，再更新终态。scheduler 发布结果、同步 source control 后确认交接。同一 eval 的重跑在 scheduler 中串行，恢复只补交接，不再执行 candidate；旧完成记录不能覆盖后续 source result，重复恢复不增加 control generation。

取消操作必须等 worker 清理得到确认；仍有未释放 lease 时返回 `execution_state_ambiguous`，重复取消也不能把它当成已停止。若取消请求到达时完整结果已经封存，允许完成结果交接，保留原结果且不再执行 candidate。lease 首次写入 callback 失败也进入统一的 offer 撤销/隔离与锁释放路径。

worker 的迟到清理回执可协调原 `lost` / `expired` lease：核对原 offer、worker generation、资源与回执摘要，再写入版本化 `release_confirmation`。递增后的隔离 epoch 保留，`resource_epochs` 仍只包含真正执行过的 epoch；旧执行不能续租或恢复模型调用。结果按原执行 epoch 导入，不能改写 canonical 证据。新 candidate repair 的准入会先收回已获得释放回执的旧执行；没有回执仍拒绝补发。旧 v1 lease 继续原样解析，新确认字段不要求改写历史记录。

### 同 generation 的 worker 清理

runner 在 HTTP 接受前写入本地 `worker-execution.json`，绑定原 offer/nonce、work、lease/resource epoch、worker generation、worker 进程身份、主机启动身份、root 与 Docker engine ID。candidate 和 verifier 都通过 Harbor supervisor 启动：supervisor 收到父进程确认身份已落盘的 IPC 消息后才启动 Harbor；父进程在确认前死亡，不会遗留已经开始执行却没有记录的候选。

重新运行相同凭据、相同 root 的 `worker run` 后，已接受但不在内存中的任务进入清理。同一启动周期只向身份匹配的 Harbor supervisor 进程组发送终止信号，等待进程组停止；本地 schema 2 journal 还可根据已保存的同主机身份处理重启，跳过旧 PID 检查和终止。之后均按原 lease/epoch 清理 Docker 容器、网络和卷，并重新观察资源为空及主机/启动/引擎身份未变。同启动周期原 worker 仍活着、记录缺失、旧记录启动身份变化、root/主机/Docker 引擎变化、进程拒绝退出或资源观察失败时拒绝确认。本地清理支持重试，成功后沿用同 generation 的原 offer 失败/释放收尾，发送原 epoch 回执，不重新运行 candidate。控制端已持久化“接受前取消”的 offer 没有执行授权，可直接结束预占；已经接受的未知任务不能借用这一例外。

### 新 generation 与主机重启后的清理

新 generation 的公开 worker 会在后台请求 `POST /v2/workers/:worker/offers/:offer/cleanup-challenge`，发送 `schema_version: "2"`、原 `offer_id` 和当前 `generation`。控制端返回 `{schema_version: "2", challenge, receipt}`：未释放时给出绑定原认证 admission 的 nonce 和五分钟期限；已经确认时返回原独立 receipt。新 worker 必须仍使用原 root 和 Docker engine，核对本地 journal 与原 worker/supervisor 身份。同一启动周期内，原 worker 必须已退出；只有原授权的 supervisor 可以被终止。启动屏障前未获授权的进程不能按猜测的 PID 清理，必须已退出且进程组为空。

启动身份变化时，只有原 ownership schema 3 允许跨 generation 恢复：原记录和当前观察必须具有相同 platform/host_id，boot_id 必须不同，root/引擎仍须匹配。此时旧进程随前一启动周期结束，不检查或信号通知旧 PID/进程组，避免碰到重启后复用 PID 的新进程。清理前后重新观察主机/启动/引擎，原 lease 的容器、网络、卷必须全部清理并复查为空。该分支提交 schema 3 receipt，观察中使用 `worker_status="previous-boot"` 和当前 `host_identity`，不包含 `process_group_empty`；同启动周期继续提交原 schema 2 receipt。原授权 supervisor 身份仍必须与 journal 一致，不能用重启解释另一条已授权执行记录。

清理后重新列举确认原 lease 的 Docker 容器、网络和卷全部消失，再通过 `POST /v2/workers/:worker/offers/:offer/cleanup` 提交 `{schema_version: "2", offer_id, generation, receipt}`。独立回执遵循 [generation cleanup 合同](schemas/remote-worker-generation-cleanup.schema.json)，仅保存当前身份对原执行的物理观察；入口与最终发布都核对新 generation。原 v1 offer、nonce、terminal、完成/释放摘要和原 admission 不改写。控制端在原 lease 上写入 schema 3 的 `release_confirmation`，保留隔离 epoch 和真正执行过的 `resource_epochs`，据此核销旧预占，不能恢复旧执行权限。该确认只覆盖 Harbor 执行资源；模型节点的 GPU 释放仍需模型节点的独立证据。

成功清理后响应丢失会重放同一观察，不重复执行候选；回执落盘后、lease 更新前崩溃可由重新请求或 offer listing 修复。已确认的物理事实在再次轮换凭据后仍可读取；尚未发布的旧 generation 回执会被拒绝。后台清理不阻塞心跳，某条不可恢复记录不会阻止其他记录获得清理机会。缺失原认证 admission、本地 journal 不匹配、同启动周期原 worker 仍存活、旧记录缺少跨启动身份、迁移到另一主机、引擎变化或资源观察失败时继续保留预占。

### 模型服务恢复

模型节点发生 OS 重启后，先注册当前 generation 的连接，再用 `hitch model-node recover-service SERVICE_ID --file CURRENT_BINDING.json --json` 明确回收旧服务。节点必须提供原 owner/lock/handle、不同启动周期的归档证据及设备释放确认；不会按旧 PID 杀进程，也不会给旧任务重新加载权重。Hitch 保存独立 generation release 回执，原 v1 service、model node 和 inference lock 身份不变。确认回执可跨 daemon 重启、旧节点不可达和控制端落盘丢失重放；缺失或损坏的证据保持未释放。该命令不要求 daemon 正常启动。

同一 generation 的进程接管通过 `inference.attach` 完成：核对原启动请求摘要、监督进程与引擎的 PID 创建时间、当前设备账本和实时 Python/runtime/engine 观察；不启动进程、不生成探针 token、不清缓存，失败不释放旧占用。新建 managed-node 服务在发布 ready 前封存 `attachment.json`，绑定原 service/epoch/handle、完整模型锁和已通过的协议观察；接管保留原探针时间。

daemon 在调度器恢复活动任务前核对 accepted 远程 work、未过期 execution lease、当前 worker generation、原模型执行证据和私有网关摘要回执，再调用监督器 `recover(claims)`。同 generation 的进程及其原网关端口/run 凭据一起恢复；原 service/epoch、模型锁、canonical run 绑定和已封存输入不改写。网关摘要回执在首次发布给调用者前写入服务私有目录，避免恢复时采纳已损坏的地址或凭据。没有这些证据的旧活动记录不会被自动采纳。

启动期间，managed 模型请求等待网关恢复，worker 心跳和终态回执继续处理。暂时离线但 lease 未到期的 worker 保留模型 owner；生成仍要求当前 worker/lease 有效。恢复后的 owner 持续核对取消、终态、到期、撤销及 generation；失效后撤销网关注册并释放原 lease，正常续跑则由原 eval/rerun 接手这一 lease。无人持有的服务沿用 idle TTL 回收。

重复取得同一 managed 服务时，Hitch 在文件锁内核对原 `execution.json` 执行证据、模型锁与 manifest；同一 service/epoch 全部一致时保留原文件和准备时间，内容被替换时拒绝覆盖。

## 验证范围

### 自动化回归

先运行 `npm run build`，再执行所需测试。测试中的真实边界与 fixture 如下；CPU / HTTP 通过不能作为 Docker、SSH 或 GPU 实机认证。

| 测试 | 实际验证 | fixture 与限制 |
| --- | --- | --- |
| `remote-harbor-recovery.test.js` | SIGKILL 公开 worker CLI，再启动同 generation worker；原子进程结束、lease 释放、候选仅启动一次 | Harbor 与 Docker 为 fixture |
| `remote-worker-host-reboot.test.js`、`remote-harbor-ownership.test.js` | 本机身份读取、真实存活进程、HTTP 回执与预占核销 | 前一 boot 身份、Docker 资源与命令为 fixture，未重启测试主机 |
| `managed-candidate-recovery.test.js` | 默认模型管理器、节点 RPC/HTTP、公开 worker；首次模型调用后 SIGKILL daemon，同端口重启并完成原 canonical run | Harbor、Docker、模型与 GPU 观察为 fixture |

```sh
node --test dist/test/remote-harbor-recovery.test.js
node --test dist/test/remote-worker-host-reboot.test.js dist/test/remote-harbor-ownership.test.js
node --test dist/test/managed-candidate-recovery.test.js
```

其他本地 HTTP/CPU 回归覆盖输入到 canonical 回传、两次 shell 工具调用、幂等键与 receipt 响应头、API/managed-node 重跑、绑定替换拒绝及 lease 过期中断。上传后、发布前的恢复 fixture 验证缺少绑定确认时拒收，确认后只收回原结果。实际重启 daemon 的 candidate 测试核对冻结任务、canonical run、lease 数量与模型调用次数；managed-node 不新增服务。

分进程 daemon 中断测试保留原 worker/candidate 进程继续调用，不改写故障后的 service、eval、offer 或 lease 状态；恢复后原 service/epoch、网关证据与任务释放确认保持一致。真实跨主机 Harbor/Docker/GPU 中断、worker 断网与 generation 切换后的资源协调仍需实机验收。

### 历史实机验收

2026-09-10 在 RTX 5090 / Qwen2.5-1.5B 上完成本地 Harbor、远程单卡训练 / SGLang 进程节点的联合验收，覆盖两次更新及故障恢复、真实轨迹与信息隔离、独立 Hitch 评估和物理 GPU 交接。16 项证据见 [Gear 公开验收记录](https://github.com/rsi-gear/gear/tree/codex/slime-model-training/docs/training/certifications/2026-09-10-rtx5090-single-gpu)。独立评估有效但 reward=0，不表示模型质量提升。

认证仅对应记录中冻结的 checkout / runtime；提交或合并后的新身份需要重新冻结核验。远程 worker 合同与 CPU 故障测试不扩大该认证的拓扑范围。
