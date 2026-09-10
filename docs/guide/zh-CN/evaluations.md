# 第一次评测

评测在一组任务上衡量模型与 Harness 配置，发布对应的 Hitch Run、分数和证据。Hitch 接受 Harbor 兼容的任务定义，也接受带有自定义工具、生命周期与评分规则的 Benchmark Package。当前执行后端为 Harbor。

## 选择评测对象

- [x] **比较模型：** 固定 Harness、任务和评测配置，更换 `--model`。
- [x] **比较 Harness：** 固定模型和任务，更换 `--harness` 或其版本。
- [x] **无工具模型评测：** 对兼容的无工具任务使用可信的 `model-call` 驱动，直接请求模型，不运行智能体工具循环。当前 `dev` 的接入要求见 [Benchmark Package](../../benchmark-packages.md)。

保持任务输入和预算一致，同时记录模型配置与 Harness 版本。先运行下面的单任务 Docker 示例，再选择完整 Benchmark。

## 检查环境

需要 Python 3.12 或更高版本、已启动 daemon 的 Docker、下载软件包和镜像的网络，以及能在容器中使用的模型认证。

```bash
hitch eval setup harbor
hitch eval doctor
```

Setup 在 `~/.hitch/tools/` 下的独立环境安装 Hitch 固定的 Harbor，不会安装或启动 Docker。Doctor 只读检查环境；继续前修复 Python、Harbor 和 Docker 的错误。若自动找到的 Python 太旧，给 setup 和 doctor 传入 `--python /absolute/path/to/python3.12`。

本机交互式登录不会自动把认证交给 Docker。对于这个 Codex 示例，通过日常使用的密钥管理器或 Shell 配置，把 OpenAI API key 放入 `CODEX_API_KEY` 环境变量。命令使用 `--pass-env CODEX_API_KEY` 显式传递变量名，Codex 非交互进程会读取它；只为其他工具配置 `OPENAI_API_KEY` 不能替代这一步。详见 [Codex 自动化认证](https://developers.openai.com/codex/noninteractive)。密钥值不要写进提示词或提交到仓库。

如果已经在 [Quick Start](quickstart.md) 中启动 daemon，请把下面示例的命令改为 `hitch eval run --daemon`。Daemon 占用同一 root 时，直接评测会被拒绝。Daemon 自身环境必须包含 `CODEX_API_KEY`；如果配置密钥前它就已启动，先完成或取消活动任务，再停止 daemon，从已配置认证的 Shell 使用原资源参数重新启动。详见[启动统一的协调者](daemon.md#启动统一的协调者)。

使用托管模型时，见[本机 SGLang 评测](model-inference.md#在本机运行托管-sglang)与[远程模型节点](model-inference.md#使用托管远程模型节点)。使用外部服务时，参见[容器访问配置](model-inference.md#从-docker-评测访问模型)。

## 运行一个示例任务

在包含本指南的 agent-hitch 源码仓库中，使用 `docs/guide/examples` 作为数据集。其中唯一的 `hello-hitch` 任务要求智能体写入一个小文本文件，Shell Verifier 检查其精确内容，无需外部 Benchmark 数据。

```bash
git clone https://github.com/rsi-gear/agent-hitch.git
cd agent-hitch
hitch eval run \
  --backend harbor \
  --dataset docs/guide/examples \
  --harness codex@version:0.92.0 \
  --pass-env CODEX_API_KEY \
  --agent-arg --dangerously-bypass-approvals-and-sandbox \
  --attempts 1 \
  --max-concurrent 1 \
  --timeout 5m \
  --setup-timeout 15m \
  --output json
```

已有源码仓库时，直接从仓库根目录执行 `hitch eval run`。与本地运行一样，可以添加 `--model MODEL_ID`，选择该 Harness 接受的模型。评测会拒绝 `@installed`，因为它无法标识可移植的容器制品。

额外的 Codex 参数允许这个可信示例写入答案，无需交互批准或再嵌套一层沙箱。它作用于 Harbor 任务容器里的 Harness，不要把该参数复制到普通的宿主机运行命令中。

这个例子用于验证安装，不是衡量智能体质量的 Benchmark。Ubuntu 基础镜像使用版本标签；要将任务用于可复现性声明，还应固定镜像 digest。冷缓存时，准备时间可能明显长于任务执行时间。

## 理解结果

复制返回的 `eval_id`，替换下面的 `EVAL_ID`：

```bash
hitch eval list --json
hitch eval inspect EVAL_ID --json
```

检查最终状态、`summary`、有效和无效 observation，以及各 Trial 的 `run_id`。用某个 Trial 的 Run ID 检查证据：

```bash
hitch runs inspect RUN_ID --json
hitch verifier inspect RUN_ID --json
hitch trajectory project RUN_ID --profile analysis --json
```

示例中，有效 reward `1` 表示生成了预期文件，有效 reward `0` 表示没有生成。无效 Trial 表示执行或证据有问题。Hitch 的 `summary` 排除无效 observation；`backend_summary` 保留 Harbor 原始汇总用于诊断。

记录保存在 `~/.hitch/evals/EVAL_ID/`。执行期间，`progress.json` 描述已发布的 Trial；完成后以终态 `result.json` 为准。每个 Trial 的证据发布在普通 `runs/` 目录中。

## 修复无效 Trial

解决失败原因后，明确重跑无效或缺失的 slot：

```bash
hitch eval rerun EVAL_ID --invalid
```

默认 `candidate-restart` 会重新运行智能体，可能再次调用模型，并非重放原答案。有效零分不属于要修复的无效 slot。自动 Verifier 基础设施重试是另一条路径：在现有 Trial 内重跑 Verifier，不会悄悄重新执行 Candidate。中断后先检查 [daemon 恢复流程](daemon.md#回到中断的评测)：原执行可能仍可补收结果，无需启动新 Candidate。

## 扩展到 Benchmark

将 `--dataset` 换成本地 Harbor 数据集或不可变 registry 引用，例如 `terminal-bench@2.0`。它选择整个数据集，不是单个任务：`--max-concurrent 1` 限制并发数，不限制总任务数。检查大型 Benchmark 时，应明确准备一个小子集。

打包和采样方法见 [Benchmark packages](../../benchmark-packages.md) 和 [Harbor 原生数据生产器](../../../benchmark-packages/harbor-source/README.md)。多个评测共享 Docker 主机时，阅读 [Daemon：并行与恢复](daemon.md)。传输、资源策略及恢复细节见 [Harbor 参考](../../evals.md)。
