# Hitch × Terminal-Bench P0 故障修复 Spec

- 状态：Implemented（本地验证、真实 DSH 精确 prompt canary 及 Terminal-Bench 链路 canary 完成）
- 日期：2026-08-27
- 适用基线：`agent-hitch@0.2.4`，仓库 HEAD `ffcd80fe1174e9d32609555786a5b20cd9efc55a`
- 输入证据：`hitch-terminal-bench-failure-report-2026-08-27.md`

## 1. 背景与当前代码确认

Terminal-Bench 30-task baseline 中有两个已确认的 Hitch 确定性故障：

1. DeepSeek adapter 将 prompt 直接作为 positional argv 传给 DSH。prompt 以 `-` 开头时，会被 DSH/Commander 解释为选项。
2. Harbor bridge 通过无 `pipefail` 的 `cat | tee` 读取 Hitch `result.json`，并直接对非空 stdout 调用 `json.loads()`。缺失、空白、非法或不完整 result 会产生二次异常，掩盖原始执行失败。

报告针对 `agent-hitch@0.2.0`。实施前在 `0.2.4` 源码中确认两处问题仍然存在：

- `src/adapters/providers/deepseek.ts` 的 `deepseekAdapter.process()` 仍执行 `args.push(request.prompt)`，前面没有 `--`。
- `integrations/harbor/hitch_harbor_agent.py` 的 `HitchHarborAgent.run()` 仍执行 `cat <result> | tee ...`，并在 truthy stdout 上直接调用 `json.loads()`。

当前版本已经提供 invalid trial 定向 rerun，并具备 DeepSeek timeout native-session 处理。本 spec 不重复设计这些能力。

## 2. 目标

本修复必须满足以下目标：

1. 任意合法 prompt，包括 option-like 和多行文本，都只能作为一个 DSH task positional argument，不能改变 DSH 或 adapter 选项解析。
2. Harbor bridge 必须可靠区分 Hitch result 的 missing、empty、malformed 和 schema-invalid 状态。
3. 读取或解析 result 的失败不得裸抛 `JSONDecodeError`，也不得覆盖更早的 Hitch 进程失败。
4. 每个 bridge infrastructure failure 必须留下稳定错误码和有界诊断证据，供人和上层程序归因。
5. 修复不得改变正常 run、reward、observation validity 或 Gear fail-closed 语义。

## 3. 非目标

以下事项不属于本次 P0：

- 提高长任务的 900 秒 agent budget，或把预算耗尽重新归因为 Hitch bug。
- 修复 `filter-js-from-html` verifier 的公网依赖和 1800 秒 timeout。
- 实现 Gear 的 per-cell recovery policy。
- 改变 Harbor outer timeout 或 Hitch inner timeout 的默认值。
- 为 DSH 新增其当前未正式支持的 `--prompt-file` 或 stdin 协议。
- 要求 30-task baseline 的 reward 提升；本修复只保证执行和故障证据的正确性。

## 4. P0-A：DeepSeek prompt argv 边界

### 4.1 行为合同

`deepseekAdapter.process()` 生成的 argv 必须符合：

```text
dsh --profile headless <agent_args...> --patch <runtime-patch> <transport-task>
```

其中：

- `<transport-task>` 必须是单个 argv 元素；不得按空格、换行或 shell token 再拆分。
- 普通 prompt 按原字节传递；仅当 prompt 首字符为 `-` 时，argv 传输值在前面增加一个换行，使 DSH launcher 把它识别为 positional task，而不是选项。
- 对 option-like prompt，runtime patch 必须用 Hitch startup provider 替换 DSH 默认 `headless-startup`，在生成 `headlessStartup.task` 前校验并删除且仅删除上述一个换行。最终首条 DSH `user/message` 必须与原始 `request.prompt` 字节一致。
- `--profile`、用户 `agent_args` 和 Hitch runtime patch 的既有顺序保持不变。
- `input` 继续为 `""`，`DSH_HOME` 行为不变。

### 4.2 代码改动

修改 `src/adapters/providers/deepseek.ts`：

```ts
args.push("--patch", patchFile);
const task = request.prompt.startsWith("-") ? `\n${request.prompt}` : request.prompt;
args.push(task);
```

真实 DSH 对 argv 执行 launcher 与 headless app 两层 Commander 解析，launcher 会消费标准 `--`，因此单个 terminator 无法保护第二层；双 terminator 又把嵌套 parser 的内部约定泄漏到 adapter。本实现只在 transport 层使用前导换行，并让定向 startup provider 在 DSH 内恢复原文。startup provider 对缺失的转义标记 fail closed，不能静默删除用户原有内容。若 DSH 未来提供稳定的 prompt-file/stdin contract，应另立变更迁移。

### 4.3 测试要求

在 `test/adapters.test.ts` 增加 table-driven 回归测试，至少覆盖：

| prompt | 预期 |
| --- | --- |
| `normal task` | 原样作为唯一 positional task |
| `- starts with a dash` | argv 为 `\n- starts with a dash`；DSH user message 恢复为原文 |
| `--help` | argv 为 `\n--help`，不得触发 help；DSH user message 恢复为原文 |
| `--patch attacker-controlled-value` | transport 增加一个前导换行，不得改变 runtime patch；DSH user message 恢复为原文 |
| `multi-line\ntask` | 保持一个 argv 元素及原始换行 |
| 空字符串 | 仍保留一个空 positional 元素 |

断言必须验证完整 argv 尾部为：

```ts
["--patch", patchFile, prompt.startsWith("-") ? `\n${prompt}` : prompt]
```

在 `test/engine.test.ts` 增加至少一个进程级 fixture：fake DSH 模拟 launcher 与 startup overlay，记录实际 `process.argv` 并生成 native session。以 `- starts with a dash` 执行一次完整 Hitch run，断言 argv 最后一个元素为 `\n- starts with a dash`、argv 不含 `--`，同时 native session 首条 `user/message` 严格等于原 prompt。该测试同时防止 spawn 拆词和 transport escape 泄漏到模型上下文。

## 5. P0-B：Harbor result 读取与错误保真

### 5.1 总体流程

`HitchHarborAgent.run()` 必须按以下阶段处理，阶段顺序不可颠倒：

1. 执行 Hitch process，保留 `return_code`、stdout、stderr。
2. 从 stdout 中解析 Hitch events，记录 assigned run id、observed run id 和最后一个合法 event。
3. 不经 pipeline 读取预期 `result.json`，并将原始文件单独复制为 Harbor log artifact。
4. 无论 result 是否可解析，都先 best-effort 导出已有 run bundle 证据；导出事务自身失败时保留独立诊断。
5. 对读取结果执行 trim、JSON parse 和最小 schema 校验。
6. 先写 `context.metadata` 和 bridge error artifact，再抛出类型化 bridge exception。
7. 只有在 process、result、identity 和 bundle 均通过检查时正常返回。

关键约束：解析失败不能中断证据导出；诊断阶段产生的新错误不能覆盖更早的进程错误。

### 5.2 禁止使用读取 pipeline

删除以下模式：

```python
cat <result-path> | tee /logs/agent/hitch-result.json
```

result 读取必须是一个能反映 `cat` 自身退出码的独立命令。推荐形式：

```sh
if [ ! -e "$result_path" ]; then exit 44; fi
if [ ! -f "$result_path" ]; then exit 45; fi
cat -- "$result_path"
```

原始 result artifact 的复制必须是第二个、独立且 best-effort 的操作：

```sh
if [ -f "$result_path" ]; then
  cp -- "$result_path" /logs/agent/hitch-result.json
fi
```

不得以 copy/tee 的成功退出码替代 read 的退出码，也不得因为复制 artifact 失败而把已经获得的 Hitch process failure 改写成复制失败。

### 5.3 解析与最小 schema 校验

读取逻辑必须先 trim：

```python
payload = (result.stdout or "").strip()
```

结果分类如下：

| 条件 | error code |
| --- | --- |
| read 返回“路径不存在” | `hitch_result_missing` |
| 路径存在但不是普通文件 | `hitch_result_not_file` |
| read 因权限、I/O 或其他原因失败 | `hitch_result_read_failed` |
| read 成功但 trim 后为空 | `hitch_result_empty` |
| `json.loads()` 失败 | `hitch_result_invalid_json` |
| JSON 不是 object 或缺少/错配必要字段 | `hitch_result_schema_invalid` |
| result `run_id` 与本 trial 的 run id 不同 | `hitch_result_run_id_mismatch` |
| result `revision_identity` 与 job pin 不同 | `hitch_revision_identity_mismatch` |

bridge 不新增第三方 JSON Schema 运行时依赖。它必须手工验证 `docs/schemas/result.schema.json` 中本集成依赖的最小字段：

- `schema_version == "1"`
- `run_id` 符合 `^run_[a-f0-9]{32}$` 且等于本 trial run id
- `status` 属于 `succeeded | failed | timed_out | cancelled`
- `exit_code` 是非负整数；Python `bool` 不得被当作整数接受
- `completed_at` 是非空字符串
- `error` 存在时必须是 object，且 `code`、`message` 为字符串

已有 `revision_identity` pin 校验继续保留，但使用稳定错误码报告。

### 5.4 原始错误优先级

当同一 trial 同时存在多个问题时，primary error 按以下顺序确定：

1. Hitch process 非零退出或 signal；
2. result read/parse/schema/identity 错误；
3. run bundle export 错误；
4. Harbor log artifact copy 错误。

定义一个 bridge 内部异常类型 `HitchBridgeError(RuntimeError)`，至少携带只读的 `code` 和 evidence payload。Harbor 最终看到的异常字符串仍必须使用下述稳定格式，机器读取以 error artifact 和 metadata 为准，不依赖 traceback 文本。

若 Hitch process 非零退出，primary code 必须是 `hitch_process_failed`。result 缺失或损坏只能作为 `result_diagnostic` 附加，不能替换原进程的 return code、signal 或 stderr。

若 Hitch process 成功而 result 缺失或损坏，则对应的 `hitch_result_*` code 为 primary。

异常 message 必须稳定、简短，并以错误码开头，例如：

```text
hitch_result_invalid_json: Hitch result is not valid JSON (run_id=run_..., trial_id=...)
```

禁止向 Harbor 裸传播 `JSONDecodeError`、shell traceback 或无界 stdout/stderr。

### 5.5 Bridge error artifact

任一 bridge infrastructure failure 都必须写入：

```text
/logs/agent/hitch-bridge-error.json
```

schema version 1：

```json
{
  "schema_version": "1",
  "code": "hitch_result_missing",
  "message": "Hitch result file is missing",
  "recorded_at": "2026-08-27T00:00:00.000000+00:00",
  "eval_id": "eval_...",
  "trial_id": "task__suffix",
  "task_id": "task",
  "attempt": 1,
  "assigned_run_id": "run_...",
  "observed_run_id": null,
  "result_path": "/tmp/hitch-state/runs/run_.../result.json",
  "process": {
    "return_code": 1,
    "signal": null,
    "stdout_tail": "...",
    "stderr_tail": "..."
  },
  "result_read": {
    "return_code": 44,
    "stdout_tail": "",
    "stderr_tail": "..."
  },
  "last_event": null,
  "result_diagnostic": "hitch_result_missing"
}
```

要求：

- `process.stdout_tail`、`process.stderr_tail`、read stdout/stderr 每项最多保留末尾 8192 个 UTF-8 字节，并在截断时显式标记。
- Harbor `ExecResult` 不提供 signal 时写 `null`，不得推测 signal。
- `last_event` 只保留最后一个成功解析的 JSON object；其序列化结果同样限制为 8192 字节。超限时至少保留 `type`、`run_id` 和 `truncated: true`。
- 不把 instruction/prompt 作为独立字段复制进该 artifact。
- JSON 使用确定性字段名；可新增字段，但不得改变既有字段含义。
- Harbor job 已通过 `include_logs: ["hitch-*"]` 收集该文件，不需要修改 artifact glob。

同时在 `context.metadata` 中加入：

```json
{
  "hitch_bridge_error_code": "hitch_result_missing",
  "hitch_bridge_error_artifact": "hitch-bridge-error.json"
}
```

正常 run 不写这两个字段，也不生成 error artifact。

### 5.6 Run bundle 证据

若 run directory 存在，即使 `result.json` 缺失、为空或损坏，也必须尝试导出以下已存在文件：

```text
request.json
resolution.json
manifest.json
result.json
events.jsonl
stdout.log
stderr.log
trajectory.ref.json
trajectory/
```

`bundle.complete.json` 只表示 bridge 的 staging/copy 事务完整完成，不表示 Hitch run 成功或 result 合法。

若 bundle export 失败：

- 写入 error artifact 的 `bundle_export` 诊断；
- 仅在没有更早的 process/result 错误时使用 primary code `hitch_run_bundle_export_failed`；
- 不删除已经复制到 `/logs/agent` 的 `hitch-events.jsonl`、`hitch-stderr.log` 或原始 result。

### 5.7 Harbor-to-Hitch 导入

本 P0 不改变 `RunObservationV1.invalid_reason` 的现有粗粒度值；bridge 故障仍对应：

```text
observation.status = invalid
observation.invalid_reason = infrastructure_failure
```

但当 trial 没有可导入的 run bundle 时，`src/evals/trial-import.ts` 创建 diagnostic run 前必须查找 trial agent 目录中的 `hitch-bridge-error.json`：

- 合法 artifact 复制到 diagnostic run 的 `diagnostics/harbor-bridge-error.json`；
- diagnostic `result.json.error.code` 使用 bridge 的稳定 code；
- diagnostic `result.json.error.message` 使用 bridge message；
- artifact 缺失或非法时保持现有 `infrastructure_failure` fallback；
- 不信任 artifact 中的 run identity 覆盖 eval/trial lock 得到的权威 identity。

该 artifact 按不可信输入处理：导入前限制为 64 KiB，要求 `schema_version == "1"`，code 必须属于本 spec 定义的 `hitch_*` allowlist，message 最多 2048 个 UTF-8 字节，且仅在 Harbor trial 已有 exception 时用于细化 diagnostic result。校验失败只能触发安全 fallback，不能使 eval import 再次失败。

这样不破坏现有 observation contract，同时 Gear 或其他调用方可通过 trial `run_id` 获取细粒度 root cause。

## 6. 测试矩阵

### 6.1 Python bridge 行为测试

扩展 `test-support/bridge_smoke.py`，使 fake environment 可注入 Hitch process 和 result read 场景。至少覆盖：

| Case | Process | Result | 预期 primary code |
| --- | --- | --- | --- |
| valid | 0 | 合法 JSON | 正常返回 |
| missing | 0 | read 44 | `hitch_result_missing` |
| not-file | 0 | read 45 | `hitch_result_not_file` |
| read failure | 0 | 其他非零 read code | `hitch_result_read_failed` |
| zero-byte | 0 | `""` | `hitch_result_empty` |
| whitespace | 0 | `" \n"` | `hitch_result_empty` |
| truncated JSON | 0 | `{"status":` | `hitch_result_invalid_json` |
| non-object JSON | 0 | `[]` | `hitch_result_schema_invalid` |
| incomplete schema | 0 | 缺少必要字段 | `hitch_result_schema_invalid` |
| run-id mismatch | 0 | 其他 run id | `hitch_result_run_id_mismatch` |
| process failure + missing | 1 | read 44 | `hitch_process_failed`，并附 `hitch_result_missing` |
| `cat` fail / old `tee` success trap | 0（旧 pipeline） | 空 | 新实现必须检测为 missing；读取命令不得含 `| tee` |

每个失败 case 还必须断言：

- exception 字符串不包含裸 `JSONDecodeError`；
- context metadata 含正确 code；
- error artifact payload 含 eval/trial/run/process/read evidence；
- stderr 超长输入被截断；
- 能导出的 run bundle 在抛异常前已尝试导出。

### 6.2 TypeScript 导入测试

在 `test/evals.test.ts` 增加 diagnostic import case：构造一个带 Harbor exception、没有可导入 bundle、但存在合法 `hitch-bridge-error.json` 的 trial，断言：

- observation 仍是 `invalid / infrastructure_failure`；
- diagnostic run 的 `result.json.error.code` 为 bridge code；
- `diagnostics/harbor-bridge-error.json` 被保留；
- artifact 中伪造的 eval/trial/run identity 不会覆盖权威 identity。

另加非法 bridge artifact case，断言安全回退为 `infrastructure_failure`，且导入流程本身不失败。

### 6.3 必跑检查

```sh
npm run check
```

不得只运行新增测试；该改动触及 adapter argv、Harbor bridge 和 eval trial import，必须通过完整 typecheck、build、architecture、syntax 和 test suite。

## 7. 定向集成验收

在具备 Terminal-Bench/Harbor/DSH 环境时，依次运行：

1. `pytorch-model-recovery`：确认以 `-` 开头的 instruction 进入 DSH，且不出现 `unknown option`。
2. `prove-plus-comm`：无论底层成功或失败，都不得出现裸 `JSONDecodeError`；失败时必须得到真实 process root cause 和 `hitch-bridge-error.json`。
3. 故意制造的 timeout fixture：确认 timeout 仍归类为 timeout/infrastructure failure，且本补丁没有改变 inner/outer timeout 语义。

定向验收通过后可重跑 30-task baseline。通过标准为：

- 合法 prompt 形状不会使 adapter 启动失败；
- result 缺失或损坏不会掩盖原始错误；
- 每个 bridge invalid observation 都有稳定错误码和有界证据；
- 正常 trial 的 result、trajectory、reward 和 observation 与修复前兼容。

不以所有 task 高 reward 或全部在 900 秒内完成作为本补丁通过条件。

## 8. 兼容性、发布与回滚

- 该修复是 patch-level bug fix，不修改公开 CLI 参数或现有 JSON schema version。
- DeepSeek 对 option-like prompt 使用临时 argv 转义，并在 DSH startup provider 内恢复原文；普通 prompt 不变。发布前必须用当前支持的 DSH 精确版本至少做一次 native-session canary。
- Bridge error metadata 和 diagnostic artifact 均为 additive；旧调用方可忽略。
- `invalid_reason` 保持 `infrastructure_failure`，避免破坏 Gear 当前 fail-closed contract。
- 如受支持的真实 DSH 版本不接受 startup overlay，只回滚 P0-A，并在 DSH 正式提供 prompt-file/stdin 前锁定受影响版本；不得回滚 P0-B 的错误保真修复。

## 9. 完成定义

以下条件全部满足才可关闭本修复：

- P0-A 和 P0-B 的代码改动完成；
- 本 spec 中全部单元/行为测试通过；
- `npm run check` 通过；
- 两个报告复现任务完成定向验证，或因外部环境不可用而记录明确的未执行原因；
- release note 明确说明“修复 option-like DeepSeek prompt”和“Harbor result failure diagnostics”，不宣称解决 agent/verifier timeout。

## 10. 实施记录

已完成：

- DeepSeek adapter 仅在 argv transport 中为 option-like prompt 增加前导换行，并通过定向 DSH startup provider 在首条 user message 前恢复原文；adapter、生成 plugin、process argv 与 native session 均有回归断言。
- Harbor bridge 使用独立 result read/copy 命令，完成 missing、not-file、read-failed、empty、invalid JSON、schema invalid、run-id mismatch 分类。
- Harbor bridge 保留进程错误优先级，输出有界 `hitch-bridge-error.json` 和 metadata。
- diagnostic run 安全导入 allowlist 内的 bridge error，保持 observation `infrastructure_failure` 兼容语义。
- `npm run check` 通过：architecture check 及 161 个测试全部成功。

定向 canary：

- `pytorch-model-recovery` 使用 Harbor 0.21.0、DSH 0.1.1-rc.2 和 `deepseek-v4-flash` 实跑；eval `eval_4b5b1a3901c944ef810e3244f917cd8e` 得到 valid observation、0 个 exception，未再出现 `unknown option`。该次 canary 也发现 transport 换行进入 user message，随后增加 startup 原文恢复层。reward 为 0，原因是 DSH task sandbox 无可用 backend，属于 agent/task 执行环境，不是 argv 或 Harbor bridge 故障。
- 最终实现用真实 DSH 0.1.1-rc.2 执行 run `run_5359249f35a847d1a7c27b738b53168d`：argv 输入为 option-like prompt，run succeeded；provider-native session 首条 user message 精确为 `- Reply with exactly: HITCH_DSH_PROMPT_OK`，无前导换行，模型返回 `HITCH_DSH_PROMPT_OK`。
- `prove-plus-comm` 首次 smoke 在 agent 启动前发现本地派生镜像工作目录为 `/workspace`、缺少 `/app`；bridge 正确保留 `return_code=126` 与 `chdir /app failed`，且未出现裸 `JSONDecodeError`。该任务未用于 reward 验收。
- 未运行 30-task baseline；本 P0 仅执行上述关键定向样本。
