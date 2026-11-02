# 模型执行环境绑定 v3

`hitch capabilities --json` 的 `evaluation_environment_binding: "3"` 表示支持本协议。公开响应保持 schema v1；v2 增加实际 Harbor Python 内容校验，v3 增加环境引用文件内容校验。旧的私有 v1/v2 记录不能授权新执行。不能仅凭 Hitch 0.2.16 版本号假定可用。

管理员调用 `hitch --root <root> eval bind --model <model> --pass-env <name> --minimum-validity 45m --json`，CLI 向当前 daemon 的 `POST /v1/evaluation-bindings` 发送新 nonce。响应绑定 nonce、daemon instance 和 `Cache-Control: no-store`；公开 binding 格式见 `schemas/evaluation-binding.schema.json`。

绑定取自实际 EvalScheduler 的驻留环境，而非调用 CLI 的环境。根目录私有 HMAC 密钥绑定完整环境、模型、去重排序的 pass-env 名称，以及一次性取得的 helper 结果和有效期。相同根目录、环境、凭据及受检文件得到相同 ID；不同根目录使用不同密钥。公开响应不包含端点或凭据原文，也不暴露可用于离线猜测秘密的普通哈希。

同时绑定实际 Harbor launcher 指定的 Python 解释器、虚拟环境配置、模块搜索目录、启动时已加载模块的文件及 Python 共享库。按实际文件内容计算身份，不以包的版本号或 RECORD 中自报的摘要代替文件读取。检查读取期间的文件和目录变化；单次默认预算为 25 万个遍历条目（包含派生缓存）、2 GiB 读取量和 30 分钟。它们限制主机准备工作，独立于任务和模型执行期限。需要调整时，在启动 daemon 前设置正整数 `HITCH_HARBOR_PYTHON_RUNTIME_MAX_FILES`、`HITCH_HARBOR_PYTHON_RUNTIME_MAX_BYTES`、`HITCH_HARBOR_PYTHON_RUNTIME_TIMEOUT_MS`；配置改变后重新准备绑定。超时不等于内容不一致，会返回 `harbor_python_runtime_timeout`；取消会终止正在执行的扫描子进程。启动脚本须使用绝对 Python shebang，非空模块路径须为绝对路径；无法核对时拒绝绑定。

`eval bind --timeout DURATION` 控制客户端等待完整绑定准备的期限，默认 `30m`；它与 `--minimum-validity` 所要求的凭据剩余有效期不同。客户端断开会取消服务器端准备。配置长时间扫描时应同时为客户端与 daemon 留出相应预算，且毫秒数不得超过 Node 定时器支持的 `2147483647`。

`evaluation_preparation: "1"` 能力表示支持可配置的绑定等待和长准备请求。新 CLI 在绑定与评估提交时使用 `Accept: application/vnd.hitch.preparation+ndjson`；服务器立即发送响应头及进度心跳，避免 HTTP 默认 headers/body 空闲超时先于准备期限到期。CLI 最终仍输出原有 JSON 对象，结构化错误保留错误码和退出码。未请求该媒体类型的客户端仍接收原 JSON 响应。绑定准备随客户端断开而取消；持久化评估提交保持原语义，丢失响应后须用原 control 或幂等键恢复，不能据此重建新任务。

模块搜索路径或已加载模块指向 ZIP 内部目录时，会绑定所属归档的内容。`DOCKER_CONFIG` 为空字符串时，按 Docker 的规则检查 `$HOME/.docker/config.json`。

正常生成的 `__pycache__` 不改变身份，但会验证当前解释器的缓存代码与源码编译结果一致。浮点及复数常量按位比较，因此合法的 NaN 缓存可通过，同时保留正负零的区别；嵌套代码和集合常量也参与校验。孤立或其他解释器的带标签缓存不参与模块加载；可加载的独立 `.pyc` 按字节绑定。外置 `sys.pycache_prefix` 缓存目录不在支持范围，明确拒绝。源码和缓存不一致、缺失输入或超限均拒绝。该检查程序进入 npm 包及不可变 controller runtime。准入和每次 Harbor 调用前重新读取相同范围；改变依赖后应创建新运行。

驻留执行进程最多记住最近 8 份成功的字节码校验证明。每次仍完整读取并哈希受检文件，检查目录变化和预算；只有解释器、依赖、校验程序、源码与派生字节码内容全部相同时，才省去重复编译和代码对象比较。证明只在进程内存中保留，不从磁盘加载，不以路径、mtime 或包版本代替内容校验。新增或改变字节码会重新验证；进程重启后的首次校验仍走完整路径。公开绑定格式与运行时内容身份的定义保持不变。

提交时使用 `hitch eval submit ... --environment-binding <binding_id>`（亦适用于 ordered control 的 request 字段）。仅支持 local-docker、外部模型、capture off/native 的有限时评估；timeout 必须大于零，timeout 与 setup timeout 之和为整数且不超过 24 小时。新准入和 Harbor 启动前都验证绑定。已接受的幂等请求仍返回原 eval，不因后续环境变化重新执行；取消也不要求重新准备绑定。恢复保留原 ID。

准入和启动前所需的凭据有效期均包含任务、setup 预算及 Harbor 私有 helper 的 5 分钟余量。凭据有效期不是任务执行期限，可以超过 24 小时；有效期不足时在启动 Harbor 前拒绝，且不会刷新被冻结的凭据。

v3 检查以下主机文件引用；未设置或空值不作为显式引用：

- `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、`NODE_EXTRA_CA_CERTS`、`AWS_CA_BUNDLE`。
- `AWS_CONFIG_FILE`、`AWS_SHARED_CREDENTIALS_FILE`、`AWS_WEB_IDENTITY_TOKEN_FILE`、`GOOGLE_APPLICATION_CREDENTIALS`、`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`、`BOTO_CONFIG`、`NETRC`。
- `SSL_CERT_DIR` 的目录树；`DOCKER_CERT_PATH` 下的 `ca.pem`、`cert.pem`、`key.pem`；`DOCKER_CONFIG/config.json`。
- 提供绝对 `HOME` 时，未被对应显式变量替代的 `.netrc`、`.aws/config`、`.aws/credentials`、`.config/gcloud/application_default_credentials.json`；未设置 `DOCKER_CONFIG` 时的 `.docker/config.json`。

其他文件变量可通过 `HITCH_EVALUATION_FILE_ENV_JSON='["MY_PROVIDER_CONFIG"]'` 声明，最多 128 个变量名。显式引用必须是存在的绝对普通文件路径；上述默认文件允许缺失，其后出现也会改变绑定。目录或文件的内容、模式及符号链接目标纳入私有 HMAC，仅时间戳变化不改变身份。不持久化清单、文件路径、内容或普通文件摘要。文件清单限 4096 项、目录深度 32、单文件 16 MiB、累计 64 MiB；循环链接、特殊文件、超限或读取期间变化均拒绝并返回脱敏错误。

helper 输出保存于 root 下 `evaluation-bindings/` 的私有记录中（目录 0700、文件 0600）；不是公开回执，也不进入任务配置。执行阶段通过不可变 controller runtime 内的 host helper 读取该记录，沿用私有凭据通道；不再次调用上游 helper、不刷新凭据。Python 和文件检查使用主机进程实际收到的空占位值，Target 的 helper 值不解释为主机文件路径。记录、密钥丢失、MAC 不符、源环境改变或剩余有效期不足均拒绝。需要新条件时必须显式准备新绑定。

本协议绑定上述实际文件范围，不自动发现未声明的自定义文件、未列出的 SDK 默认路径、动态加载的范围外资源、所有系统共享库或网络服务行为。它也不把可变主机变成只读快照；运行期间应保持依赖环境不变。helper 脚本变更不会改变已冻结结果；新 prepare 的结果由重新调用 helper 决定。不要把此能力描述为完整可重复执行证明。

artifact 执行前 pin 由独立的 `evaluation_artifact_pins: "1"` 能力提供，可以与本协议一起使用，见[产物约束协议](evaluation-artifact-pins.zh-CN.md)。
