# Titanic / MLE-bench 执行与 Gear 接口

Gear 定义实验策略、配置版本、候选生成与晋升；Hitch 负责整个任务的准备、执行、校验、预算结算、checkpoint、恢复、refit 和导出。Gear 通过现有 process provider 的 `describe / submit / inspect / cancel` 调用 Hitch，不导入分析执行模块。Gear 的 `examples/mle-bench/` 只保留初始 `harness/`。

| 内容 | 所有者 |
| --- | --- |
| 官方数据、官方 train/test、评分与私有答案 | Benchmark 任务合同 |
| 外层验证算法、折数、shuffle、种子、比例、实验版本 | Gear 项目配置 |
| 数据校验、具体逐行分配、隔离训练、评分、任务内恢复 | Hitch |
| 特征、模型、调参方法、实验选择策略 | 可编辑 harness，由 Gear Meta 优化 |

## 冻结配置

Gear 项目保存 `experiment.json`，并把完整内容放入通用 provider 的 `configuration.experiment`：

```json
{
  "version": "validation-v1",
  "maxExperiments": 5,
  "validation": {
    "method": "stratified_kfold",
    "folds": 5,
    "shuffle": true,
    "seed": 42
  }
}
```

当前支持 `kfold`、`stratified_kfold`（2–10 折），以及 `holdout`、`stratified_holdout`。留出法用 `fraction` 替代 `folds`，范围为 0–1 之间；`shuffle` 和 uint32 `seed` 均须显式提供。分层留出对每类按比例向上取整，并保证训练和验证都非空。未实现 group/time 算法；未知参数不会被忽略。

Hitch 在准备时生成一次 `data/validation.json`，记录配置摘要、训练数据摘要、splitter 版本、行 ID 与逐行 fold 分配。K-fold 行号为 0 到 folds−1；holdout 的训练行是 −1、验证行是 0。执行与恢复只读取这份分配，校验数据和证据，不重新随机划分。模型训练种子与划分种子分别记录。

同一配置版本不能对应不同内容。五折改十折、改变种子或验证比例，需要新版本和新的 Gear 运行；Hitch 自动建立独立实验目录、初始 checkpoint 与预算记录。baseline 和候选都在新方案下重新执行，旧成绩保留但不可混排。Gear admission 会冻结整个 provider 配置，修改后不能恢复旧运行。

当前候选必须遵守共同的外层方案。将来若允许优化内部 CV，仍需使用共同固定的外层方案比较最终效果，不能用各自选择的容易划分直接排名。五折是迁移默认值，不是新执行器的固定常量。旧 task/experiment/round-plan 协议保持原语义；旧项目使用原绑定包版本回放，不静默升级 runtime。

## 准备任务

安装 `agent-hitch`；宿主数据准备需要 Python 3.12 与 `test-support/requirements.txt` 中的依赖。训练使用已登记的固定 Linux OCI 镜像。配置 Hitch 的 OCI transport 和模型访问后：

```sh
hitch-analysis prepare \
  --competition titanic \
  --train /data/titanic/train.csv --predict /data/titanic/test.csv \
  --harness /workspace/gear/examples/mle-bench/harness \
  --experiment-config /workspace/project/experiment.json \
  --out /workspace/titanic-execution \
  --hitch-root /workspace/hitch-state \
  --base-image 'registry/runtime@sha256:<digest>' \
  --platform linux/arm64 --model '<configured-model>'
```

Titanic 使用完整的 891 行官方 train 和 418 行官方 test。研究划分只来自 train，官方 test 不参与候选选择。初始 harness 是显式输入；Hitch 本身不依赖 Gear 安装或相邻源码 checkout。固定执行器从已安装包的认证 runtime 生成精确 Git 快照；源码只在 `integrations/analysis-runtime/` 维护一份。

MLE-bench 导入使用 `--mlebench-repository`、`--mlebench-data` 和 `--competition`。支持的参照任务为 `nomad2018-predict-transparent-conductors`（双目标 mean-column-wise RMSLE）与 `tabular-playground-series-may-2022`（ROC AUC）。上游定义固定在 `507f92e1138bb6e40dac5c6ee7a6758e6424bf97`；导入校验定义、公开资产和上游 checksums。NOMAD 的几何资产也按实际训练/验证行隔离。

MLE-bench 的 prepared/public/test 是 benchmark 自己的测试集，不能当成官方 Kaggle test。私有答案只供 verifier；研究 checkpoint 不包含私有表或 grader 路径。另建研究划分不会改变 benchmark 的官方数据合同。

## Gear 启动优化

Hitch 可以导出声明式客户端项目和 process profile，但不会调用 Gear 算法或选择晋升结果：

```sh
hitch-analysis project \
  --project /workspace/titanic-execution \
  --out /workspace/titanic-optimization \
  --meta-profile my-meta \
  --experiment-config /workspace/project/experiment.json
```

命令打印 profile 名称和文件路径。客户端通过 Gear 的公开接口注册配置并启动：

```js
import { readFile } from 'node:fs/promises'
import { saveProfile, createProjectControlPlane } from 'rsi-gear'

const directory = '/workspace/titanic-optimization'
const config = JSON.parse(await readFile(`${directory}/gear.yaml`, 'utf8'))
const profile = JSON.parse(await readFile(`${directory}/provider-profile.json`, 'utf8'))
await saveProfile(config.target.profile, profile)
const control = await createProjectControlPlane(directory)
try {
  const report = await control.application.refine()
} finally {
  await control.dispose()
}
```

`my-meta` 是客户端已配置的 Meta profile。`gear.yaml` 使用 YAML 兼容的 JSON 编码。项目、profile、任务描述和候选初始资源在导出时冻结；新实验方案导出到新目录。若只修改初始 profile 中的 `configuration.experiment`，Hitch 会按新版本创建执行上下文，Gear 则必须重新 admission，不能沿用旧运行。显式传入旧 checkpoint 与新方案会被拒绝。

Gear 只消费标准 score、evidence、usage 和 artifact locator。Hitch 的 operation receipt 还提供实际 sequence/plan 身份，供操作者在 Hitch 查询任务内详情。通用 trajectory reader 由 Gear 本地绑定自身实现摘要，Hitch 只声明公开 reader 格式和配置，不依赖 Gear 内部实现代码。

## 执行、恢复与提交

每个 harness 从相同 checkpoint 和配置出发，获得相同的实验槽与资源额度。Hitch 预留并结算实际消耗，丢失回复时按原执行身份收取结果；重复请求不能重置预算或增加拟合。取消通过执行取消与持久化启动栅栏确认。

评分使用最后实际选择的、属于当前外层方案的已有证据，不自动替换成历史最高分，不增加隐式测试训练。记录包括每折分数、均值、标准差、utility、预测与行分配。此结果是开发选择证据，不是独立泛化估计或 Kaggle 官方成绩。

选定后显式 refit；`--project` 使用该版本对应的 Hitch 执行目录，`--sequence` 使用 receipt 中的 plan digest：

```sh
hitch-analysis refit --project /workspace/titanic-execution \
  --sequence '<plan-digest>' --out /workspace/titanic-refit
hitch-analysis mlebench export --project /workspace/titanic-execution \
  --sequence '<plan-digest>' --refit /workspace/titanic-refit \
  --out /workspace/titanic-submission
```

Refit 绑定实际所选源码、参数、runtime 和输入，仅在全部登记训练行上拟合一次，不搜索、不调用模型。导出校验 refit 归属和封存预测，只复制已存在的提交，不触发训练。

## 验证

```sh
npm run build
node --test benchmark-packages/kaggle/tests/research/*.test.mjs
node --test dist/test/analysis-package.test.js dist/test/kaggle-producer.test.js
node scripts/check-analysis-package.mjs
```

包验收先只安装 Hitch，检查准备、配置版本、runtime 和声明式导出。设置 `GEAR_TEST_GEAR_PACKAGE` 指向 Gear tarball，可增加真实 process 协议、Python GEPA、晋升与丢失回复恢复测试。设置 `GEAR_ANALYSIS_IMAGE` 为已登记的镜像，可增加真实 Linux 十折训练与 Hitch eval refit；模型决策使用确定性脚本。`GEAR_MLEBENCH_PYTHON` 选择准备环境，`KAGGLE_TEST_PYTHON` 选择 Python 测试环境，`GEAR_MLEBENCH_REPOSITORY` 可启用与原生 grader 的一致性验证。
