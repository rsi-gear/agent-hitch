# MLE-bench task producer

MLE-bench uses ordinary Hitch resource tasks: public inputs, an instruction,
a parameter contract, a sandbox and a separate verifier. One evaluation attempt
includes the Agent's analysis, training, final prediction and delivery. The Agent
uses its harness's terminal and file tools and writes `submission.csv`; no research
state machine, pipeline factory or separate refit is required.

The public API is `agent-hitch/mlebench`, the importer CLI is `hitch-mlebench`,
and execution uses `hitch eval run`. See the [task guide](../../docs/mlebench-tasks.zh-CN.md)
for task creation, parameter permissions and result interpretation.

Task authors explicitly choose `evaluation.mode: scored` with trusted private
answers and a grader, or `evaluation.mode: delivery` for unlabeled prediction data.
A valid delivery without answers has no quality score. Internal cross-validation
is a method diagnostic and is never substituted for the external verifier's score.
Competition names and fixed dataset row counts do not select execution modes.

Private answers and grader code are separate verifier resources. The verifier
reads submitted CSV bytes and never imports the Agent's Python modules or pickles.
Inputs, grader sources, environment and evaluation contracts are content-addressed.

Parameter policy is enforced by the generic `agent-hitch/parameters` API and
frozen during admission. Configuration permissions and proof that arbitrary
training code obeyed that configuration are distinct. Ordinary scripts are
supported. Hard fit accounting, trusted CV and frozen selection require verified
capability bindings; unavailable coverage fails with `unsupported_constraint`
before a model launch.

This is a breaking replacement. Old research projects, checkpoints, requests,
carrier tools and package exports cannot be resumed or converted by this version.
Finish or cancel old runs with their original executor before switching. Retain
historical logs as static audit material, then import a new task and register a
new execution budget.

Validation:

```sh
npm run test:mlebench
npm run test:mlebench:package
npm run check:architecture
```

Contract and package tests are deterministic local checks. They do not establish
Linux sandbox isolation or a successful paid model run; those require separately
recorded execution evidence and an authorized model budget.
