"""Behavioral Harbor bridge smoke test for local Git transport handoff."""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

from bridge_smoke import AgentContext, BaseEnvironment, install_harbor_stubs, load_bridge


def transport_kwargs(manifest_path: Path, payload_path: Path, resolution_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        "kind": manifest["kind"],
        "manifest_path": str(manifest_path),
        "payload_path": str(payload_path),
        "locked_resolution_path": str(resolution_path),
        "harness_id": manifest["harness_id"],
        "resolution_identity": manifest["resolution_identity"],
        "commit": manifest["commit"],
        "tree": manifest["tree"],
        "payload_sha256": manifest["payload_sha256"],
        "payload_bytes": manifest["payload_bytes"],
        "object_count": manifest["object_count"],
        "file_count": manifest["file_count"],
    }


def agent_for(bridge, logs: Path, runtime: Path, runtime_id: str, transport: dict):
    return bridge.HitchHarborAgent(
        logs_dir=logs,
        harness_ref=f'{transport["harness_id"]}@commit:{transport["commit"]}',
        revision_identity=transport["resolution_identity"],
        hitch_runtime_dir=str(runtime),
        controller_runtime_id=runtime_id,
        local_source_transport=transport,
        hitch_timeout_ms=5_000,
        workdir="/app",
        model_name="openai/test-model",
    )


def main() -> int:
    bridge_path, runtime_path, transport_root, logs_path = map(Path, sys.argv[1:5])
    install_harbor_stubs()
    bridge = load_bridge(str(bridge_path))
    runtime_manifest = json.loads((runtime_path / "manifest.json").read_text(encoding="utf-8"))
    manifest_path = transport_root / "manifest.json"
    payload_path = transport_root / "payload.pack"
    resolution_path = transport_root / "resolution.json"
    transport = transport_kwargs(manifest_path, payload_path, resolution_path)
    env = BaseEnvironment(transport["resolution_identity"])
    context = AgentContext()
    agent = agent_for(bridge, logs_path, runtime_path, runtime_manifest["runtime_id"], transport)

    async def drive() -> None:
        await agent.setup(env)
        await agent.run("do the task", env, context)

    asyncio.run(drive())
    local_uploads = [upload for upload in env.uploads if upload[2].startswith("/opt/hitch-local-source/")]
    if len(local_uploads) != 3 or any(upload[0] != "file" for upload in local_uploads):
        raise AssertionError(f"expected three independent local-source file uploads, got {local_uploads!r}")
    commands = "\n".join(env.execs)
    if commands.count("--internal-locked-resolution") != 2:
        raise AssertionError("prepare and run did not share the locked resolution handoff")
    if commands.count("--internal-local-git-source") != 2:
        raise AssertionError("prepare and run did not share the verified Git source")
    if context.metadata.get("local_source_transport", {}).get("payload_sha256") != transport["payload_sha256"]:
        raise AssertionError("trial metadata omitted the verified local-source digest")

    with tempfile.TemporaryDirectory(prefix="hitch-bridge-tamper-") as temporary:
        tampered = Path(temporary) / "payload.pack"
        shutil.copyfile(payload_path, tampered)
        with tampered.open("ab") as handle:
            handle.write(b"tamper")
        bad_transport = dict(transport)
        bad_transport["payload_path"] = str(tampered)
        bad_env = BaseEnvironment(transport["resolution_identity"])
        bad_agent = agent_for(bridge, logs_path, runtime_path, runtime_manifest["runtime_id"], bad_transport)
        try:
            asyncio.run(bad_agent.setup(bad_env))
        except RuntimeError as error:
            if "payload size" not in str(error) and "payload digest" not in str(error):
                raise
            if bad_env.uploads:
                raise AssertionError("bridge uploaded data after host-side transport tamper")
        else:
            raise AssertionError("bridge accepted a tampered local-source payload")

    print("local transport bridge smoke OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
