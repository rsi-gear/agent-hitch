# Releasing Hitch

GitHub Releases are the source of truth for npm publication. Publishing a
release triggers `.github/workflows/publish-npm.yml`, which validates and tests
the tagged source before publishing it to npm with trusted publishing.

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
