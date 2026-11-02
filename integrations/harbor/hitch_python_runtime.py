"""Read-only content inventory for the interpreter which launches Harbor.

Invoked with the actual launcher interpreter, before starting a task. Generated
bytecode caches do not change identity; a cache that can disagree with its source
is rejected instead of being silently omitted. No imported package is trusted to
report its own version or integrity.
"""

import hashlib
from collections import Counter
import importlib.util
import json
import marshal
import os
from pathlib import Path
import re
import stat
import struct
import sys
import sysconfig
import types
import zipimport


MAX_FILES = 250_000
MAX_BYTES = 2 * 1024**3
LIMIT_ENV_PREFIX = "HITCH_HARBOR_PYTHON_RUNTIME_"


def inventory_limit(name, default):
    """Bound host work independently of the candidate's task and model deadlines."""
    value = os.environ.get(LIMIT_ENV_PREFIX + name)
    if value is None:
        return default
    if not re.fullmatch(r"[1-9][0-9]{0,18}", value) or int(value) > sys.maxsize:
        raise ValueError("invalid Python runtime inventory limit")
    return int(value)


def constant_key(value):
    """Compare compiled constants without NaN equality or signed-zero ambiguity."""
    if isinstance(value, types.CodeType):
        # Preserve the interpreter's code comparison for every non-constant field.
        return (types.CodeType, value.replace(co_consts=()),
                tuple(constant_key(item) for item in value.co_consts))
    if isinstance(value, float):
        return (float, struct.pack("!d", value))
    if isinstance(value, complex):
        return (complex, struct.pack("!dd", value.real, value.imag))
    if isinstance(value, tuple):
        return (tuple, tuple(constant_key(item) for item in value))
    if isinstance(value, frozenset):
        # Distinct NaNs with identical bits can coexist in a frozen set.
        return (frozenset, frozenset(Counter(constant_key(item) for item in value).items()))
    return (type(value), value)


def nan_graph(value, references):
    """Project the only constants whose equality depends on shared identity."""
    if isinstance(value, (float, complex)) and value != value:
        references[id(value)] += 1
        return ("nan", id(value))
    if isinstance(value, types.CodeType):
        value = value.co_consts
    if isinstance(value, (tuple, frozenset)):
        children = []
        for index, child in enumerate(value):
            graph = nan_graph(child, references)
            if graph is not None:
                label = constant_key(child) if isinstance(value, frozenset) else index
                children.append((label, graph))
        if children:
            return ("set" if isinstance(value, frozenset) else "sequence", tuple(children))
    return None


def mapped_nan_graph(graph, mapping=None):
    """An order-independent key once every left-hand NaN has a known partner."""
    kind, items = graph
    if kind == "nan":
        identity = items if mapping is None else mapping.get(items)
        return None if identity is None else (kind, identity)
    children = []
    for label, child in items:
        key = mapped_nan_graph(child, mapping)
        if key is None:
            return None
        children.append((label, key))
    return (kind, frozenset(Counter(children).items()) if kind == "set" else tuple(children))


def compiled_constants_equal(left, right):
    if constant_key(left) != constant_key(right):
        return False
    left_refs, right_refs = Counter(), Counter()
    left_graph, right_graph = nan_graph(left, left_refs), nan_graph(right, right_refs)
    if sorted(left_refs.values()) != sorted(right_refs.values()):
        return False
    if all(count == 1 for count in left_refs.values()):
        return True

    def set_choices(first, second, pending, forward, backward):
        label, child = first[0]
        for index, (other_label, other_child) in enumerate(second):
            if label == other_label:
                remaining = second[:index] + second[index + 1:]
                yield (pending + [(("set", first[1:]), ("set", remaining)), (child, other_child)],
                       forward.copy(), backward.copy())

    # Set iteration order changes across compilation/marshal. Match a bijection
    # lazily, retaining alternatives when later ordered constants constrain it.
    # An explicit stack avoids recursion proportional to the number of constants.
    choices = [iter([([(left_graph, right_graph)], {}, {})])]
    while choices:
        state = next(choices[-1], None)
        if state is None:
            choices.pop()
            continue
        pending, forward, backward = state
        while pending:
            first, second = pending.pop()
            kind, items = first
            other_kind, other_items = second
            if kind != other_kind or (kind != "nan" and len(items) != len(other_items)):
                break
            if kind == "nan":
                if forward.get(items, other_items) != other_items or backward.get(other_items, items) != items:
                    break
                forward[items], backward[other_items] = other_items, items
            elif kind == "sequence":
                if any(a[0] != b[0] for a, b in zip(items, other_items)):
                    break
                for a, b in reversed(tuple(zip(items, other_items))):
                    pair = (a[1], b[1])
                    # Ordered positions constrain identities without guessing.
                    # Apply all such anchors before considering unordered sets.
                    if a[1][0] == "set":
                        pending.insert(0, pair)
                    else:
                        pending.append(pair)
            elif items:
                mapped = mapped_nan_graph(first, forward)
                if mapped is not None:
                    if mapped != mapped_nan_graph(second):
                        break
                    continue
                choices.append(set_choices(items, other_items, pending, forward, backward))
                break
        else:
            return True
    return False


def inventory(launcher, verified=(), *, receipt=False):
    max_files = inventory_limit("MAX_FILES", MAX_FILES)
    max_bytes = inventory_limit("MAX_BYTES", MAX_BYTES)
    launcher = Path(launcher).absolute()
    if not launcher.is_file():
        raise ValueError("missing launcher")
    if sys.pycache_prefix is not None:
        raise ValueError("external Python cache directories are unsupported")
    # A -c probe starts with cwd; a script starts with its containing directory.
    # Never accept relative PYTHONPATH entries: execution uses a different cwd.
    search_path = list(sys.path) if getattr(sys.flags, "safe_path", False) else [str(launcher.resolve(strict=True).parent), *sys.path[1:]]
    if any(not os.path.isabs(value) for value in search_path):
        raise ValueError("relative Python module path")
    records = {}
    snapshots = {}
    directories = {}
    active = set()
    visited = set()
    byte_count = 0
    caches = []

    def read(file):
        nonlocal byte_count
        before = file.stat()
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("non-regular Python runtime file")
        if byte_count + before.st_size > max_bytes:
            raise ValueError("Python runtime inventory exceeds byte limit")
        data = file.read_bytes()
        byte_count += len(data)
        after = file.stat()
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
        if signature(before) != signature(after):
            raise ValueError("Python runtime changed while reading")
        if str(file) in snapshots and snapshots[str(file)] != signature(after):
            raise ValueError("Python runtime changed between reads")
        snapshots[str(file)] = signature(after)
        return data

    def cache_is_derived(file):
        if file.suffix != ".pyc" or file.parent.name != "__pycache__":
            return False
        tag = re.escape(sys.implementation.cache_tag)
        match = re.fullmatch(r"(.+)\." + tag + r"(?:\.opt-([012]))?\.pyc", file.name)
        if not match:
            # Another interpreter's tagged cache cannot be imported here.
            return True
        source = file.parent.parent / (match[1] + ".py")
        if not source.is_file():
            # CPython does not import orphan files inside __pycache__.
            return True
        data = read(file)
        if len(data) < 16 or data[:4] != importlib.util.MAGIC_NUMBER:
            raise ValueError("unverifiable Python bytecode cache")
        # The resident executor remembers only successful content proofs. All
        # files are still read and hashed on every observation; metadata never
        # authorizes skipping compilation. Keep hashes, not entire environments,
        # in memory while discovering the complete interpreter/dependency key.
        caches.append((str(file), str(source), int(match[2] or 0),
                       hashlib.sha256(data).hexdigest(), hashlib.sha256(read(source)).hexdigest()))
        return True

    def visit(file):
        name = str(file)
        if name in visited:
            return
        # Derived caches still consume traversal work even though they do not
        # contribute records to the runtime's content identity.
        if len(visited) >= max_files:
            raise ValueError("Python runtime inventory exceeds file limit")
        visited.add(name)
        if file.is_symlink():
            target = file.resolve(strict=True)
            records[name] = ["link", os.readlink(file), str(target)]
            visit(target)
        elif file.is_dir():
            if name in active:
                raise ValueError("cyclic Python runtime directory")
            active.add(name)
            names = sorted(os.listdir(file))
            directories[name] = names
            # Cache directories and verified caches are derived, not inputs.
            if file.name != "__pycache__":
                records[name] = ["directory"]
            for child in names:
                visit(file / child)
            active.remove(name)
        elif file.is_file():
            if cache_is_derived(file):
                return
            data = read(file)
            records[name] = ["file", stat.S_IMODE(file.stat().st_mode), hashlib.sha256(data).hexdigest()]
        elif file.exists():
            raise ValueError("unsupported Python runtime file")
        else:
            # sys.path and module origins can refer inside an archive. Those
            # paths are importable even though filesystem stat reports missing.
            try:
                importer = zipimport.zipimporter(name)
            except zipimport.ZipImportError:
                records[name] = ["missing"]
            else:
                archive = Path(importer.archive)
                records[name] = ["zip-path", str(archive), importer.prefix]
                visit(archive)

    for file in [launcher, Path(sys.executable), Path(sys.prefix) / "pyvenv.cfg"]:
        visit(file)
    for value in search_path:
        visit(Path(value))
    # Startup hooks (for example Homebrew sitecustomize) may have been imported
    # from a directory later removed from sys.path. Include their actual files.
    for module in list(sys.modules.values()):
        origin = getattr(module, "__file__", None)
        if isinstance(origin, str):
            file = Path(origin)
            if not file.is_absolute():
                file = file.absolute()
            visit(file)
    library = Path(sysconfig.get_config_var("LIBDIR") or sys.base_prefix) / (sysconfig.get_config_var("LDLIBRARY") or "libpython")
    visit(library)
    identity = {
        "schema_version": "1",
        "implementation": sys.implementation.name,
        "version": sys.version,
        "prefix": sys.prefix,
        "base_prefix": sys.base_prefix,
        "search_path": search_path,
        "files": sorted(records.items()),
    }
    encoded = json.dumps(identity, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    # Unlike the public runtime identity, this proof includes derived bytecode.
    # Any changed source, cache, interpreter, probe or startup dependency misses.
    proof = hashlib.sha256(encoded + b"\0" + json.dumps(
        ["bytecode-proof-v1", str(sys.flags), sorted(caches)], separators=(",", ":"),
    ).encode()).hexdigest()
    if proof not in verified:
        for name, source, optimize, cache_hash, source_hash in caches:
            data, source_data = read(Path(name)), read(Path(source))
            if hashlib.sha256(data).hexdigest() != cache_hash or hashlib.sha256(source_data).hexdigest() != source_hash:
                raise ValueError("Python runtime changed before bytecode verification")
            code = marshal.loads(data[16:])
            if not isinstance(code, types.CodeType):
                raise ValueError("invalid Python bytecode cache")
            expected = compile(source_data, code.co_filename, "exec", dont_inherit=True, optimize=optimize)
            if not compiled_constants_equal(code, expected):
                raise ValueError("Python bytecode cache disagrees with source")
    for name, expected in snapshots.items():
        s = Path(name).stat()
        if (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode) != expected:
            raise ValueError("Python runtime changed during inventory")
    for name, expected in directories.items():
        if sorted(os.listdir(name)) != expected:
            raise ValueError("Python runtime directory changed during inventory")
    result = {
        "schema_version": "1",
        "integrity": "sha256:" + hashlib.sha256(encoded).hexdigest(),
        "python_version": ".".join(map(str, sys.version_info[:3])),
        "file_count": sum(value[0] == "file" for value in records.values()),
    }
    return {"runtime": result, "proof": proof} if receipt else result


if __name__ == "__main__":
    try:
        memo = len(sys.argv) > 2 and sys.argv[2] == "--memo"
        verified = sys.argv[3:] if memo else ()
        if len(verified) > 8 or any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in verified):
            raise ValueError("invalid bytecode verification memo")
        print(json.dumps(inventory(sys.argv[1], verified, receipt=memo), separators=(",", ":")))
    except Exception:
        # Paths or package import errors can contain credentials or private data.
        print("Harbor Python runtime cannot be verified", file=sys.stderr)
        sys.exit(1)
