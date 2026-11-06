# Sealed Python 执行接口

`sealed_source_execution: "1"` 表示 Hitch 支持固定的 `sealed-python` adapter。它用于执行 Gear 已封存的 Python solution，最终训练和审计不创建模型会话。

```sh
hitch --root /absolute/hitch-state eval run \
  --dataset /absolute/sealed-analysis-task \
  --harness sealed-python@git+file:///absolute/clean-hitch-source#EXACT_COMMIT \
  --no-model --attempts 1 --infrastructure-retries 0 --output json
```

CLI 将 `--no-model` 表示为 eval request `schema_version: "2", model: null`；内部兼容存储使用空 model 字符串。v2 仅用于 sealed-python。旧模型 adapter 保持 v1 行为，不允许借此绕过模型参数。固定执行器拒绝 model、endpoint、凭据传递、agent 参数、generation override、多次 attempt 和自动重试。源码入口必须与当前 Hitch 认证的固定 runner 一致，其 worker/confinement 文件由随入口封存的 digest 清单认证。

普通资源 producer 位于 `benchmark-packages/kaggle/analysis.mjs`，接收四种严格 request：单实验、C5 交付、事后方案审计、完整数据 refit。正式 Schema 和 golden fixture 位于 `analysis-contracts/`，与 Gear 示例一致。训练列名和合法标签来自 task contract，不硬编码 Titanic 字段。

candidate 与 verifier 使用不同资源树、容器和文件系统。固定执行器通过绑定 request/solution/runtime 的 receipt 输出预测文件摘要、实际 run ID、CPU 用量和 `modelRequests: 0`；独立 verifier 按 ID 对齐 CSV 并计分。生成代码无法访问 verifier 标签、宿主、凭据或网络。无效预测属于已确认的候选失败；缺少可信 receipt、采集或 verifier 失败保持不可用。

新增 `bounded-tmpfs@1` 资源能力允许有限大小的容器内 tmpfs，不开放宿主 volume。Linux 单 main-service、静态 no-network 的 Compose 可以使用 Docker `network_mode: none`；实际启动后检查网络命名空间和端口绑定，计划中的服务拓扑必须一致。多服务、动态策略和额外 Compose 设置保留原有更严格的 admission 路径。

仍使用现有 `eval inspect/cancel/rerun`、`verifier inspect`、`runs artifacts list/export` 和输出 manifest 协议。Gear 通过这些公共接口认证每个子 run 与产物，不依赖 Hitch 私有存储布局。改动执行条件需要新冻结身份；恢复不能把有效低分改成一次新抽样。
