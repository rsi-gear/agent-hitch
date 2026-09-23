# 查看运行与证据

先确认运行结果，再按问题查看相关证据。把下面的 `RUN_ID`、`MESSAGE_ID` 和 `CURSOR` 替换为 Hitch 返回的实际值。

## 找到运行

```bash
hitch runs list --json
hitch runs inspect RUN_ID --json
```

Inspect 返回保存的运行和轨迹校验状态。比较运行前，先确认状态、请求及解析后的 Harness、模型身份、工作区和结果。即使 Harness 版本相同，模型或起始工作区不同也可能造成结果差异。

默认记录位于 `~/.hitch/runs/RUN_ID/`。如果使用过 `--root` 或 `HITCH_ROOT`，查询时要使用同一状态目录。

比较本地与远程模型时，还需核对 Checkpoint、推理运行时和节点身份，见[保存模型证据](model-inference.md#保存模型证据)。

## 读取有界轨迹

```bash
hitch trajectory project RUN_ID --profile analysis --json
hitch trajectory events RUN_ID \
  --types tool/call,tool/result \
  --limit 50 \
  --json
```

`project` 生成有界分析视图。`events` 在源端过滤，返回包含 `next_cursor` 和 `eof` 的一页结果。下一页传入原样保留的 cursor：

```bash
hitch trajectory events RUN_ID --cursor CURSOR --limit 50 --json
```

Cursor 保留筛选条件，应作为不透明值使用。通过 `--field` 钻取字段时，还必须提供精确序号范围，以及前一次有界视图返回的 `canonical_sha256`，避免读取不同底层轨迹中的字段。

`hitch trajectory inspect RUN_ID --json` 会读取完整轨迹，适合明确的审计或小记录；自动化优先使用有界命令。不同 Harness 的采集保真度不同。启动过早失败可能没有轨迹，没有固定 canonical checksum 的旧引用也不能使用有界视图。

DSH 采集支持 Session v0–v4，包括 DSH 0.1.5-rc.3（v3）和 0.1.7-rc.1（v4）。分析视图包含内嵌 Assistant 流、System/Developer 消息和 Tool 角色结果。会话中存在图片卸载操作时，消息表面覆盖度标为 partial，原始事件仍可查询。

## 查看评测证据

```bash
hitch verifier inspect RUN_ID --json
```

对于评测 Trial，这会展示 observation、分数通道和可用的有界 Verifier 诊断。普通本地运行可能没有 Verifier 结果。

新 Run 会保留每个不超过 16 MiB 硬上限的完整脱敏诊断。Inspector 最多返回
64 KiB 预览；较大的制品可以按摘要校验后的 UTF-8 字节分页读取：

```bash
hitch verifier artifact RUN_ID test-stdout.txt \
  --offset 0 \
  --limit 65536 \
  --sha256 SHA256 \
  --json
```

使用返回的 `next_offset` 读取下一页。`source_complete: false` 和
`loss_reason` 可以区分过大或无效的来源与普通的有界预览。

| Verifier 状态 | 含义 |
| --- | --- |
| `complete` | 存在结构化结果，以及至少一份支持的测试或日志制品。 |
| `result_only` | 有结构化结果，但未保留这些测试或日志制品。 |
| `missing` | 运行没有引用结构化 Verifier 结果。 |
| `corrupt` | 身份、引用、JSON 或 checksum 校验失败。 |

有效零分表示任务得了零分；无效 observation 表示分数不可信，不能记为零分。详见[评测结果](evaluations.md)和 [Verifier 约定](../../verifier-evidence.md)。

对于 schema version 1 诊断索引中只保留截断片段的旧 Run，如果仍有且仅有一份
已知本地 Harbor 来源，`hitch verifier repair RUN_ID --json` 可以恢复完整制品。
修复会写入摘要绑定的派生补充记录，不会改变封存 Run、observation 或分数。仅当
自动选择存在歧义时，才用 `--source` 指定准确的评测相对 Harbor Trial 路径。
修复会拒绝不匹配的来源摘要和旧版凭据值脱敏记录。

## 添加反馈

从轨迹选择实际消息 ID 后添加反馈：

```bash
hitch feedback put RUN_ID \
  --message MESSAGE_ID \
  --rating positive \
  --note "答案找到了正确的测试命令"
hitch feedback list RUN_ID --json
```

反馈独立于轨迹保存，并带有版本。修改反馈不会改写采集的对话。并发编辑可以通过 `--if-version` 拒绝基于旧版本的写入。

## 使用机器接口

查询命令通常使用 `--json`。执行命令使用 `--output json` 获取最终结果，或 `--output jsonl` 获取事件。以 `--json` 调用的命令失败时，从 stderr 读取稳定的 JSON 错误 envelope，并检查退出码。[Schemas](../../schemas) 描述了版本化格式。

下一步[运行一次小规模评测](evaluations.md)。
