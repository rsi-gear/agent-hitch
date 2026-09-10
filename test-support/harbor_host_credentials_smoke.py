"""CPU-only helper protocol, output bound, timeout, and cancellation checks."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path


CREDENTIAL_NAME = "DSH_OPENAI_CODEX_ACCESS_B64"
ERROR_SECRET = "opaque-secret-helper-error-123456789"


def helper_main(mode: str, pid_path: str | None) -> int:
    request = json.loads(sys.stdin.buffer.readline().decode())
    assert set(request) == {"version", "credentialNames", "minimumValidityMs"}
    assert request["version"] == 1 and not isinstance(request["version"], bool)
    assert request["credentialNames"] == [CREDENTIAL_NAME]
    if pid_path:
        Path(pid_path).write_text(str(os.getpid()), encoding="utf-8")
    if mode == "success":
        access = f"opaque-secret-fresh-{uuid.uuid4().hex}"
        envelope = base64.b64encode(json.dumps({"access": access}).encode()).decode()
        print(json.dumps({
            "version": 1,
            "env": {CREDENTIAL_NAME: envelope},
            "expiresAtMs": int(time.time() * 1000) + request["minimumValidityMs"] + 60_000,
        }))
        return 0
    if mode == "bool-version":
        print(json.dumps({
            "version": True,
            "env": {CREDENTIAL_NAME: "invalid"},
            "expiresAtMs": int(time.time() * 1000) + request["minimumValidityMs"] + 60_000,
        }))
        return 0
    if mode == "failure":
        print(ERROR_SECRET)
        print(ERROR_SECRET, file=sys.stderr)
        return 7
    if mode in {"oversize-stdout", "oversize-stderr"}:
        descriptor = 1 if mode.endswith("stdout") else 2
        chunk = (ERROR_SECRET.encode() + b"x" * (64 * 1024))
        # Deliberately continue well beyond both the pipe capacity and Hitch's
        # 256-KiB retention limit. Hitch must kill us instead of buffering it.
        for _ in range(64):
            os.write(descriptor, chunk)
        time.sleep(60)
        return 0
    if mode in {"timeout", "cancel"}:
        time.sleep(60)
        return 0
    raise AssertionError(f"unknown helper mode: {mode}")


def load_module(source: Path):
    spec = importlib.util.spec_from_file_location("hitch_host_credentials", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def expect_error(module, awaitable, code: str, timeout: float = 8) -> None:
    try:
        await asyncio.wait_for(awaitable, timeout=timeout)
    except module.HostCredentialHelperError as error:
        assert error.code == code, (error.code, code)
        diagnostic = f"{error} {error.message!r}"
        assert ERROR_SECRET not in diagnostic
    else:
        raise AssertionError(f"expected {code}")


def config(module, mode: str, timeout_ms: int, pid_path: Path | None = None):
    argv = [sys.executable, str(Path(__file__).resolve()), "--helper", mode]
    if pid_path is not None:
        argv.append(str(pid_path))
    return module.HostCredentialHelperConfig(tuple(argv), (CREDENTIAL_NAME,), timeout_ms)


async def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


async def main(source: Path) -> None:
    module = load_module(source)
    original_config = os.environ.get(module.HOST_CREDENTIAL_HELPER_ENV)
    original_credential = os.environ.get(CREDENTIAL_NAME)
    os.environ[CREDENTIAL_NAME] = "stale-host-access"
    try:
        os.environ[module.HOST_CREDENTIAL_HELPER_ENV] = json.dumps({
            "version": True,
            "argv": [sys.executable],
            "credentialNames": [CREDENTIAL_NAME],
            "timeoutMs": 1000,
        })
        try:
            module.load_host_credential_helper([CREDENTIAL_NAME])
        except module.HostCredentialHelperError as error:
            assert error.code == "host_credential_helper_config_invalid"
        else:
            raise AssertionError("boolean config version was accepted")

        minimum = 10_000
        successful = await asyncio.gather(*[
            module.prepare_host_credentials(config(module, "success", 5_000), minimum)
            for _ in range(6)
        ])
        envelopes = [entry[CREDENTIAL_NAME] for entry in successful]
        assert len(set(envelopes)) == 6
        for envelope in envelopes:
            decoded = json.loads(base64.b64decode(envelope).decode())
            assert decoded["access"].startswith("opaque-secret-fresh-")
        assert os.environ[CREDENTIAL_NAME] == "stale-host-access"

        await expect_error(
            module,
            module.prepare_host_credentials(config(module, "bool-version", 5_000), minimum),
            "host_credential_helper_response_invalid",
        )
        await expect_error(
            module,
            module.prepare_host_credentials(config(module, "failure", 5_000), minimum),
            "host_credential_helper_failed",
        )
        for mode in ("oversize-stdout", "oversize-stderr"):
            await expect_error(
                module,
                module.prepare_host_credentials(config(module, mode, 5_000), minimum),
                "host_credential_helper_response_invalid",
            )

        await expect_error(
            module,
            module.prepare_host_credentials(config(module, "timeout", 100), minimum),
            "host_credential_helper_timed_out",
        )

        with tempfile.TemporaryDirectory(prefix="hitch-helper-cancel-") as temporary:
            pid_path = Path(temporary) / "pid"
            pending = asyncio.create_task(module.prepare_host_credentials(
                config(module, "cancel", 60_000, pid_path), minimum,
            ))
            deadline = asyncio.get_running_loop().time() + 3
            while not pid_path.exists():
                if asyncio.get_running_loop().time() >= deadline:
                    raise AssertionError("cancel helper did not start")
                await asyncio.sleep(0.01)
            pid = int(pid_path.read_text(encoding="utf-8"))
            pending.cancel()
            try:
                await asyncio.wait_for(pending, timeout=8)
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("helper cancellation was swallowed")
            deadline = asyncio.get_running_loop().time() + 2
            while await process_exists(pid) and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.01)
            assert not await process_exists(pid), "cancelled helper process survived cleanup"
    finally:
        if original_config is None:
            os.environ.pop(module.HOST_CREDENTIAL_HELPER_ENV, None)
        else:
            os.environ[module.HOST_CREDENTIAL_HELPER_ENV] = original_config
        if original_credential is None:
            os.environ.pop(CREDENTIAL_NAME, None)
        else:
            os.environ[CREDENTIAL_NAME] = original_credential

    print("Harbor host credential helper smoke OK")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--helper":
        raise SystemExit(helper_main(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
    asyncio.run(main(Path(sys.argv[1]).resolve()))
