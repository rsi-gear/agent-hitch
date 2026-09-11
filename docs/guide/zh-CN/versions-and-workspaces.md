# 固定版本与隔离工作区

Harness 程序和工作区需要分别选择。固定程序版本，并不意味着工作目录的内容也被固定。

## 选择 Harness 引用

| 引用 | 使用场景 |
| --- | --- |
| `codex@installed` | 对本机现有可执行程序生成指纹并运行。 |
| `codex@version:0.92.0` | 在 Hitch 缓存中准备并运行确定的已发布软件包版本。 |
| `codex@commit:COMMIT` | 从已注册的上游仓库构建确定提交，把 `COMMIT` 换成实际提交。 |

使用 `hitch inspect HARNESS --json` 查看适配器。构建源码提交还需要对应 Harness 的构建工具链；软件包版本更适合初次使用。

| Harness | 已安装版本 | 软件包版本 | 源码提交 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 不支持 |
| Pi | 支持 | 支持 | 支持 |
| OpenCode | 支持 | 支持 | 不支持 |
| DeepSeek Harness | 支持 | 支持 | 支持 |

可以只解析身份而不启动智能体，或提前准备可执行文件：

```bash
hitch resolve codex@version:0.92.0 --json
hitch prepare codex@version:0.92.0 --json
```

随实验保留解析后的身份和制品引用。`@installed` 适合本地使用，但不能作为可移植的评测引用。Harbor 评测要求不可变的软件包版本或提交。

## 选择工作区模式

| 模式 | 起始文件 | 注意事项 |
| --- | --- | --- |
| `shared` | 原始目录 | 默认模式。修改直接影响原目录，并发写入没有隔离。 |
| `worktree` | 从干净 Git HEAD 创建的 detached worktree | 要求仓库干净，包括未跟踪文件。不会复制 ignored 文件。 |
| `copy` | 当前文件系统快照 | 包含未提交、未跟踪及 ignored 文件，支持非 Git 目录；拒绝链接式嵌套 Git 工作区和已初始化的 submodule。 |

```bash
hitch run \
  --harness codex@version:0.92.0 \
  --cwd /absolute/path/to/project \
  --workspace-mode copy \
  --prompt "总结当前修改" \
  --timeout 5m
```

运行前替换路径。Hitch 创建快照时应避免其他进程继续写入源码，复制期间的变更可能使准备失败。Hitch 状态目录应放在源码目录之外。

工作区隔离只控制传给智能体的工作目录，不是操作系统沙箱：绝对路径、网络和共享 Git 元数据仍可能可访问。需要这些边界时，应使用合适的容器或操作系统沙箱。

## 检查与删除工作区

```bash
hitch workspace inspect RUN_ID --json
hitch workspace path RUN_ID
```

打开返回的目录检查变更，清理前保存需要的结果。成功、失败、取消和超时后，Hitch 都会保留托管工作区。

```bash
hitch workspace remove RUN_ID
```

普通删除会拒绝有变更或状态不确定的工作区。`--force` 会明确丢弃它，仅在保存需要的输出后使用。`shared` 的源目录不属于可以通过此命令删除的托管工作区。

快照与恢复细节见[工作区约定](../../workspaces.md)。下一步[查看运行证据](runs-and-evidence.md)。
