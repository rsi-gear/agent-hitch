# 通用 benchmark 资源存储

该功能显式启用。普通 task 与 `benchmark.adapter.json` v1 沿用原协议；资源任务使用 v2、`hitch-resource-lock@1` 和 `hitch-resource-selection@1`。公共 API 为 `agent-hitch/resources`，CLI 为 `hitch --root ROOT resources request OPERATION --input REQUEST.json`，均返回 JSON。schema 在 `docs/schemas/hitch-resource-*.schema.json`，跨仓库固定向量在 `test-contracts/hitch-resources-v1.json`。

## 配置与 producer

先通过 `configure` 写入宿主策略，例如（摘要应替换为实际平台 manifest）：

```json
{
  "protocol": "hitch-resource-host@1",
  "transport": {"sha256:<64 hex>": "registry.example/runtime@sha256:<64 hex>"},
  "imagePolicy": "cache-only",
  "platform": "linux/amd64",
  "workspace": {"mode": "auto", "maxCopyBytes": 8589934592, "maxWorkspaces": 4},
  "offline": {"exportFormat": "registry-bundle"},
  "limits": {"maxObjectBytes": 1073741824, "maxTotalBytes": 8589934592, "maxFiles": 100000, "minFreeBytes": 67108864, "maxViewBytes": 536870912}
}
```

正常准入的 `cache-only` 从不 pull；`cache-first` 仅在镜像缺失时 pull；`registry` 保留原注册表解析行为。首次在线准入还获取并按摘要校验原始平台 manifest，核对 Docker 实际 config 后持久保存证明；cache-only 要求该证明已存在或由离线包导入。transport 与凭据不进入 task/plan 内容身份。镜像必须按固定平台 manifest digest 解析；多平台 index 不能冒充平台 manifest，index membership 尚不支持。

Producer 先 `import` 公共文件或目录，获得 resource 与 producer lease；写小型 task、完整 lock、Dockerfile 和角色声明，再 `seal-dataset`。只有完成闭包校验、durable pin 和后端准入后才发布 v2 manifest，最后 `lease-end`。大输入必须使用 bindings；小型描述上限 32 MiB。两个实例：

- `benchmark-packages/shared-tree/import.mjs`：主要共享数据 tree，candidate 私有输入、verifier 专属答案。
- `benchmark-packages/automationbench/resources.mjs`：从只读 v4 数据集构建一次 simulator/verifier runtime；保留完整重建源码、锁文件、recipe 和来源 task digest。

所有导入源须受控且在导入期间静止；实现核对打开文件与路径指纹、最终目录清单，并拒绝符号链接、特殊文件和路径碰撞。这不是抵御同权限宿主进程持续竞争改写的安全边界。

## 执行与身份

`preflight` 请求为 `{"ref":"/absolute/dataset-or-selection","owner":"experiment:123","generation":1}`。返回已封存的 tasks、每任务语义 plan 及 aggregate digest。Gear 在 condition/cell/batch 身份建立前调用它，提交和恢复重新校验。copy/clone、transport 位置及缓存路径不进入语义 plan。

首版后端 `harbor-role-context@1` 要求：

- candidate Compose build context 为 `environment/candidate`，service 为 `environment/services/<id>`，verifier 为 `tests` 且 `environment_mode="separate"`。
- Compose 文件使用 JSON；只接受明确允许的字段，不接受宿主 volume、privileged 或外部 build context。
- 每个角色的 Dockerfile FROM 对应该角色显式绑定的固定 OCI `build-base`；运行时镜像槽、跨 stage COPY、ADD、外部 frontend、build mounts、需要网络的 RUN 均拒绝。
- 文件/tree 使用 `private-copy`，可以 CoW 或普通复制。`read-only` 需要真正强制只读的后端，当前后端明确拒绝。
- 一次物理执行一个 task/attempt；workspace 并发、复制字节、导入对象、视图缓存和剩余空间有界。

actual tree proof、plan、复制统计与容器实际 image config/platform/base layers 写入 sealed run 的 `resource.execution.json`。只有执行结束、结果封存、Docker/远程结束确认全部成立才回收 workspace；失联继续保留。Package-native phase 描述与 resource-aware verifier-only 远程重评分目前不在该后端能力内，提前拒绝；普通协议的既有支持范围不变。

正常结果和诊断结果均封存资源证据。远程结果的 `resource-proof` 仅携带相对原输入新增的物化证明对象，总量上限 32 MiB；控制端校验 task/plan、OCI config 与全部证明字节，持久 pin 完整闭包后才发布结果。公共文件输入不随结果重复传回，worker 的临时 workspace 可以在结束确认后回收。

显式兼容导出：

```sh
hitch --root ROOT resources legacy-export --ref /absolute/v2-dataset --output /absolute/new-v1-dataset
```

导出保留角色边界、来源和物化证明，生成新的 v1 dataset identity。不能复用原 frozen cell。新执行可使用已保留的原 plan 再次 `materialize`；历史 roots 保证全部重放输入仍受保护。

## 远程与离线

控制端与 worker 使用 work spec v3、`hitch-resource-delivery-v1` 输入和 worker feature `benchmark_resources: "1"`；该 feature 要求 Docker、BuildKit 和匹配平台。旧 worker 在派发前拒绝。harness/runtime 的旧 envelope 保留；task input 只携带描述和对象清单。对象走当前 lease/generation 授权的流式端点，验证长度和 SHA；不能通过知道摘要读取别的任务对象。

交付清单中的 OCI 身份必须与所选任务声明完全一致，并按身份排序去重；缺失、额外、重复、平台或 index 身份替换均在读取对象和调用镜像 provider 前拒绝。每个缺失对象的读取有 120 秒预算；即使 reader 或迭代器没有响应传入的取消信号，接收端也会中断等待、关闭暂存文件并释放 store 锁。失败导入已有的保护 lease 保留，按显式恢复流程处理。

`bundle-export` 请求为 `{"ref":"...","output":"/new/bundle","owner":"bundle:123"}`。文件对象唯一存放，OCI archive 经 provider 单独保存，不进入文件 CAS。导出过程中限制流量、磁盘剩余和时长。

默认 OCI 离线格式 `registry-bundle` 保存原始 manifest、config 和压缩 layer 字节，每一项按原摘要校验。导出需要访问来源 registry；首版支持公开访问/匿名 Bearer，私有 registry 认证不自动读取 Docker 凭据。`docker-archive` 不能保证原 manifest、RepoDigest 和展开预算，现在明确拒绝，不会直接调用 Docker load。

导入先扫描所有镜像 layer 的展开 tar，累计展开字节不超过 `limits.maxTotalBytes`、条目不超过 `limits.maxFiles`，并校验 config 中每层的 uncompressed diff ID。压缩 blob 仍受 `maxObjectBytes` 和总包大小限制。支持 gzip/普通 tar、常规文件/目录/链接、PAX 和 GNU 长文件名；稀疏文件、特殊节点、未知 PAX 语义及未知压缩 codec 明确拒绝。路径逃逸、重复条目、链接父路径和损坏 header 在任何 registry 写入或 Docker pull 前失败；不在宿主提取条目。首次在线 pull 也先在有界私有 staging 中下载并完成相同扫描，随后清理 staging；已在 daemon 中按摘要命中的镜像不会重新展开。

目标配置 `cache-only`、`offline.registry: "http://localhost:PORT"`，并将 transport 中的各摘要映射到该 registry 的目标 repository。registry 必须由操作方预先启动，且明确配置为 loopback；Hitch 不启动全局服务。以 `bundle-import` 请求 `{"directory":"/bundle","output":"/new/selection.json","owner":"offline:123"}`。先核对全部索引、manifest、config 平台和 blob，再向该本地 registry 写入原字节并按**原摘要**载入 Docker。不会访问源 registry，也不改用 tag。task 源描述保持原样，物化时仅将 Dockerfile 的固定摘要换成对应 transport repository；语义 plan 不变，实际物化字节另记证据。

重复导入只获取缺失文件对象/registry blobs。导入成功后执行仍为 cache-only；实测关闭源和目标 registry 后仍能构建并执行。验收从空文件 CAS、空目标 registry 和不存在的目标镜像引用开始；Docker daemon 的其他镜像层仍共享，没有清空用户整个 Docker 存储。

## 引用与显式回收

`inspect` 返回本 store 的对象、描述视图、视图 quarantine、普通 quarantine、workspace、staging 和引用记录统计。逻辑字节与 allocated blocks 分列；allocated blocks 可能在 CoW 下重叠，不代表独占物理字节。源 dataset、OCI/BuildKit 和 retained run 占用另计。

`pin` 请求包含 `owner`、正整数 `generation`、`purpose` 和完整 `lock`。相同 active generation 可幂等重试；released generation 不可复用。`release` 使用 `{"owner":"...","generation":1}`，旧 generation 不能释放新引用。producer、bundle、Gear 实验和 sealed run 的 owner 独立，释放一个不会释放其余 owner。

`audit` 默认 dry-run；`{"apply":true,"graceMs":86400000}` 显式启用两阶段 quarantine/删除。pin、acquire、发布、恢复与 GC 共用 store 锁；全部引用和对象校验完后才变更。损坏、缺失、未知状态会停止回收。OCI roots/leases 从首次使用起进入既有 image GC 可见的 protection fence；preparing fence 未解决时 image GC 保守停止。

崩溃后用 `inspect`/`audit` 检查引用；确认导入已经结束后 `lease-end {"leaseId":"...","confirmation":"ended"}` 清理该 UUID 的 staging 并结束保护。无法证明远程结束时使用 `unknown`，不得按 PID、年龄或超时释放。执行 workspace 通过 `workspace-end` 要求明确 `executionEnded:true` 和 `resultSealed:true`；CLI 确认由操作方负责，正常执行链自动提供实际结束证明。

## 验证

单元/集成覆盖共享对象、隔离写入、未知能力、摘要/路径/平台错误、预算、两进程发布与 GC、SIGKILL、旧 generation、view/quarantine 重获、旧 worker 和 lease 对象授权；`resource-transfer.test.ts` 另覆盖镜像清单与任务声明的完整对应，以及停滞 reader/迭代器的取消和锁释放。真实 Docker canary 单独运行，无模型调用：

```sh
npm run build
node dist/scripts/canary-resources.js
node dist/scripts/canary-automation-resources.js ROOT V2_DATASET V4_DATASET TASK_ID
node dist/scripts/canary-resource-empty-daemon.js SHARED_TREE_CANARY_BUNDLE
```

第一个 canary 的临时 registry 默认使用 loopback 端口 52989，可通过 `HITCH_RESOURCE_CANARY_REGISTRY_PORT` 指定其他空闲且 Docker daemon 可访问的端口。

空 daemon canary 需要预先缓存 `mirror.gcr.io/library/docker:27-dind` 和 `registry:2` 基础设施镜像。它新建隔离 VFS daemon，不挂载宿主 Docker socket 或用户目录，检查初始镜像/BuildKit 为空；导入后停止 registry、断开 daemon 外网再执行及评分。默认 loopback 52990；记录基础设施、导入和执行阶段的 Docker/BuildKit 快照，并连续采样源 dataset、selection、文件 CAS、视图、工作区、导入 staging、bundle 和封存证据。Docker 总项只计一次；allocated blocks 不作为 CoW 独占物理字节，短于采样间隔的瞬态可能遗漏。证据封存后确认 execution lease 和 workspace 回收，最后只删除自身容器及匿名卷。

后者运行 candidate 隔离检查、模拟器 API 调用和官方 verifier，并将同一 snapshot 交叉评分；初始化随机 ID/时间戳不当作存储语义变化。canary 只删除自身创建的容器和镜像 tag，保留证据目录，不 prune 现有缓存。
