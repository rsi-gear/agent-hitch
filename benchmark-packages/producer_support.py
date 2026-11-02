"""Standard-library helpers for independent, local terminal package producers."""
import ast
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile

CAPS = ["shell", "artifact-export", "separate-verifier"]
PYTHON_IMAGE = "python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def json_file(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def toml_text(value):
    """Serialize this producer's bounded JSON-like TOML data without dependencies."""
    def atom(item):
        if isinstance(item, str): return json.dumps(item, ensure_ascii=False)
        if isinstance(item, bool): return str(item).lower()
        if isinstance(item, (int, float)): return repr(item)
        if isinstance(item, list): return "[" + ", ".join(atom(x) for x in item) + "]"
        if isinstance(item, dict): return "{ " + ", ".join(f"{atom(k)} = {atom(v)}" for k, v in item.items()) + " }"
        raise ValueError("unsupported TOML value")
    lines = []
    def table(item, keys):
        if keys: lines.append("[" + ".".join(atom(k) for k in keys) + "]")
        for key, child in item.items():
            if not isinstance(child, dict): lines.append(f"{atom(key)} = {atom(child)}")
        for key, child in item.items():
            if isinstance(child, dict): table(child, [*keys, key])
    table(value, [])
    return "\n".join(lines) + "\n"


def checkout(source, revision):
    source = Path(source).resolve()
    if not re.fullmatch(r"[a-f0-9]{40}", revision): raise ValueError("source revision must be a full Git commit")
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=normal"], text=True)
    if actual != revision or dirty: raise ValueError("source must be a clean checkout at the requested commit")
    return source


@contextmanager
def git_commit_tree(source, revision):
    """Materialize exact tracked blobs, without checkout filters or ignored files."""
    if not re.fullmatch(r"[a-f0-9]{40}", revision): raise ValueError("source revision must be a full Git commit")
    git = ["git", "--no-replace-objects", "-C", str(source)]
    listing = subprocess.check_output([*git, "ls-tree", "-rz", "--full-tree", revision])
    with tempfile.TemporaryDirectory(prefix="hitch-pinned-source-") as directory:
        root = Path(directory)
        for entry in listing.split(b"\0"):
            if not entry: continue
            metadata, raw_name = entry.split(b"\t", 1)
            mode, kind, oid = metadata.decode("ascii").split()
            name = raw_name.decode("utf-8")
            relative = PurePosixPath(name)
            if (relative.is_absolute() or relative.as_posix() != name or any(char in name for char in '\\<>:"|?*')
                    or any(part in (".", "..") or part.casefold() == ".git" or part.endswith((".", " "))
                           or re.fullmatch(r"CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³]", part.split(".", 1)[0].rstrip(" ").upper())
                           for part in relative.parts)
                    or any(ord(char) < 32 or ord(char) == 127 for char in name)):
                raise ValueError(f"unsafe Git source path: {name!r}")
            if mode not in ("100644", "100755") or kind != "blob" or not re.fullmatch(r"[a-f0-9]{40}", oid):
                raise ValueError(f"non-regular Git source entry: {name}")
            data = subprocess.check_output([*git, "cat-file", "blob", oid])
            if hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() != oid:
                raise ValueError(f"Git source blob identity mismatch: {name}")
            target = root.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation also rejects filesystem aliases/collisions.
            with target.open("xb") as stream: stream.write(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
        yield root


def regular_tree(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir(): raise ValueError(f"missing or unsafe directory: {root}")
    for current, names, files in os.walk(root, followlinks=False):
        for name in [*names, *files]:
            child = Path(current) / name
            mode = child.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f"source contains symlink/special file: {child}")


def copy_tree(source, destination):
    regular_tree(source)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))


def copy_git_tree(checkout_root, source, destination):
    """Copy only this commit's tracked inputs; ignored local credentials are excluded."""
    source = Path(source)
    regular_tree(source)
    relative = source.relative_to(checkout_root).as_posix()
    listing = subprocess.check_output(["git", "-C", str(checkout_root), "ls-tree", "-rz", "--name-only", "HEAD", "--", relative])
    names = [name.decode("utf-8") for name in listing.split(b"\0") if name]
    destination.mkdir(parents=True, exist_ok=False)
    for name in names:
        file = Path(checkout_root) / name
        if file.is_symlink() or not file.is_file(): raise ValueError(f"tracked input is missing or unsafe: {name}")
        target = destination / file.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)


def file_records(root):
    regular_tree(root)
    return [{"path": p.relative_to(root).as_posix(), "sha256": digest(p.read_bytes()), "bytes": p.stat().st_size}
            for p in sorted(Path(root).rglob("*")) if p.is_file() and "__pycache__" not in p.parts and p.suffix not in {".pyc", ".pyo"}]


def select(population, seed, count, explicit=None):
    ids = sorted(population)
    if not ids or len(ids) != len(set(ids)): raise ValueError("invalid or empty source membership")
    if explicit:
        chosen = list(explicit)
        if len(chosen) != len(set(chosen)) or not set(chosen) <= set(ids): raise ValueError("requested task is absent or duplicated")
        algorithm = "explicit-task-ids-v1"
    else:
        if not 0 < count <= len(ids): raise ValueError("count must be between one and population size")
        chosen = sorted(ids, key=lambda name: hashlib.sha256(f"{seed}\0{name}".encode()).hexdigest())[:count]
        algorithm = "sha256-rank-v1"
    return {"algorithm": algorithm, "seed": seed, "population_size": len(ids), "population_digest": digest(canonical(ids)), "tasks": chosen}


def definitions(path, functions=(), constants=()):
    """Load selected upstream pure definitions without importing provider SDKs."""
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in functions
             or isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets)]
    namespace = {"Path": Path}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


def write_package(root, *, name, revision, uri, license, selection, primary, metrics, extensions):
    metric_specs = {key: {"type": kind, "direction": "maximize", "range": [0, 1], "reducer": "task_macro_mean"} for key, kind in metrics.items()}
    (root / "benchmark.toml").write_text(toml_text({"schema_version": "1", "protocol": "hitch-benchmark@1", "id": name,
        "release": revision, "task_root": "tasks", "task_ids": selection["tasks"], "default_profile": "profiles/default.json",
        "primary_metric": primary, "runtime_components": [], "task_format": {"name": "harbor", "schema_version": "1.4"},
        "source": {"kind": "git", "uri": uri, "resolved_revision": revision, "license": license, "access": "public"},
        "metrics": metric_specs, "publication": {"track": "public-subset", "training_eligible": False}}), encoding="utf-8")
    json_file(root / "profiles/default.json", {"schema_version": "1", "id": name + "-hitch", "track": "public-subset", "input_mode": "instruction",
        "tool_policy": {"id": "terminal-open-network", "allowed": CAPS, "network": "open", "enforcement": "required"},
        "budget": {"agent_timeout": {"source": "task"}, "setup_timeout_ms": 3600000, "collection_timeout_ms": 120000, "cleanup_grace_ms": 30000},
        "sampling": {"attempts_per_task": 1, "seed": selection["seed"]}, "grading": {"on_agent_budget_exhausted": "grade_final_state", "on_missing_submission": "error", "infrastructure_retries": 0},
        "extensions": {"selection": selection, **extensions}})


def task_extension(task, source_id, output, metrics):
    json_file(task / "task.hitch.json", {"schema_version": "1", "source_task_id": source_id,
        "driver": {"kind": "terminal", "protocol_version": "1", "config": {}}, "requirements": CAPS, "lifecycle": {},
        "submission": {"kind": "artifacts", "paths": [output], "max_bytes": 536870912},
        "grading": {"kind": "command", "entrypoint": ["bash", "/tests/test.sh"], "metric_map": {metric: metric for metric in metrics}}})
