"""Real BuildKit filesystem parity and content-key reuse, without models or pulls."""
import asyncio
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/harbor"))
from hitch_image_cache import ImagePreparationCache, docker


async def main(directory):
    root = Path(directory).resolve()
    context = root / "source"
    context.mkdir()
    (context / "inputs").mkdir()
    (context / "inputs/value").write_text(uuid.uuid4().hex)
    (context / "inputs/private").write_text("excluded")
    (context / "inputs/payCOPY").write_text("joined continuation operand")
    (context / "inputs/second").write_text("second source")
    (context / "inputs/foo\u00a0bar").write_text("Unicode whitespace belongs to the filename")
    (context / "unrelated").mkdir()
    (context / "unrelated/task.json").write_text("first task")
    (context / "unrelated/source.py").write_bytes(b"unused source\n" * 100_000)
    cache = ImagePreparationCache(root / "cache", dict(os.environ))
    builder = (await cache.identity())["builder_name"]
    service = {"platform": "linux/amd64", "build": {"context": str(context)}}
    native_tag = "hitch-input-test:" + uuid.uuid4().hex
    reports = []
    async def filesystem(image):
        return (await cache.inspect(image))["RootFS"]["Layers"]
    try:
        for label, content in [
            ("literal-file", "FROM scratch\nCOPY inputs/value /value\n"),
            ("json-directory", 'FROM scratch\nCOPY ["inputs/", "/data/"]\n'),
            ("stage-copy", "FROM scratch AS first\nCOPY inputs/value /value\nFROM scratch\nCOPY --from=first /value /value\n"),
            ("wildcard-fallback", "FROM scratch\nCOPY inputs/v* /data/\n"),
            ("unicode-whitespace-fallback", "FROM scratch\nCOPY inputs/foo\u00a0bar inputs/value /data/\n"),
            ("continuation-fallback", "FROM scratch\nCOPY inputs/va\\\nlue /value\n"),
            ("space-continuation-fallback", "FROM scratch\nCOPY inputs/value inputs/pay\\ \nCOPY inputs/second /data/\n"),
            ("tab-continuation-fallback", "FROM scratch\nCOPY inputs/value inputs/pay\\\t\nCOPY inputs/second /data/\n"),
        ]:
            (context / "Dockerfile").write_text(content)
            (context / ".dockerignore").write_text("inputs/private\nunrelated\n")
            await docker(["buildx", "build", "--builder", builder, "--load", "--progress", "plain",
                          "--platform", "linux/amd64", "--tag", native_tag, str(context)], env=cache.env)
            native = await filesystem(native_tag)
            first = await cache.prepare(service)
            assert await filesystem(first["image"]) == native, label
            (context / "unrelated/task.json").write_text(uuid.uuid4().hex)
            warm = await cache.prepare(service)
            if not label.endswith("-fallback"):
                assert warm["cache_hit"] and warm["image"] == first["image"], label
            else:
                assert not warm["cache_hit"], "ambiguous paths must keep conservative full-context keys"
            (context / "inputs/value").write_text(uuid.uuid4().hex)
            changed = await cache.prepare(service)
            assert not changed["cache_hit"] and changed["cache_key"] != first["cache_key"], label
            assert await filesystem(changed["image"]) != native, label
            reports.append({"case": label, "native_filesystem_equal": True,
                            "unrelated_change_hit": warm["cache_hit"], "input_change_missed": True})
        # A Dockerfile-specific ignore file overrides the root file, just as
        # it does in the original context; both are transported unchanged.
        (context / "Dockerfile").write_text('FROM scratch\nCOPY ["inputs/", "/data/"]\n')
        (context / "Dockerfile.dockerignore").write_text("inputs/value\n")
        await docker(["buildx", "build", "--builder", builder, "--load", "--progress", "plain",
                      "--platform", "linux/amd64", "--tag", native_tag, str(context)], env=cache.env)
        specific = await cache.prepare(service)
        assert await filesystem(specific["image"]) == await filesystem(native_tag)
        print(json.dumps(reports), flush=True)
        print("native filesystem parity, literal reuse, changed inputs and ignore precedence OK", flush=True)
    finally:
        await docker(["image", "rm", native_tag], env=cache.env, check=False)
        for record in cache.directory.glob("image-*.json"):
            await docker(["image", "rm", json.loads(record.read_text())["tag"]], env=cache.env, check=False)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
