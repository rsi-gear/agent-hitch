# Shared tree terminal producer

Configure the Hitch resource host with an immutable Python image transport first
(see `docs/resource-storage.zh-CN.md`). The source directory must contain a
`values.json` array of finite numbers and remain unchanged during import.

```sh
node benchmark-packages/shared-tree/import.mjs --source /data/tree --out /new/tasks --root /hitch --base-image registry/python@sha256:PLATFORM_MANIFEST --tasks 100 --platform linux/amd64
```

All tasks bind one CAS tree into a private candidate context. Each task asks for
the sum of a different prefix; the expected answer is verifier-only. Output
must be a new directory. This emits manifest v2, not a directly usable legacy
directory; use Hitch resource execution or explicit `resources legacy-export`.
