"""CPU-only helper protocol, output bound, timeout, and cancellation checks."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


CREDENTIAL_NAME = "DSH_OPENAI_CODEX_ACCESS_B64"
ERROR_SECRET = "opaque-secret-helper-error-123456789"


def spawn_descendant(record_path: str) -> subprocess.Popen:
    ready_path = f"{record_path}.child-ready"
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--child", ready_path],
        stdin=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 5
    while not Path(ready_path).exists():
        if child.poll() is not None:
            raise AssertionError("credential helper descendant exited before readiness")
        if time.monotonic() >= deadline:
            child.kill()
            raise AssertionError("credential helper descendant did not become ready")
        time.sleep(0.01)
    record = Path(record_path)
    temporary = record.with_name(f".{record.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"helper": os.getpid(), "child": child.pid}), encoding="utf-8")
    os.replace(temporary, record)
    return child


def child_main(ready_path: str) -> int:
    Path(ready_path).write_text(str(os.getpid()), encoding="utf-8")
    time.sleep(60)
    return 0


def helper_main(mode: str, pid_path: str | None) -> int:
    request = json.loads(sys.stdin.buffer.readline().decode())
    assert set(request) == {"version", "credentialNames", "minimumValidityMs"}
    assert request["version"] == 1 and not isinstance(request["version"], bool)
    assert request["credentialNames"] == [CREDENTIAL_NAME]
    tree = None
    if pid_path and mode in {
        "cancel",
        "leader-exit",
        "oversize-stderr",
        "oversize-stdout",
        "timeout",
    }:
        tree = spawn_descendant(pid_path)
    elif pid_path:
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
    if mode == "leader-exit":
        assert tree is not None
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


def process_running(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    state = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True,
        check=False,
        text=True,
    ).stdout.strip()
    return bool(state) and not state.startswith("Z")


async def wait_for_tree(record_path: Path, pending: asyncio.Task, timeout: float = 5) -> dict[str, int]:
    deadline = asyncio.get_running_loop().time() + timeout
    while not record_path.exists():
        if pending.done():
            await pending
            raise AssertionError("credential helper exited before recording its process tree")
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("credential helper process tree did not become ready")
        await asyncio.sleep(0.01)
    value = json.loads(record_path.read_text(encoding="utf-8"))
    assert set(value) == {"helper", "child"}
    return {name: int(pid) for name, pid in value.items()}


async def assert_tree_stopped(pids: dict[str, int], timeout: float = 5) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while any(process_running(pid) for pid in pids.values()):
        if asyncio.get_running_loop().time() >= deadline:
            running = {name: pid for name, pid in pids.items() if process_running(pid)}
            raise AssertionError(f"credential helper processes survived cleanup: {running}")
        await asyncio.sleep(0.01)


def force_stop_tree(pids: dict[str, int]) -> None:
    for pid in pids.values():
        if not process_running(pid):
            continue
        try:
            os.kill(pid, signal.SIGKILL if os.name != "nt" else signal.SIGTERM)
        except ProcessLookupError:
            pass


async def exercise_tree_error(module, mode: str, code: str, timeout_ms: int = 5_000) -> None:
    with tempfile.TemporaryDirectory(prefix=f"hitch-helper-{mode}-") as temporary:
        record_path = Path(temporary) / "pids.json"
        pending = asyncio.create_task(module.prepare_host_credentials(
            config(module, mode, timeout_ms, record_path), 10_000,
        ))
        pids: dict[str, int] = {}
        try:
            pids = await wait_for_tree(record_path, pending)
            await expect_error(module, pending, code)
            await assert_tree_stopped(pids)
        finally:
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            force_stop_tree(pids)


async def exercise_tree_cancellation(module) -> None:
    with tempfile.TemporaryDirectory(prefix="hitch-helper-cancel-") as temporary:
        record_path = Path(temporary) / "pids.json"
        pending = asyncio.create_task(module.prepare_host_credentials(
            config(module, "cancel", 60_000, record_path), 10_000,
        ))
        pids: dict[str, int] = {}
        try:
            pids = await wait_for_tree(record_path, pending)
            pending.cancel()
            try:
                await asyncio.wait_for(pending, timeout=8)
            except asyncio.CancelledError:
                pass
            else:
                raise AssertionError("helper cancellation was swallowed")
            await assert_tree_stopped(pids)
        finally:
            if not pending.done():
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            force_stop_tree(pids)


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
            await exercise_tree_error(module, mode, "host_credential_helper_response_invalid")
        await exercise_tree_error(module, "timeout", "host_credential_helper_timed_out", timeout_ms=2_000)
        await exercise_tree_cancellation(module)
        await exercise_tree_error(
            module,
            "leader-exit",
            "host_credential_helper_response_invalid" if os.name == "nt" else "host_credential_helper_timed_out",
            timeout_ms=1_000,
        )
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
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        raise SystemExit(child_main(sys.argv[2]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--helper":
        raise SystemExit(helper_main(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
    asyncio.run(main(Path(sys.argv[1]).resolve()))
