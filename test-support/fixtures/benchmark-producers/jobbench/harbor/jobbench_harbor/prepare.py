from __future__ import annotations
import hashlib,json,math,os
from pathlib import Path
class SourceError(ValueError):
    pass

def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def _regular_files(base: Path, *, label: str) -> list[Path]:
    if base.is_symlink():
        raise SourceError(f"{label} contains a symlink: {base}")
    if not base.is_dir():
        raise SourceError(f"missing directory in {label}: {base}")

    result: list[Path] = []

    def visit(directory: Path) -> None:
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(entry.path)
            if entry.is_symlink():
                raise SourceError(f"{label} contains a symlink: {path}")
            if entry.is_dir(follow_symlinks=False):
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                result.append(path)
            else:
                raise SourceError(f"{label} contains a non-regular path: {path}")

    visit(base)
    return result

def _source_hashes(task: Path) -> list[dict[str, str]]:
    required = (task / "RUBRICS.json", task / "task_card.md")
    for path in required:
        if path.is_symlink():
            raise SourceError(f"source contains a symlink: {path}")
        if not path.is_file():
            raise SourceError(f"missing required source file: {path.name} in {task}")
    folder = task / "task_folder"
    files = _regular_files(folder, label="task_folder")
    instructions = folder / "TASK_INSTRUCTIONS.txt"
    if instructions not in files:
        raise SourceError(f"missing required source file: TASK_INSTRUCTIONS.txt in {task}")
    try:
        rubric = json.loads((task / "RUBRICS.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SourceError(f"invalid RUBRICS.json in {task}: {exc}") from exc
    if not isinstance(rubric, dict) or not isinstance(rubric.get("rubrics"), list):
        raise SourceError(
            f"invalid RUBRICS.json in {task}: expected a non-empty rubrics list"
        )
    total_weight = 0.0
    for index, entry in enumerate(rubric["rubrics"]):
        if not isinstance(entry, dict):
            raise SourceError(
                f"invalid RUBRICS.json in {task}: rubric {index} is not an object"
            )
        text = entry.get("rubric")
        criteria = entry.get("criterion")
        weight = entry.get("weight")
        if not isinstance(text, str) or not text.strip():
            raise SourceError(
                f"invalid RUBRICS.json in {task}: rubric {index} has no rubric text"
            )
        if (
            not isinstance(criteria, list)
            or not criteria
            or any(not isinstance(item, str) or not item.strip() for item in criteria)
        ):
            raise SourceError(
                f"invalid RUBRICS.json in {task}: rubric {index} has invalid criteria"
            )
        if (
            isinstance(weight, bool)
            or not isinstance(weight, (int, float))
            or not math.isfinite(weight)
            or weight < 0
        ):
            raise SourceError(
                f"invalid RUBRICS.json in {task}: rubric {index} has invalid weight"
            )
        total_weight += float(weight)
    if total_weight <= 0:
        raise SourceError(
            f"invalid RUBRICS.json in {task}: total rubric weight must be positive"
        )

    source_files = [*required, *files]
    return [
        {"path": path.relative_to(task).as_posix(), "sha256": _sha256(path)}
        for path in sorted(source_files, key=lambda item: item.relative_to(task).as_posix())
    ]
