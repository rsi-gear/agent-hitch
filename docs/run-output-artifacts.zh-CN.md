# 通用运行产物（run-output-artifacts@1）

`hitch capabilities --json` 的 `run_output_artifacts: "1"` 表示支持第一版产物协议；`run_output_artifact_backends: ["local-docker"]` 表示当前已实现本地 Harbor 采集。首版面向 direct 执行。远程执行不会回退读取控制面中的私有 verifier 文件。

```sh
hitch --root /absolute/hitch-root runs artifacts list RUN_ID --json
hitch --root /absolute/hitch-root runs artifacts export RUN_ID \
  --manifest-digest sha256:MANIFEST_DIGEST --out /absolute/new-directory --json
```

`list` 返回 `schema_version: "1"`、`kind: "run-output-artifacts"`，并绑定 `run_id`、`eval_id`、`task_id`、`attempt`、精确的 `harness_commit` 和已编译的 `task_digest`。`entries` 的 `name`/`path` 是声明产物在 Harbor 采集目录内的相对路径；每项包含 `media_type`、`bytes`、`sha256`。`digest` 是去除自身字段后、按键排序的规范 JSON 的 SHA-256（`sha256:` 前缀）。跨仓库样例见 `test-contracts/run-output-artifacts-v1.json`。

运行导入器从已验证的不可变 task.toml 读取 artifacts 声明，重新计算采集字节的摘要，在发布终态 run 之前封存并纳入 bundle index。候选提供的同名 manifest 不受信任；未声明文件、verifier 标签和私有诊断不进入此命名空间。显式 destination 按 Harbor 相对目标路径解释；没有 destination 时，`/output/predictions.csv` 变为 `output/predictions.csv`。规范路径不接受符号链接、硬链接、特殊文件、重名或目录穿越。

单文件上限 16 MiB，总计 64 MiB，最多 10,000 个文件。超过预算会记录不可用原因，不会截断。产物采集失败不会改写已完成试验的有效评分；产物 API 会报告独立错误。没有生成声明文件的任务可以有空清单。

`export` 要求目标目录不存在，或已包含同一完整清单和相同字节。实现使用目标锁、临时目录、重新校验和原子发布；不同既有内容不覆盖。返回：

```json
{"schema_version":"1","kind":"run-output-artifacts-export","run_id":"run_...","manifest_digest":"sha256:...","destination":"/canonical/absolute/new-directory"}
```

目标路径会规范化其父目录。导出的 `hitch-output-manifest.json` 是完整清单，其他文件按清单路径排列。调用者应同时检查期望的 run、eval、commit、task digest 和 attempt。读取和导出不会重新调用 Agent 或 verifier。

产物属于 durable run bundle，不依赖活动 workspace 或 Harbor trial 目录，进入 run 的既有保留范围。导出锁协调并发导出；当前没有单独清理这些 run 文件的资源 GC。任务进程清理仍由执行后端负责；本接口封存的是已采集的主机快照。

不存在的 run、未封存的 run、无可用产物、版本不符、损坏/不安全文件、超出预算、不同目标内容分别使用 `output_artifacts_run_not_found`、`output_artifacts_not_sealed`、`output_artifacts_unavailable`、`output_artifacts_version_mismatch`、`output_artifacts_corrupt`、`output_artifacts_too_large`、`output_artifacts_destination_exists`。历史 run、非 commit harness 和未实现的远程后端不补猜产物来源。
