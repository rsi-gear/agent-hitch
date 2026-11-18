"""Confirm the isolated process boundary is empty before acknowledging stop."""

from __future__ import annotations

import ctypes
import errno
import json
import os
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import time


def exited(pid: int) -> bool:
    """Observe exit without reaping: the leader PID still reserves the owned PGID."""
    options = os.WEXITED | os.WNOHANG | os.WNOWAIT
    while True:
        try:
            if hasattr(os, "waitid"):
                return os.waitid(os.P_PID, pid, options) is not None
            if sys.platform != "darwin":
                raise RuntimeError("non-reaping waitid is unavailable")
            # macOS Python omits os.waitid, although libc exposes the POSIX API.
            # siginfo_t fits in this zeroed, long-aligned 256-byte buffer.
            info = (ctypes.c_long * 32)()
            libc = ctypes.CDLL(None, use_errno=True)
            waitid = libc.waitid
            waitid.argtypes = [
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            waitid.restype = ctypes.c_int
            if waitid(os.P_PID, pid, ctypes.byref(info), options) != 0:
                number = ctypes.get_errno()
                raise OSError(number, os.strerror(number))
            return ctypes.cast(info, ctypes.POINTER(ctypes.c_int))[0] != 0
        except InterruptedError:
            continue
        except ChildProcessError as error:
            raise RuntimeError("model group ownership was lost") from error


class DarwinProcess(ctypes.Structure):
    """Public 64-bit kinfo_proc prefix and stride from sys/sysctl.h."""

    _fields_ = [
        ("start_seconds", ctypes.c_int64),
        ("start_microseconds", ctypes.c_int32),
        ("_time_padding", ctypes.c_uint32),
        ("_vmspace", ctypes.c_uint64),
        ("_sigacts", ctypes.c_uint64),
        ("flags", ctypes.c_int32),
        ("state", ctypes.c_uint8),
        ("_state_padding", ctypes.c_char * 3),
        ("pid", ctypes.c_int32),
        ("_remaining", ctypes.c_char * 604),
    ]

    @property
    def identity(self) -> tuple[int, int, int]:
        return self.pid, self.start_seconds, self.start_microseconds


class DarwinSandbox:
    """Reap by the kernel's inherited sandbox identity, not process ancestry.

    A descendant can change its session or outlive its parent, but cannot remove
    or reapply its sandbox. Each signal is authorized by the sandbox at delivery,
    so PID recycling cannot signal an unrelated process. The guard joins before
    launch and is the only process that retains the acknowledgment descriptor.
    """

    def __init__(self, request: dict) -> None:
        if sys.platform != "darwin" or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise RuntimeError("unsupported process containment platform")
        argv = request["argv"]
        if len(argv) != 3 or argv[:2] != ["/bin/bash", "-c"]:
            raise RuntimeError("unsupported sandbox invocation")
        tokens = shlex.split(argv[2])
        if not tokens or tokens.pop(0) != "env":
            raise RuntimeError("unsupported sandbox environment")
        while tokens and tokens[0] != "/usr/bin/sandbox-exec":
            key, separator, value = tokens.pop(0).partition("=")
            if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise RuntimeError("unsupported sandbox environment")
            request["env"][key] = value
        if len(tokens) < 4 or tokens[:2] != ["/usr/bin/sandbox-exec", "-p"]:
            raise RuntimeError("unsupported sandbox profile invocation")
        profile = tokens[2]
        # The pinned runtime supplies this exact signal boundary. Refuse a
        # changed profile instead of ever attempting cleanup outside it.
        if (profile.count("(allow signal") != 1 or
                "(allow signal (target same-sandbox))" not in profile or
                "(deny default" not in profile or
                "(allow process-identity" in profile):
            raise RuntimeError("sandbox does not isolate process signals")
        if (profile.count("(allow mach-priv-task-port (target same-sandbox))") != 1 or
                profile.count("(allow process-info* (target same-sandbox))") != 1):
            raise RuntimeError("unsupported sandbox process permissions")
        profile = profile.replace(
            "(allow mach-priv-task-port (target same-sandbox))", "(deny mach-priv-task-port)"
        ).replace(
            "(allow process-info* (target same-sandbox))",
            "(allow process-info-pidinfo (target same-sandbox))\n"
            "(allow process-info-listpids)\n"
            "(allow process-info-setcontrol (target self))",
        )
        # Load the libraries before sandboxing the already-running interpreter.
        # No additional interpreter files need to become model-readable.
        library = ctypes.CDLL("/usr/lib/libsandbox.dylib", use_errno=True)
        library.sandbox_init.argtypes = [
            ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)
        ]
        library.sandbox_init.restype = ctypes.c_int
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.sysctl.argtypes = [
            ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t,
        ]
        self.libc.sysctl.restype = ctypes.c_int
        self.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.libproc.proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int
        ]
        self.libproc.proc_pidinfo.restype = ctypes.c_int
        self.libproc.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.libproc.proc_listallpids.restype = ctypes.c_int
        self.identity = self.process(os.getpid()).identity
        error = ctypes.c_char_p()
        if library.sandbox_init(profile.encode(), 0, ctypes.byref(error)) != 0:
            raise RuntimeError("could not establish process containment")
        try:
            os.kill(os.getppid(), 0)
        except PermissionError:
            pass
        else:
            raise RuntimeError("sandbox signal boundary was not established")
        request["argv"] = tokens[3:]

    def pids(self) -> list[int]:
        # libproc copies the raw PID list while holding proc_list_lock. Unlike
        # sysctl's KERN_PROC_ALL iterator, it does not silently skip a process
        # that exits between collection and the per-process inspection below.
        for capacity in (1024, 2048, 4096, 8192, 16384, 32768, 65536):
            values = (ctypes.c_int * capacity)()
            count = self.libproc.proc_listallpids(values, ctypes.sizeof(values))
            if 0 < count < capacity:
                result = list(values[:count])
                if os.getpid() not in result:
                    raise RuntimeError("process snapshot omitted its observer")
                return result
            if count <= 0:
                raise RuntimeError("process snapshot unavailable")
        raise RuntimeError("process snapshot exceeds its bound")

    def process(self, pid: int) -> DarwinProcess:
        mib = (ctypes.c_int * 4)(1, 14, 1, pid)  # CTL_KERN/KERN_PROC/KERN_PROC_PID
        value = DarwinProcess()
        size = ctypes.c_size_t(ctypes.sizeof(value))
        if self.libc.sysctl(mib, 4, ctypes.byref(value), ctypes.byref(size), None, 0) != 0:
            number = ctypes.get_errno()
            raise OSError(number, "process identity unavailable")
        if not size.value:
            raise ProcessLookupError("process identity unavailable")
        if size.value != ctypes.sizeof(value) or value.pid != pid:
            raise RuntimeError("unsupported process snapshot layout")
        return value

    def creation_marker(self) -> int:
        # XNU assigns ++nextuniqueid under proc_list_lock for every fork/spawn;
        # exec preserves it. Keep our marker unreaped while reading its unique
        # ID (PROC_PIDUNIQIDENTIFIERINFO, with zombie lookup enabled).
        pid = os.fork()
        if pid == 0:
            os._exit(0)
        try:
            value = (ctypes.c_uint64 * 7)()
            if self.libproc.proc_pidinfo(pid, 17, 1, value, 56) != 56 or not value[2]:
                raise RuntimeError("process creation identity unavailable")
            return value[2]
        finally:
            # The marker is still our unreaped child, so this PID cannot refer
            # to a host process even if an untrusted peer tried to stop it.
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)

    def terminate(self) -> None:
        deadline = time.monotonic() + 2
        previous_zombies: set[tuple[int, int, int]] = set()
        while time.monotonic() < deadline:
            before = self.creation_marker()
            unsettled = False
            zombies: set[tuple[int, int, int]] = set()
            for pid in self.pids():
                if pid <= 1 or pid == os.getpid():
                    continue
                try:
                    current = self.process(pid)
                    if current.state == 5:
                        # A parent can fork then exit while enumeration is in
                        # progress. Do not accept a newly observed zombie as
                        # proof that its as-yet unobserved descendants stopped.
                        zombies.add(current.identity)
                        if current.identity not in previous_zombies:
                            unsettled = True
                        continue
                    try:
                        os.kill(pid, 0)
                    except PermissionError:
                        # Recheck after the permission test. A recycled PID or
                        # a disappeared process makes this pass inconclusive.
                        if self.process(pid).identity != current.identity:
                            unsettled = True
                        continue
                    unsettled = True
                    # Only positive PIDs are used. The kernel applies same-sandbox
                    # to this actual delivery, including any intervening PID reuse.
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    unsettled = True
            previous_zombies = zombies
            if not unsettled and self.creation_marker() == before + 1:
                # With no other birth during this pass, neither a detached
                # grandchild nor a recycled PID can be hidden by enumeration.
                return
            time.sleep(0.01)
        raise RuntimeError("sandbox process termination was not confirmed")


def controller_closed(timeout: float) -> bool:
    try:
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        return bool(ready and not os.read(0, 1))
    except OSError as error:
        # libuv may use a socketpair whose peer death resets instead of EOF.
        if error.errno in (errno.ECONNRESET, errno.EPIPE, errno.EBADF):
            return True
        raise


def acknowledge(code: int) -> None:
    # fd 3 is guard-only (Popen close_fds); model output cannot forge this ACK.
    payload = json.dumps({"version": 1, "model_stopped": True, "returncode": code})
    try:
        os.write(3, payload.encode())
    except (BrokenPipeError, OSError):
        pass


def main() -> int:
    stopping = False

    def request_stop(*_args: object) -> None:
        nonlocal stopping
        # Initialization can be slower than the controller's cancellation.
        # Defer cleanup to the main flow, including before the model is started.
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    request = json.loads(sys.stdin.buffer.readline())
    controller_group = request.get("controllerGroup")
    if controller_group is not None and not (
        isinstance(controller_group, int)
        and controller_group > 1
        and controller_group == os.getpgrp() == os.getppid()
    ):
        raise RuntimeError("worker group ownership does not match its parent")
    containment = None
    try:
        if request.get("darwinSandbox"):
            containment = DarwinSandbox(request)
        elif sys.platform == "darwin":
            raise RuntimeError("Darwin process containment requires a sandbox")
        if stopping:
            acknowledge(137)  # Cancellation arrived before any model started.
            return 137
        child = subprocess.Popen(
            request["argv"],
            cwd=request["cwd"],
            env=request["env"],
            stdin=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
    except Exception:
        acknowledge(1)  # No model was started.
        raise

    group_stopped = False

    def terminate() -> None:
        nonlocal group_stopped
        if group_stopped:
            return
        if containment is not None:
            containment.terminate()
            group_stopped = True
            return
        # Never poll/send_signal/kill here: Popen may reap the reserved leader.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        group_stopped = True

    abandoned = False
    failed = False
    code = 1
    try:
        assert child.stdin is not None
        try:
            # The controller sends a fixed prompt under 4 KiB into this fresh
            # pipe; no other writer can fill it while stop signals are deferred.
            child.stdin.write(request["prompt"].encode())
            child.stdin.close()
        except BrokenPipeError:
            pass
        deadline = time.monotonic() + request["timeoutMs"] / 1000 + 5
        while not exited(child.pid):
            abandoned = abandoned or controller_closed(0.1)
            if stopping or time.monotonic() >= deadline or abandoned:
                terminate()
    except (
        OSError,
        RuntimeError,
        ValueError,
        AssertionError,
        subprocess.SubprocessError,
    ):
        failed = True
    finally:
        # A successful leader can leave live descendants. Confirm containment
        # before reaping it, retaining the Linux leader PID to reserve its group.
        terminate()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        returncode = child.wait()
        code = 1 if failed else (returncode if returncode >= 0 else 128 - returncode)
        abandoned = abandoned or controller_closed(0)
        if not abandoned:
            acknowledge(code)
        else:
            # Only the private owned root is removed, never a model-provided path.
            # Fork the preloaded interpreter: execing Python after entering the
            # model sandbox would require exposing its runtime dependency tree.
            try:
                cleaner = os.fork()
                if cleaner == 0:
                    try:
                        os.close(3)
                        shutil.rmtree(request["cleanupRoot"], ignore_errors=True)
                    finally:
                        os._exit(0)
                try:
                    cleanup_deadline = time.monotonic() + 1
                    while not exited(cleaner) and time.monotonic() < cleanup_deadline:
                        time.sleep(0.01)
                    os.kill(cleaner, signal.SIGKILL)
                finally:
                    os.waitpid(cleaner, 0)
            except OSError:
                pass
            if containment is None and controller_group is not None and os.getppid() != controller_group:
                # This guard is still a member, so this group ID cannot be reused.
                # Reclaim orphaned proxy bridges only after the model group stops.
                os.killpg(controller_group, signal.SIGKILL)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
