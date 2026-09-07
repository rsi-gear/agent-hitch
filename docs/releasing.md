# Releasing Hitch

GitHub Releases are the source of truth for npm publication. Publishing a
release triggers `.github/workflows/publish-npm.yml`, which validates and tests
the tagged source before publishing it to npm with trusted publishing.

## Continuous integration

The `CI` workflow runs on pull requests and pushes to `main` or `dev`. Other
branches can be checked before opening a pull request with `workflow_dispatch`.
New runs cancel older runs of the same workflow and ref.

Six jobs cover Node 22 and 24 on Ubuntu, macOS, and Windows. Ubuntu and macOS
run the full test suite; Windows runs the native support tests. The packaged
harness canary shares the Ubuntu and Windows jobs and their compiled output.
Every job builds with TypeScript, which also performs the type check, and
checks npm packaging. npm's download cache is reused between runs.

Ubuntu on Node 24 runs the full suite with coverage instead of running it
twice, and also checks architecture, compiled syntax, and installation of the
packed CLI. The NVIDIA GPU hardware workflow remains a manual hardware gate.

The publication workflow runs `npm run check` once before release metadata
validation and publication. Its publish commands use `--ignore-scripts` to
avoid repeating that check through `prepublishOnly`; the package retains the
hook for other callers.

## One-time npm setup

Configure a GitHub Actions trusted publisher for `agent-hitch` in its npm
package settings:

- organization or user: `rsi-gear`
- repository: `agent-hitch`
- workflow filename: `publish-npm.yml`
- environment: leave blank
- allowed action: `npm publish`

This OIDC configuration avoids storing an npm access token in GitHub. The
workflow has only `contents: read` and `id-token: write` permissions. npm
automatically adds provenance because both the repository and package are
public.

## Publish a version

1. Update `package.json` to the intended semantic version and merge it into
   `main`.
2. Create and publish a GitHub Release targeting that commit. Its tag must be
   exactly `v` followed by the package version, such as `v0.2.0`.
3. Watch the **Publish npm package** workflow. It verifies that the tagged
   commit belongs to `main`, runs the complete test suite, and publishes the
   package.
4. Verify the release with `npm view agent-hitch version`.

For example:

```bash
gh release create v0.2.0 \
  --repo rsi-gear/agent-hitch \
  --target main \
  --generate-notes
```

A GitHub prerelease must use a prerelease package version such as
`0.2.0-beta.1`. Prereleases are published under npm's `next` tag; regular
releases are published under `latest`.

Do not run `npm publish` manually. GitHub Packages is intentionally not used:
the public installation source remains `npm install --global agent-hitch`.
