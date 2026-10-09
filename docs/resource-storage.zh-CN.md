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

## v1 目录数据集校验

各阶段优化的测量方法、冷/热缓存收益及证据边界见 [2026-10-09 性能记录](evidence/eval-preparation-2026-10-09.md)。

标准 v1 数据集的正常 eval 在 admission/planning 时校验全部 task，收集每个结果时校验锁定的 manifest 摘要、评分契约、task 集合和当前 task 的全部文件，最终完成前再校验一次全部数据。已收集 task 后续发生的变化会使最终 eval 失败。取消不增加全量扫描；没有前后校验边界的独立导入、恢复和手动重跑入口继续使用全量校验。

这个优化按 manifest 的 task 身份工作，不依赖 benchmark 名称、文件布局或 task 数量，不缓存路径或文件修改时间。文件内容、执行权限、文件增删和链接仍参与检查，失败后重试会重新读取。无 native phase 描述的 task 直接跳过描述解析所需的校验；导出的 native phase task 仍校验描述所在的 task。Package-native 编译包原有的 source/compiled 整包证明保持不变。v2 数据集和 selection 继续使用资源闭包校验。

对每个 task 收集一次、无 native phase 描述的 v1 eval，task payload 的读取量由随 task 数量平方增长变为线性增长；manifest 解析和 task 集合检查仍逐次执行。这不改变 task 数据的物理副本，也不替代 v2 的 CAS 去重。可用不调用模型的脚本复现校验开销，先运行优化版，再运行旧版，再运行优化版，检查身份和描述结果完全一致：

```sh
npm run build
node dist/scripts/benchmark-dataset-verification.js \
  --dataset /absolute/v1-dataset \
  --baseline /absolute/old-agent-hitch-package \
  --output /absolute/comparison.json
```

输出区分整个校验序列与逐 task 收集阶段，记录文件读取次数及逻辑读取字节；这是校验回放，不是完整 eval 加速比，也不是物理磁盘吞吐量。

## 共享 controller 与 harness 安装目录

本地 Linux Docker eval 可显式启用 `HITCH_HARBOR_RUNTIME_TRANSPORT=readonly-bind`：

```sh
HITCH_HARBOR_RUNTIME_TRANSPORT=readonly-bind hitch --root ROOT eval run \
  --dataset DATASET --harness HARNESS --model MODEL --max-concurrent 16
```

每个 eval 为 controller bundle 创建一次独立快照，为每种固定内容身份的 harness artifact 创建一次快照。优先使用文件系统 reflink，不支持时复制；不使用硬链接。目录填充完成后恢复原始权限，完整校验固定身份与内容，再通过原子重命名发布。不同 task 将这些快照分别只读挂载到 `/opt/hitch` 和 `/opt/hitch-harness-artifact`，共用依赖文件和宿主页缓存，减少逐 task 上传与容器可写层副本。实现不依赖数据集名称、任务布局或 harness 类型。

任务的工作目录、状态、凭据和 Node 解包目录仍各自隔离。bridge 与容器内原有内容校验保留，不使用路径、mtime 或“校验过一次”的全局缓存跳过检查。bridge 检查 Docker 实际挂载源、只读标志、嵌套遮挡和候选容器权限；冲突、缺失或内容错误会失败。额外的 verifier 容器不会获得这些安装目录。

此模式要求 harness 运行时不改写安装目录，并使用能够访问快照路径的本地 Linux Docker daemon；远程 worker 不支持该选项。需要改写安装目录的 harness 使用默认上传方式：不设置该变量，或设置为 `upload`。显式选用共享模式后不会因挂载错误静默回退。

快照保留在 `<eval-directory>/shared-runtime/`，随 eval 的本地工作文件一起留存，避免取消、恢复或另一轮执行清理仍在使用的文件。原缓存的后续改写不会改变已发布快照；宿主自身仍是受信任边界，不能由同权限进程改写这些快照。只在确认该 eval 的容器全部结束且无需保留本地 job 重放后，才能清理其快照。持久化的 artifact 身份不包含这些临时传输路径，既有恢复和远程交付继续采用原上传路径。

真实 Docker 回归检查只使用已存在的固定 Node 镜像，不调用模型或下载镜像：

```sh
npm run build
HITCH_NODE_RUNTIME_DOCKER_TEST=1 \
  node --test dist/test/shared-runtime.integration.test.js dist/test/harbor-node-runtime.integration.test.js
```

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


## 候选、配套服务与独立验证器的镜像准备缓存

POSIX 宿主上的 Linux Docker 环境可显式启用：

```sh
export HITCH_HARBOR_IMAGE_CACHE_DIR=/absolute/private/path/prepared-images
export HITCH_HARBOR_IMAGE_BUILD_SLOTS=2
export HITCH_HARBOR_MANAGED_KEEPALIVE=1
```

未设置时使用原构建与停止行为。缓存目录由当前用户所有，不能由其他用户写入。同一目录的使用者应采用相同的 build slots 设置；这是缓存内的构建限流，不替代 eval 的资源预算。冷缓存仍要构建并载入镜像，默认最多两个构建同时进行；缓存命中只需快照校验和镜像检查，不占构建槽位。

bridge 在 Harbor 的实际环境目录上读取 Compose 最终解析后的构建配置，因此同一逻辑覆盖候选、Compose 配套服务、独立验证器及多步骤验证器。身份包括完整上下文的相对路径、内容和权限、Dockerfile、固定摘要的基础镜像、平台、target、显式参数/标签、实际 daemon、builder 配置以及代理配置。mtime 不代替内容校验；完整上下文参与身份，未被 COPY 使用的文件变化也会保守地使缓存失效。不按数据集、task 名称或文件名写特殊规则。

构建消费独立复制的快照。相同内容在不同目录、task、轮次或角色之间可复用；进程间文件锁合并同一个构建，原子写入记录。每次命中仍核对 Docker 中的镜像 ID、平台和缓存身份标签。镜像被删除或记录不匹配时重新构建；失败和取消不发布记录，取消先收回构建子进程再释放锁。配置、构建参数及凭据值不写入缓存记录或诊断收据。

目前缓存支持普通文件/目录的本地上下文、标准 Dockerfile、固定摘要基础镜像、build args、target 和 labels。基础镜像配置也检查继承的 ONBUILD。可变基础镜像、自定义 frontend、ADD、RUN 外部挂载、SSH/secrets、额外上下文、符号链接/特殊文件/xattr、显式 pull/no_cache 等不能完整确定输入的配置，整组 Compose 保留原构建路径。首次获取基础镜像配置可能需要 registry；校验后的固定摘要配置可在后续直接复用。force_build 绕过准备缓存。只有 Harbor 显式发出的 build 请求进入缓存；已选择预构建镜像时，up 保留原有镜像及 pull policy 的优先级。

命中后用不可变镜像 ID 启动，移除对应 build 字段并设置 pull_policy=never，防止 up 再次构建。候选、验证器和配套服务仍各自创建容器、可写层、工作目录和日志；缓存目录不挂入任何任务容器，评分、产物传递、资源和网络限制不变。候选预构建镜像参数不会传递成验证器的镜像。

managed keepalive 只替换 Harbor 默认的 sh/sleep 保活命令，让 shell 接收停止信号、终止并等待 sleep、正常退出。任务声明 command、entrypoint、init、停止信号/超时或 pre_stop，镜像含 ENTRYPOINT 或使用其他停止信号时，保留其行为。不会缩短用户停止宽限期或复用有状态验证器。

准备镜像持久保留；使用缓存的 down 不执行 --rmi local，容器、卷和网络仍按原参数清理。目录中的 image-*.json 给出对应的 Hitch 专用镜像 tag，可在确认不再被使用后按 tag 清理；删除缓存记录不等于删除 Docker 镜像。缓存镜像或记录被外部清理后，下次使用会重新准备。宿主同权限进程仍属于受信任边界。

每个环境在 trial 根目录写入 hitch-preparation-*.json，包含命中/回退、镜像 ID、缓存 key 以及快照、基础镜像检查、锁等待、构建和探测时间。可移植验证器重放移除宿主安装与缓存路径，保留评分设置。

真实 Docker 回归使用独立应用 fixture，不调用模型；基础镜像以摘要指定，可从 registry 获取：

```sh
npm run build
HITCH_IMAGE_PREPARATION_DOCKER_TEST=1 \
HITCH_HARBOR_TEST_PYTHON=/path/to/harbor/venv/bin/python \
HITCH_IMAGE_PREPARATION_TEST_IMAGE='node@sha256:YOUR_DIGEST' \
  node --test dist/test/image-preparation.integration.test.js
```
