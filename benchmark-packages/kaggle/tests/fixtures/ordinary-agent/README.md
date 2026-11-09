# Deterministic ordinary Agent fixture

This fixture uses Hitch's existing Pi adapter. It does not contact a model API.
It exercises the generic parameter client, accepts a permitted method change,
replays an immutable action, rejects a locked seed, then runs an ordinary sklearn
Pipeline containing a lambda FunctionTransformer and delivers a CSV.

Copy this directory to a temporary Git repository, commit it, then use
`pi@git+file:///absolute/fixture#FULL_COMMIT` in a standard `hitch eval run`.
The ordinary Pi preparation recipe runs `npm ci --ignore-scripts` and
`npm run build`, creating the adapter's expected entrypoint.

Inputs: `/data/train.csv` with `id,x,label` columns, and an explicit delivery
contract for IDs 101 and 102. The canary training rows all use label 1; the
fixture's constant classifier demonstrates execution, not model quality.
It registers a four-fold configuration but does not claim to execute CV.
The completed live run evidence is in `docs/evidence/mlebench-linux-2026-11-09.json`.
