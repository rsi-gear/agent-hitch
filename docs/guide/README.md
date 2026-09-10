# Maintaining the Hitch user guide

The guide's canonical Markdown lives here, alongside the implementation it
describes. Start reading in [English](en/index.md) or [简体中文](zh-CN/index.md).
The website renders the same content at `https://rsigear.xyz/docs/hitch/`.

`manifest.json` defines the reading order, stable slugs, languages, descriptions,
applicable Hitch version, and review date. Keep translated pages aligned. Update
the version and date after checking the commands against that release; a source
commit identifies the content snapshot separately from the package version.

Use ordinary Markdown with one leading H1 matching the manifest title. Relative
links between guide pages work on GitHub and are converted to website routes.
Links to other repository documents stay available as GitHub references. Avoid
raw HTML and executable MDX. The website compiler rejects unsupported links,
raw HTML, missing pages, and broken guide anchors.

`cli-reference.md` inventories user-facing commands and options in both languages.
Run `npm run docs:check` in agent-hitch after edits. Its CLI coverage check reads
the actual dispatch and argument parser source, including commands omitted from
the shorter terminal help. When adding a command or option, update both references
with its syntax, purpose, and supported scope. Internal Harbor bridge flags are
excluded from the public command reference.

The `examples/hello-hitch` directory is a one-task Harbor dataset for the tutorial.
Its verifier intentionally gives valid zero reward for missing or incorrect
output. Keep the example independent of external benchmark datasets.

## Update the website snapshot

From the gear-pages checkout:

```bash
npm run docs:sync -- --source ../agent-hitch
npm run docs:check -- --source ../agent-hitch
npm test
```

Local sync includes working-tree guide files and records whether they differ
from HEAD. It does not commit, push, or deploy either repository. Before a
release, commit the guide in agent-hitch, then import that exact full commit:

```bash
npm run docs:sync -- --source ../agent-hitch --ref FULL_COMMIT_SHA
```

After that commit is available on GitHub, `--ref FULL_COMMIT_SHA` also works
without `--source`. gear-pages commits the imported Markdown plus file checksums.
Its builds validate that snapshot and compile it offline; ordinary website builds
do not fetch a moving branch or depend on a sibling checkout. Commit the website
snapshot together with any presentation changes, then use its existing release
process to publish.
