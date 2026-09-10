# Contributing to Hitch

Contributions to code, tests, documentation, and reproducible bug reports are
welcome. For a substantial feature or protocol change, open an issue first to
agree on scope. Bug reports should include the Hitch and Node versions, OS,
steps to reproduce, and expected and actual behavior. Remove credentials and
private task data from examples and logs.

## Development setup

Use Git, npm, Node.js 22 or 24, and Python 3 for the Harbor bridge tests.
`package.json` defines the supported Node range; the
[CI workflow](.github/workflows/ci.yml) defines the tested versions and platforms.
Docker, Harbor, model credentials, and GPUs are needed only for the checks that
exercise those integrations.

```sh
git clone https://github.com/rsi-gear/agent-hitch.git
cd agent-hitch
git switch dev
npm ci
npm run check
```

Create a topic branch from the intended target branch; use `dev` for normal
development PRs. Keep `package-lock.json` in sync when dependencies change.
Build output lives in `dist/` and is not committed.

## Code structure and readability

The [architecture checker](scripts/check-architecture.ts) is the source of truth
for allowed module dependencies. The
[architecture design](docs/src-architecture-refactor-spec.zh-CN.md) explains the
separation of responsibilities.

- Put behavior in the module that owns it. `domain` holds pure contracts and
  validation; `foundation` holds shared mechanisms; business modules own their
  state and orchestration. CLI handlers parse arguments and format results.
- Import across modules through the owning module's `index.ts`. Keep facade
  exports explicit and limited to needed APIs. Avoid deep imports, `export *`,
  and re-export chains through unrelated modules. Imports of types also count
  toward dependency cycles.
- Keep cohesive operations together. Aim for implementation files under 400
  lines; the checker enforces a 500-line maximum. Split by responsibility when
  needed. Do not compress statements or create tiny forwarding files to satisfy
  the limit.
- Follow nearby TypeScript style: two-space indentation, double quotes,
  semicolons, and `.js` suffixes for local ESM imports. Use descriptive names,
  named types for substantial contracts, and explicit blocks for nontrivial
  conditions. Keep one operation per statement and avoid nested ternaries.
- Extract duplicated rules when callers share the same meaning and owner.
  Keep call-specific validation explicit. Avoid speculative frameworks,
  generic utility buckets, and abstractions with no current caller.
- Explain invariants and non-obvious decisions in comments, especially lock
  ordering, persistence boundaries, cancellation, and ownership. Do not narrate
  the implementation or leave development progress notes in source files.

There is no repository-wide formatter or linter configuration. Keep formatting
changes focused on the code being edited; a new formatting policy belongs in a
separate change.

## Compatibility and durable state

Treat CLI flags, JSON output, error codes and exit codes, public module exports,
HTTP contracts, and persisted records as interfaces. A refactor must preserve
them. Describe intentional compatibility changes and their migration or version
strategy in the PR.

Validate external `unknown` values at boundaries. Update runtime validators,
types, schemas, and callers together. Reuse a canonical schema with `$ref` for
shared contracts; preserve existing schema IDs and fragment entry points when
refactoring. Ensure all referenced schemas are shipped and resolve locally.

Preserve canonical JSON and hashing rules, immutable identities, and state paths
unless the change explicitly introduces a new contract. Compiled runtime changes
produce a new runtime digest; record that identity when repeating certification. Never
rewrite historical execution evidence to make a retry or recovery succeed.
For lifecycle changes, account for interruptions between durable writes,
duplicate requests, stale generations, cancellation, and resource release.
A timeout or expired lease alone does not prove that physical resources stopped.

## Tests and validation

`npm run check` runs type checking, a clean build, architecture and compiled
syntax checks, and the test suite. Run it before requesting review of code
changes. Documentation-only changes need valid links and accurate examples;
report the checks relevant to the change.

For a focused test, rebuild first: `npm test` runs compiled files and does not
build them.

```sh
npm run build
node --test --test-timeout=120000 dist/test/ordered-eval-control.test.js
```

Add regression tests for observable failures and changed contracts. Prefer
realistic public boundaries over tests that reproduce implementation details.
Use isolated temporary directories and explicit Hitch roots; clean up processes,
ports, and files. Reuse suitable fixtures from `test-support/`. Avoid real
credentials, personal state, and timing assumptions based only on fixed sleeps.

For crash or recovery changes, exercise the relevant interrupted write or
process boundary and assert identity, retry, and release behavior. State which
parts use real processes or services and which are fixtures. CPU tests and
mocked GPU inventories do not establish hardware support.

Run additional checks when the affected surface requires them:

| Change | Validation |
| --- | --- |
| Runtime behavior and test coverage | `npm run coverage`; thresholds are defined in `package.json` |
| Runtime packaging, artifact preparation, or dependencies | `npm run canary:packaged-harness` and `npm pack --dry-run`; inspect the package contents |
| Docker or GPU integration | Relevant integration or hardware canary, with environment and evidence recorded |

CI runs the full suite on Ubuntu and macOS with Node 22 and 24, and the native
support tests on Windows. Coverage runs on Ubuntu/Node 24. Hardware checks are
separate manual gates; see [the release process](docs/releasing.md).

## Documentation and dependencies

Keep user instructions separate from protocol reference, design rationale, and
historical certification records. Put repeatable setup and current behavior in
guides; link to dated evidence instead of accumulating a development diary.
Update both READMEs when a shared entry point or user-facing overview changes.

Prefer built-in capabilities where practical. A new dependency needs a concrete
reason, compatible licensing, and consideration of Node/platform support,
maintenance, package size, and runtime portability. Runtime dependencies must be
included in the controller payload and its integrity checks when used there;
Hitch currently includes `smol-toml`. Verify installation and execution from the
packed package without relying on the source checkout.

Do not commit generated output, local state, credentials, unrelated drafts, or
large test artifacts. Use small fixtures with clear provenance. Publishing and
version changes follow [the release process](docs/releasing.md).

## Pull requests

Keep a PR focused on one outcome. Separate behavior changes from broad file
moves or formatting so reviewers can follow the logic. Use concise commit
subjects such as `fix: ...`, `refactor: ...`, or `docs: ...`; keep each commit
coherent and remove temporary debugging work before review.

Lead the PR description with the problem and resulting behavior. Include:

- The scope, linked issue if applicable, and important design tradeoffs.
- Compatibility or persistence changes and how existing records are handled.
- Exact validation commands and results, including skipped checks and the limits
  of fixture-based evidence.
- Remaining limitations that affect users or merge readiness.

Before requesting review, inspect the entire diff for unrelated changes,
duplicated definitions, unnecessary exports, stale documentation, and accidental
secrets. Resolve applicable CI failures and review feedback. A green CI run is
necessary for code changes, but does not replace review of scope and clarity.
