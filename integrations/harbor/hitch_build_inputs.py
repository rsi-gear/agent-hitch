"""Conservative, content-addressed local Docker build inputs.

Unsupported inputs keep Harbor's original build path. Snapshot before hashing:
the builder consumes exactly the bytes named by the key, never a mutable source
directory. Task names, runtime mounts and ownership labels are not build inputs.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import hashlib
import json
import os
import re
import shutil
import stat
from pathlib import Path


class UnsupportedBuild(ValueError):
    pass


@contextmanager
def read_context():
    # Docker can ignore unreadable entries using .dockerignore; our complete
    # snapshot cannot. Only source I/O becomes fallback, not destination errors.
    try:
        yield
    except OSError as error:
        raise UnsupportedBuild("context-read") from error


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build_spec(service, default_platform):
    build = service.get("build")
    if not isinstance(build, dict) or set(build) - {"context", "dockerfile", "args", "target", "labels"}:
        raise UnsupportedBuild("build-options")
    if service.get("pull_policy") not in (None, "build", "missing", "if_not_present", "never"):
        raise UnsupportedBuild("pull-policy")
    context = build.get("context")
    dockerfile = build.get("dockerfile", "Dockerfile")
    # Resolved config re-escapes paths too, so an existing '$$' sibling could
    # otherwise be mistaken for Compose's actual '$' input tree or Dockerfile.
    if any(isinstance(value, str) and "$" in value for value in (context, dockerfile)):
        raise UnsupportedBuild("escaped-build-paths")
    if not isinstance(context, str) or not Path(context).is_absolute():
        raise UnsupportedBuild("nonlocal-context")
    source = Path(context)
    if source.resolve() != source or not source.is_dir():
        raise UnsupportedBuild("context-path")
    if (not isinstance(dockerfile, str) or not dockerfile or "\\" in dockerfile
            or Path(dockerfile).is_absolute() or any(p in ("", ".", "..") for p in dockerfile.split("/"))):
        raise UnsupportedBuild("dockerfile-path")
    platform = service.get("platform") or default_platform
    if platform not in ("linux/amd64", "linux/arm64"):
        raise UnsupportedBuild("platform")
    args, labels = build.get("args", {}), build.get("labels", {})
    for values in (args, labels):
        if not isinstance(values, dict) or any(not isinstance(k, str) or not k or not isinstance(v, str) for k, v in values.items()):
            raise UnsupportedBuild("unresolved-build-values")
        # Compose config serializes literal dollars differently from its
        # execution plan. Keep native interpolation/escaping for such inputs.
        if any("$" in key or "$" in value for key, value in values.items()):
            raise UnsupportedBuild("escaped-build-values")
    if "BUILDKIT_SYNTAX" in args:
        # This reserved argument selects a frontend just like a # syntax
        # directive; even pinned frontends can introduce untracked inputs.
        raise UnsupportedBuild("custom-frontend")
    if "io.hitch.prepared-key" in labels:
        raise UnsupportedBuild("reserved-cache-label")
    target = build.get("target")
    if target is not None and (not isinstance(target, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]+", target)):
        raise UnsupportedBuild("build-target")
    return source, {"dockerfile": dockerfile, "platform": platform, "args": args, "labels": labels, "target": target}


def pinned_dockerfile(source):
    with read_context():
        if source.stat().st_size > 1024 * 1024:
            raise UnsupportedBuild("dockerfile-size")
        try:
            content = source.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            # Docker can accept non-UTF-8 comment bytes. Preserve its parser
            # and the original input instead of decoding lossily for caching.
            raise UnsupportedBuild("dockerfile-encoding") from error
    # Restrict parser directives and syntax we cannot unambiguously inspect.
    if "\0" in content or "<<" in content or re.search(r"(?im)^\s*#\s*escape\s*=", content):
        raise UnsupportedBuild("dockerfile-syntax")
    if re.search(r"(?im)^\s*#\s*syntax\s*=", content):
        # Even a pinned custom frontend can introduce untracked input sources.
        raise UnsupportedBuild("custom-frontend")
    stages, bases = set(), []
    logical = re.sub(r"\\\r?\n", " ", "\n".join(line for line in content.splitlines() if not line.lstrip().startswith("#")))
    for line in logical.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tokens = re.split(r"\s+", line, maxsplit=1)
        instruction, body = tokens[0], tokens[1] if len(tokens) == 2 else ""
        instruction = instruction.upper()
        if instruction not in {"FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "COPY", "ADD", "ONBUILD"}:
            raise UnsupportedBuild("dockerfile-instruction")
        if instruction == "FROM":
            match = re.fullmatch(r"(?:--platform=(linux/(?:amd64|arm64))\s+)?(\S+)(?:\s+[Aa][Ss]\s+([\w.-]+))?", body.strip())
            if not match:
                raise UnsupportedBuild("dynamic-base")
            if match[1]:
                raise UnsupportedBuild("per-stage-platform")
            base, alias = match[2], match[3]
            if base.lower() not in stages and base != "scratch":
                if not re.fullmatch(r"[^\s$]+@sha256:[a-f0-9]{64}", base):
                    raise UnsupportedBuild("mutable-base")
                bases.append(base)
            if alias:
                stages.add(alias.lower())
        elif instruction == "ADD":
            # ADD can read remote URLs or Git trees, independent of the context.
            raise UnsupportedBuild("add-input")
        elif instruction == "COPY":
            if "--from" in body and not re.search(r"--from=\S+", body):
                raise UnsupportedBuild("copy-source-syntax")
            for external in re.findall(r"--from=(\S+)", body):
                if external.lower() not in stages and not external.isdigit() and not re.fullmatch(r"[^\s$]+@sha256:[a-f0-9]{64}", external):
                    raise UnsupportedBuild("mutable-copy-source")
        elif instruction == "RUN" and re.search(r"--(?:mount|device|security)=", body):
            raise UnsupportedBuild("external-run-input")
        elif instruction == "ONBUILD":
            raise UnsupportedBuild("onbuild-input")
    if not re.search(r"(?im)^\s*FROM\s", logical):
        raise UnsupportedBuild("missing-base")
    return sorted(set(bases))


def context_inputs(content, dockerfile):
    """A safe subset of Dockerfile input selection, never a Dockerignore parser.

    Literal COPY sources (including complete directories) suffice for ordinary
    builds. Dynamic paths, globs and unfamiliar COPY options retain the full
    context. Docker itself applies the unchanged ignore files to the snapshot.
    The caller must validate the frontend, bases and external inputs separately.
    """
    # Python's split/splitlines accept whitespace Docker treats as filename
    # bytes. Keep unfamiliar characters on the full-context path, including
    # Unicode whitespace and nonstandard line separators.
    content = content.replace("\r\n", "\n")
    if re.search(r"[^\t\n\x20-\x7e]", content):
        return None
    # Continuations can join tokens, not only operands (e.g. pay\\\nload).
    # Retain the complete context instead of implementing Docker's lexer here.
    if any(line.rstrip().endswith("\\") for line in content.splitlines()):
        return None
    selected = {dockerfile, ".dockerignore", dockerfile + ".dockerignore"}
    for line in content.splitlines():
        tokens = line.strip().split(None, 1)
        if not tokens or tokens[0].upper() != "COPY":
            continue
        body = tokens[1] if len(tokens) == 2 else ""
        from_stage = False
        while body.startswith("--"):
            flag, separator, body = body.partition(" ")
            body = body.lstrip()
            if not separator:
                return None
            if re.fullmatch(r"--from=[\w./:@-]+", flag):
                from_stage = True
            elif not re.fullmatch(r"--(?:chown|chmod)=[\w:$,=+-]+|--link(?:=(?:true|false))?", flag):
                return None
        if from_stage:
            continue
        try:
            operands = json.loads(body) if body.startswith("[") else body.split()
        except ValueError:
            return None
        if not isinstance(operands, list) or len(operands) < 2 or any(not isinstance(p, str) for p in operands):
            return None
        for value in operands[:-1]:
            # Keep Docker's normalization and pattern grammar on its full path
            # instead of guessing at variable, escaping or parent semantics.
            value = value.rstrip("/")
            if (not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", value)
                    or any(part in (".", "..") for part in value.split("/"))):
                return None
            selected.add(value)
    return selected


async def snapshot_context(source, target, dockerfile=None):
    listxattr = getattr(os, "listxattr", None)
    if not callable(listxattr):
        raise UnsupportedBuild("context-xattr-inspection")
    entries = []
    selected = original_dockerfile = None
    if dockerfile is not None:
        # Validate before selecting inputs: ADD, RUN mounts, ONBUILD and custom
        # frontends can consume inputs outside literal COPY instructions.
        pinned_dockerfile(source / dockerfile)
        with read_context():
            original_dockerfile = (source / dockerfile).read_bytes()
        selected = context_inputs(original_dockerfile.decode("utf-8"), dockerfile)

    def needed(relative):
        return selected is None or not relative or any(
            relative == item or relative.startswith(item + "/") or item.startswith(relative + "/")
            for item in selected)

    async def copy(current, destination, relative):
        with read_context():
            info = current.lstat()
        mode = stat.S_IMODE(info.st_mode)
        try:
            attributes = listxattr(current, follow_symlinks=False)
        except (OSError, NotImplementedError) as error:
            # An uninspectable context must use the original build path; never
            # assume unsupported metadata is absent from the cache identity.
            raise UnsupportedBuild("context-xattr-inspection") from error
        if attributes:
            raise UnsupportedBuild("context-xattrs")
        if stat.S_ISDIR(info.st_mode):
            destination.mkdir(mode=0o700)
            with read_context():
                children = sorted(current.iterdir(), key=lambda p: os.fsencode(p.name))
            entries.append([relative, "directory", mode])
            for child in children:
                child_relative = f"{relative}/{child.name}" if relative else child.name
                if needed(child_relative):
                    await copy(child, destination / child.name, child_relative)
            with read_context():
                if [p.name for p in children] != sorted(os.listdir(current), key=os.fsencode):
                    raise UnsupportedBuild("context-changed")
            os.chmod(destination, mode)
            os.utime(destination, ns=(info.st_atime_ns, info.st_mtime_ns))
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                # COPY can preserve link relationships. Separate copies and a
                # byte-only identity cannot represent them, even on a hit.
                raise UnsupportedBuild("context-hardlinks")
            checksum = hashlib.sha256()
            with read_context():
                fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as reader, destination.open("xb") as writer:
                with read_context():
                    before = os.fstat(reader.fileno())
                if (before.st_ino, before.st_dev) != (info.st_ino, info.st_dev):
                    raise UnsupportedBuild("context-changed")
                while True:
                    with read_context():
                        chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    checksum.update(chunk)
                    writer.write(chunk)
                    await asyncio.sleep(0)
                with read_context():
                    after = os.fstat(reader.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise UnsupportedBuild("context-changed")
            os.chmod(destination, mode)
            os.utime(destination, ns=(info.st_atime_ns, info.st_mtime_ns))
            entries.append([relative, "file", mode, checksum.hexdigest()])
        else:
            raise UnsupportedBuild("special-context-entry")
        await asyncio.sleep(0)

    await copy(source, target, "")
    if dockerfile is not None and (target / dockerfile).read_bytes() != original_dockerfile:
        raise UnsupportedBuild("context-changed")
    return digest(entries)


def remove_snapshot(directory):
    # Source modes may be read-only. Never follow a symlink while cleaning up.
    for base, directories, _ in os.walk(directory, followlinks=False):
        os.chmod(base, 0o700)
        for child in directories:
            candidate = Path(base) / child
            if not candidate.is_symlink():
                os.chmod(candidate, 0o700)
    shutil.rmtree(directory)
