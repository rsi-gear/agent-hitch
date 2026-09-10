"""Prepare short-lived credentials on the Harbor host at Target start."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, NamedTuple

HOST_CREDENTIAL_HELPER_ENV = "HITCH_HOST_CREDENTIAL_HELPER_JSON"
HOST_CREDENTIAL_HELPER_CAPABILITY = "host-task-credential-helper-v1"
HOST_CREDENTIAL_VALIDITY_MARGIN_MS = 5 * 60 * 1000

_MAX_CONFIG_BYTES = 64 * 1024
_MAX_OUTPUT_BYTES = 256 * 1024
_MAX_ARGUMENTS = 32
_MAX_ARGUMENT_LENGTH = 4_096
_MAX_CREDENTIAL_BYTES = 256 * 1024
_ENVIRONMENT_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class _HelperOutputTooLarge(RuntimeError):
    pass


class HostCredentialHelperError(RuntimeError):
    """A stable failure that never includes helper output or credential values."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class HostCredentialHelperConfig(NamedTuple):
    argv: tuple[str, ...]
    credential_names: tuple[str, ...]
    timeout_ms: int


def load_host_credential_helper(available_names: list[str]) -> HostCredentialHelperConfig | None:
    encoded = os.environ.get(HOST_CREDENTIAL_HELPER_ENV)
    if encoded is None:
        return None
    try:
        if not encoded or len(encoded.encode("utf-8")) > _MAX_CONFIG_BYTES:
            raise ValueError
        value = json.loads(encoded)
        if not isinstance(value, dict) or set(value) != {"version", "argv", "credentialNames", "timeoutMs"}:
            raise ValueError
        if isinstance(value["version"], bool) or value["version"] != 1:
            raise ValueError
        argv = value["argv"]
        if (
            not isinstance(argv, list)
            or not 1 <= len(argv) <= _MAX_ARGUMENTS
            or any(not isinstance(item, str) or not item or len(item) > _MAX_ARGUMENT_LENGTH or re.search(r"[\0\r\n]", item) for item in argv)
            or not os.path.isabs(argv[0])
        ):
            raise ValueError
        names = value["credentialNames"]
        if (
            not isinstance(names, list)
            or not names
            or any(not isinstance(name, str) or _ENVIRONMENT_NAME.fullmatch(name) is None for name in names)
            or len(set(names)) != len(names)
            or any(name not in available_names for name in names)
        ):
            raise ValueError
        timeout_ms = value["timeoutMs"]
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 60_000:
            raise ValueError
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise HostCredentialHelperError(
            "host_credential_helper_config_invalid",
            "host credential helper configuration is invalid",
        ) from None
    return HostCredentialHelperConfig(tuple(argv), tuple(sorted(names)), timeout_ms)


async def prepare_host_credentials(
    config: HostCredentialHelperConfig,
    minimum_validity_ms: int,
) -> dict[str, str]:
    if (
        isinstance(minimum_validity_ms, bool)
        or not isinstance(minimum_validity_ms, int)
        or not 1 <= minimum_validity_ms <= 9_007_199_254_740_991
    ):
        raise HostCredentialHelperError(
            "host_credential_helper_request_invalid",
            "host credential helper request is invalid",
        )
    request = json.dumps(
        {
            "version": 1,
            "credentialNames": list(config.credential_names),
            "minimumValidityMs": minimum_validity_ms,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8") + b"\n"

    try:
        process = await asyncio.create_subprocess_exec(
            *config.argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )
    except (OSError, ValueError):
        raise HostCredentialHelperError(
            "host_credential_helper_unavailable",
            "host credential helper could not be started",
        ) from None

    try:
        stdout, _stderr = await asyncio.wait_for(
            _communicate_limited(process, request),
            timeout=config.timeout_ms / 1000,
        )
    except asyncio.TimeoutError:
        await _terminate_helper(process)
        raise HostCredentialHelperError(
            "host_credential_helper_timed_out",
            "host credential helper exceeded its time limit",
        ) from None
    except _HelperOutputTooLarge:
        await _terminate_helper(process)
        raise invalid_response() from None
    except asyncio.CancelledError:
        await _terminate_helper(process)
        raise

    if process.returncode != 0:
        raise HostCredentialHelperError(
            "host_credential_helper_failed",
            "host credential helper did not provide credentials",
        )
    try:
        response: Any = json.loads(stdout.decode("utf-8"))
        if (
            not isinstance(response, dict)
            or set(response) != {"version", "env", "expiresAtMs"}
            or isinstance(response["version"], bool)
            or response["version"] != 1
        ):
            raise ValueError
        expires_at_ms = response["expiresAtMs"]
        if isinstance(expires_at_ms, bool) or not isinstance(expires_at_ms, int):
            raise ValueError
        values = response["env"]
        if not isinstance(values, dict) or set(values) != set(config.credential_names):
            raise ValueError
        if any(
            not isinstance(name, str)
            or not isinstance(value, str)
            or not value
            or "\0" in value
            for name, value in values.items()
        ):
            raise ValueError
        if sum(len(value.encode("utf-8")) for value in values.values()) > _MAX_CREDENTIAL_BYTES:
            raise ValueError
    except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise invalid_response() from None

    if expires_at_ms <= int(time.time() * 1000) + minimum_validity_ms:
        raise HostCredentialHelperError(
            "host_credential_helper_insufficient_validity",
            "host credential helper returned credentials with insufficient validity",
        )
    return dict(values)


async def _communicate_limited(process, request: bytes) -> tuple[bytes, bytes]:
    async def read(stream) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = await stream.read(min(64 * 1024, _MAX_OUTPUT_BYTES + 1 - total))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            total += len(chunk)
            if total > _MAX_OUTPUT_BYTES:
                raise _HelperOutputTooLarge

    stdout_task = asyncio.create_task(read(process.stdout))
    stderr_task = asyncio.create_task(read(process.stderr))
    wait_task = asyncio.create_task(process.wait())
    try:
        process.stdin.write(request)
        try:
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        process.stdin.close()
        stdout, stderr, _return_code = await asyncio.gather(stdout_task, stderr_task, wait_task)
        return stdout, stderr
    finally:
        for task in (stdout_task, stderr_task, wait_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(stdout_task, stderr_task, wait_task, return_exceptions=True)


async def _terminate_helper(process) -> None:
    """Kill a failed helper and drain both pipes without retaining their contents."""
    if process.returncode is None:
        process.kill()

    async def discard(stream) -> None:
        while await stream.read(64 * 1024):
            pass

    cleanup = asyncio.gather(discard(process.stdout), discard(process.stderr), process.wait())
    try:
        await asyncio.wait_for(cleanup, timeout=5)
    except asyncio.TimeoutError:
        # Closing the subprocess transport is a last-resort, bounded cleanup.
        # The helper is already SIGKILLed and never runs inside the Target.
        transport = getattr(process, "_transport", None)
        if transport is not None:
            transport.close()


def invalid_response() -> HostCredentialHelperError:
    return HostCredentialHelperError(
        "host_credential_helper_response_invalid",
        "host credential helper returned an invalid response",
    )
