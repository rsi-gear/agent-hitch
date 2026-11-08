# Published analysis integration

`agent-hitch/analysis` owns the task execution lifecycle, benchmark adapter and
versioned evaluation-plan materialization. Gear supplies experiment policy through
a generic process provider. It is part of the npm package and does not require a neighboring
source checkout. Hitch does not import or depend on Gear.

```js
import {
  describeAnalysisIntegration, materializeAnalysisRuntime,
  materializeAnalysisExecutor, materializeAnalysisClient, prepareAnalysisTask,
} from 'agent-hitch/analysis'

const binding = await describeAnalysisIntegration()
await materializeAnalysisRuntime('/new/carrier/fixed/runtime', {
  expectedDigest: binding.runtime.digest,
})
const executor = await materializeAnalysisExecutor('/new/project/executor', {
  expectedDigest: binding.runtime.digest,
})
const executable = await materializeAnalysisClient('/new/project/bin/hitch.mjs')
```

Materialization validates the release manifest and copies its exact closure. It
refuses an existing destination or a mismatched digest. The executor is a local
Git snapshot of installed release assets, suitable for the ordinary immutable
Git harness resolver. It is not a second maintained runtime implementation.
`verifyAnalysisRuntime(directory, descriptor)` checks a materialized bundle.

The sole Python execution source is `integrations/analysis-runtime/`. Both
container-local research tools and the zero-model `sealed-python` adapter use
it. The producer also copies its `scoring.py` into the isolated verifier.
`describeAnalysisIntegration()` binds the runtime, producer, verifier, schema
and scorer. Persist that descriptor before execution; upgrading the package is
not permission to rewrite an existing task, checkpoint or receipt.

`prepareAnalysisTask(options)` creates a standard resource-v2 dataset. Configure
the host's pinned OCI transport through `agent-hitch/resources` first; the task
producer does not overwrite host policy. Execute through the normal Hitch eval,
cancel, inspect, verifier and artifact APIs. Research fits within a target
session do not create nested evals.

The same entry exports `inspectMlebench`, `importMlebench`, `prepareTabularData`,
`inspectDeploymentData`, `installMlebenchCompetition`, `runNativeMlebench` and
`validateTabularSubmission`. Data preparation and the optional native grader
require an explicitly selected Python environment with their dependencies.
Candidate training runs in the pinned Linux runtime image. Private answers
belong only to the verifier, never the candidate input tree.

`agent-hitch/analysis/contracts` exports the shared schema and validators.
`readAnalysisContract(name)` returns one of `schemas.mjs`,
`analysis.schema.json` and `golden.json` for verified deployment. Historical
protocols retain their original interpretation. Projects bound to an older
execution closure must use their original compatible packages; they are never
silently rebound to the current runtime.

After building, `node --test dist/test/analysis-package.test.js
dist/test/kaggle-producer.test.js` checks the API and execution contracts. Use
Python 3.12 with `test-support/analysis-requirements.txt`; `KAGGLE_TEST_PYTHON` selects it.
Set `GEAR_MLEBENCH_REPOSITORY` to the pinned upstream checkout to include native
grader parity (also install the upstream grader's Python dependencies). The
Linux canaries live in `benchmark-packages/kaggle/tests/` and require the pinned
runtime image. `scripts/check-analysis-package.mjs` tests standalone installation and optionally
the two tarballs through the generic process wire. See
[the execution guide](../../docs/analysis-research.zh-CN.md).

`prepareAnalysisProject({harness, experiment, ...})` prepares a standalone task;
`configureAnalysisExperiment(directory, experiment)` materializes a new evaluation
version without reusing old scores. `exportOptimizationProject(directory, options)`
exports declarative client files only. The Gear client registers its profile and
runs its own optimizer. The `hitch-analysis` CLI exposes these lifecycle operations.

Policies support configurable K-fold/stratified K-fold and local holdouts. Hitch
persists configuration/data identities and per-row assignments once, rejects
same-version drift and candidate overrides, and reuses exact assignments on
resume. New policies get independent checkpoints. Historical five-fold protocols
remain replayable under their original runtime binding.
