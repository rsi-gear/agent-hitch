#!/usr/bin/env python3
"""Convert an explicit pinned JobBench HF snapshot with the official Harbor renderer.

Python >=3.9, no external packages and no Hitch imports. Does not acquire data or
call a model. A complete snapshot is required to report complete-split coverage.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from producer_support import checkout, file_records, git_commit_tree, json_file, select, task_extension, write_package

UPSTREAM_REVISION = "660b33a86ed032559df0b2fdc1ad38cf7ceb83f3"


@contextmanager
def renderer_source(source, revision):
    """Keep upstream imports and their __file__ resources inside the pinned tree."""
    with git_commit_tree(source, revision) as pinned:
        previous_path = sys.path[:]
        modules = {name: module for name, module in sys.modules.items()
                   if name == "jobbench_harbor" or name.startswith("jobbench_harbor.")}
        for name in modules: del sys.modules[name]
        try:
            sys.path.insert(0, str(pinned / "harbor"))
            from jobbench_harbor.prepare import _source_hashes
            from jobbench_harbor.render import render_task
            yield pinned, _source_hashes, render_task
        finally:
            for name in list(sys.modules):
                if name == "jobbench_harbor" or name.startswith("jobbench_harbor."):
                    del sys.modules[name]
            sys.modules.update(modules)
            sys.path[:] = previous_path


def produce(args):
    endpoint = urlsplit(args.judge_base_url)
    if endpoint.scheme != "https" or not endpoint.netloc or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError("judge base URL must be credential-free HTTPS without query or fragment")
    if not args.judge_model.strip() or any(ord(c) < 32 for c in args.judge_model): raise ValueError("invalid judge model")
    source = checkout(args.source, args.source_revision)
    with renderer_source(source, args.source_revision) as inputs:
        return render_package(args, *inputs)


def render_package(args, source, _source_hashes, render_task):
    if not re.fullmatch(r"[a-f0-9]{40}", args.dataset_revision): raise ValueError("dataset revision must be a full HF commit")
    snapshot = Path(args.snapshot).resolve()
    # Enumerate membership before opening instructions or rubric contents.
    prefix = "dataset" if args.split == "main" else "dataset_easy"
    population = {}
    split = snapshot / prefix
    if split.is_symlink() or not split.is_dir(): raise ValueError("snapshot split is missing or unsafe")
    for occupation in sorted(split.iterdir()):
        if occupation.is_symlink() or not occupation.is_dir() or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", occupation.name):
            raise ValueError("invalid occupation in snapshot membership")
        for task in sorted(occupation.iterdir()):
            if task.is_symlink() or not task.is_dir() or not re.fullmatch(r"task[1-9][0-9]*", task.name):
                raise ValueError("invalid task in snapshot membership")
            population[f"{args.split}--{occupation.name}--{task.name}"] = task
    selection = select(population, args.seed, args.count, args.task)
    selection["population_scope"] = "provided-snapshot-split"
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    json_file(root / "source-manifest.json", {"status": "importing", "selection": selection})
    tasks, transforms = [], []
    for name in selection["tasks"]:
        raw = population[name]
        _source_hashes(raw)  # Official validation preserves rubric semantics and missing-file failures.
        task = root / "tasks" / name
        provenance = render_task(raw, task, task_id=name, split=args.split, occupation=raw.parent.name,
            task_number=raw.name, repo_id="JobBench/job-bench", revision=args.dataset_revision,
            judge_path=source / "eval/judge.py", search_files=[])
        # Preserve the complete original task TOML and make only the judge configuration explicit.
        before = root / "source-files" / name / "task.toml"
        before.parent.mkdir(parents=True); shutil.copy2(task / "task.toml", before)
        config = (task / "task.toml").read_text(encoding="utf-8")
        env = {"JUDGE_API_BASE": args.judge_base_url, "JUDGE_API_KEY": "${HITCH_JOBBENCH_JUDGE_API_KEY:-}", "JUDGE_MODEL": args.judge_model,
               "JUDGE_MAX_WORKERS": str(args.judge_workers), "JUDGE_MAX_RETRIES": "3", "JUDGE_TIMEOUT_PER_RUBRIC": "300"}
        config, changed = re.subn(r"^env = \{.*\}$", "env = { " + ", ".join(json.dumps(k) + " = " + json.dumps(v) for k, v in env.items()) + " }", config, flags=re.M)
        if changed != 1: raise ValueError("unsupported upstream verifier configuration")
        # Harbor requires task.name to be org/name, but standard dataset IDs are flat.
        # Omit the optional package identity table so Task.name falls back to its directory ID.
        config, renamed = re.subn(r"^\[task\]\n.*?(?=^\[metadata\])", "", config, count=1, flags=re.M | re.S)
        if renamed != 1: raise ValueError("unsupported upstream task identity table")
        (task / "task.toml").write_text(config, encoding="utf-8")
        transforms.append({"kind": "normalize-task-name-and-lock-verifier-only-judge-config", "before_path": before.relative_to(root).as_posix(), "after_path": (task / "task.toml").relative_to(root).as_posix()})
        for file in Path(__file__).with_name("runtime").glob("*.py"): shutil.copy2(file, task / "tests" / file.name)
        shutil.copy2(task / "tests/test.sh", task / "tests/upstream-test.sh")
        (task / "tests/test.sh").write_text("#!/bin/sh\nset -eu\nexec python /tests/hitch_grade.py\n", encoding="utf-8")
        transforms.append({"kind": "official-verifier-redaction-wrapper", "before_path": (task / "tests/upstream-test.sh").relative_to(root).as_posix(), "after_path": (task / "tests/test.sh").relative_to(root).as_posix()})
        task_extension(task, name, "/workspace/output", ["reward"])
        provenance["search_files"] = "not acquired; hidden search references remain withheld"
        provenance["generated_files"] = file_records(task)
        tasks.append(provenance)
    shutil.copy2(__file__, root / "source-adapter.py")
    shutil.copy2(Path(__file__).resolve().parents[1] / "producer_support.py", root / "source-support.py")
    shutil.copy2(source / "LICENSE", root / "UPSTREAM-LICENSE")
    json_file(root / "source-manifest.json", {"schema_version": "1", "status": "ready", "source": "https://github.com/Job-Bench/job-bench-eval",
        "source_revision": args.source_revision, "renderer_source": {"kind": "git-commit-blob-tree", "revision": args.source_revision, "entries": "tracked regular files only; symlinks and submodules rejected"}, "dataset": "https://huggingface.co/datasets/JobBench/job-bench", "dataset_revision": args.dataset_revision,
        "snapshot_attestation": "caller-supplied revision; local selected file hashes recorded, not remote commit attestation",
        "selection": selection, "tasks": tasks, "transformations": transforms, "adapter": {"id": "jobbench", "version": "1", "path": "source-adapter.py"},
        "compatibility": {"upstream_harbor": "0.22.0", "target_harbor": "0.21.0", "task_schema": "1.4", "execution": "requires separate Docker verification"}})
    write_package(root, name="jobbench-" + args.split, revision=args.source_revision, uri="https://github.com/Job-Bench/job-bench-eval", license="Apache-2.0; dataset terms separately apply",
        selection=selection, primary="reward", metrics={"reward": "scalar"}, extensions={"judge_model": args.judge_model, "judge_base_url": args.judge_base_url,
        "judge_credential": "HITCH_JOBBENCH_JUDGE_API_KEY (verifier only, never --pass-env)", "scoring": "official round(weighted block score / maximum, 4); task macro mean; x100 for percent"})
    return {"package": str(root), "selection": selection}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True); parser.add_argument("--source-revision", default=UPSTREAM_REVISION)
    parser.add_argument("--snapshot", required=True); parser.add_argument("--dataset-revision", required=True)
    parser.add_argument("--split", choices=["main", "easy"], default="main")
    parser.add_argument("--seed", type=int, default=0); parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--task", action="append", help="explicit official task ID; repeatable")
    parser.add_argument("--judge-model", default="grok-4.3"); parser.add_argument("--judge-base-url", default="https://api.x.ai/v1")
    parser.add_argument("--judge-workers", type=int, default=10); parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.judge_workers < 1: parser.error("--judge-workers must be positive")
    print(json.dumps(produce(args), indent=2))
