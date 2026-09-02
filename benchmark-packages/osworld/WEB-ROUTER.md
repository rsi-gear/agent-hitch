# Static website router component

`compile-web-router.py` reads `web-compose.yml` directly from the Git objects
selected by the parent website release, rather than the mutable submodule
working tree. It compiles the observed Caddy label dialect into a static
Caddyfile and a private Compose router fragment. It does not read a Docker
socket or publish host ports.

The parent is fixed at
`Task-Web/OSWorld-web@90ec2218f7747b15fe5117cdbe59b8978446ab9c`.
Its 24 runtime applications declare 39 services and 25 website hostnames; the
remaining `basesite` gitlink is a development template. Applications selected for
a real task must come from the authorized task requirements. This compiler does
not infer those requirements from task IDs.

Install `PyYAML==6.0.2` in a separate tooling environment, initialize the selected
public submodules at the parent-pinned commits, then run:

```sh
python benchmark-packages/osworld/compile-web-router.py \
  --website-checkout /path/to/OSWorld-web \
  --apps budgetwise_web \
  --namespace trial.hitch.test \
  --router-image lucaslorentz/caddy-docker-proxy:2.8-alpine@sha256:06b32ac4ea4a8417441e2cc3312ef8136368667cb36c622a3c7a0bb12190d9e6 \
  --out /path/to/new-router-directory
```

Outputs:

| File | Contract |
| --- | --- |
| `Caddyfile` | Explicit upstream HTTP/HTTPS defaults, multi-host sites, numerically ordered `/api*`, `/mcp*` and fallback proxies. A `route` block retains order. |
| `routes.json` | `osworld-web-routes@1`: parent/component commits, compose source hashes, Caddyfile hash, image reference, domain aliases and TLS requirement. |
| `docker-compose.proxy.yaml` | JSON-form YAML, explicit `/bin/caddy run` entrypoint, read-only config, fresh named data/config volumes, resource limits, internal `web` and `vm` networks. |

Merge this fragment with the corresponding pinned application services and the
owned VM/controller topology. Preserve upstream environment, health checks,
application-specific networks and read-only state inputs. The router reaches
backends through `web`; VM/controller reach its declared aliases through `vm`.
Use a fresh Compose project and volumes per trial and destroy them on cleanup.
Application images and complete source/asset inputs still need frozen identities
and package-wide capacity accounting. The fragment is not an executable Harbor
task and marks `full_task_assembly_complete: false`.

Only the observed release dialect is supported. Unknown routing directives,
arbitrary upstream hosts, cross-component proxy targets, duplicate service/host
identities, ambiguous numeric order and missing terminal fallback are rejected.
Uncommitted compose edits are ignored. A new upstream dialect requires a new
explicit adapter and validation.

## HTTPS and asset prerequisites

The collaborative Overleaf component defaults to HTTPS and enables Secure
cookies. Its scheme must remain HTTPS. The static router uses `tls internal`;
the per-trial root certificate is
`/data/caddy/pki/authorities/local/root.crt`. An assembler must wait for that
certificate, install its trust in the controller's Python TLS context and the
guest browser/OS, and verify requests without disabling certificate checks.
The certificate is public; the CA private key remains in the router's private
volume. A successful Caddy configuration check does not verify guest trust.
That trust/bootstrap path has not yet been implemented or validated.

`interfacinglinux_web` also has a Docker build argument whose default downloads
an asset from a floating Hugging Face `main` URL. Resolve it to the matching
authorized release bytes before building that component. Upstream example URLs
embedded in default application state are preserved; their mere presence is
not evidence that matching assets were fetched or verified.

## Verification and limits

The compiler has been run against all 24 pinned compose definitions. The pinned
linux/amd64 Caddy image passed `caddy validate` on the resulting configuration.
`python3 test-support/osworld_web_routes_smoke.py` additionally checks the plain
proxy regression, ordered paths, multiple hosts, HTTPS, private topology and
rejection of unsupported or ambiguous routes. These pure tests need no PyYAML.

`test-support/osworld_web_container_canary.py` accepts a compiled Budgetwise
router, separately built frontend/backend images, a local Python client image,
the upstream `STATE.md`, and a fresh receipt path. It creates an owned internal
Compose project, checks HTML/assets, REST get/put/delete, per-cookie state
isolation, restoration of the original default data, and the `/mcp/` backend
route. It checks for host port/socket exposure, removes its containers/networks/
volumes, and records image IDs and cleanup status. It does not invoke MCP tools
or expose them to a candidate. An MCP GET protocol error can verify routing but
does not prove a working MCP session.

The real Budgetwise canary uses
`Task-Web/budgetwise_web@d7450221ba688ab50f0abb74fa1bf1dbcf8bc601`;
its Git archive SHA256 is
`5cc21d2738b8c03a2c4697f8c5bcd8646a5ca3882552c9f89dc1906bc86fc318`.
Application source and dependency lockfiles are unchanged; only Dockerfile
base image references are resolved to immutable linux/amd64 manifests. Freeze
the resulting application images for distribution. Local image configuration
IDs are not registry pull references.

This verifies one public application deployment component. It does not execute
either selected official OSWorld task, boot the official VM, validate the
authorized assets, or verify full task initialization/grading. It contributes
zero real scored tasks to the benchmark acceptance count.
