#!/usr/bin/env python3
"""Produce GDPval-public rubric tasks from a pinned official Parquet snapshot.

Requires pyarrow==21.0.0 and toml==0.10.2. No Hitch imports. Gold deliverables and
rubrics never enter the candidate image. The local rubric score is not AA Elo.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import urllib.parse
import urllib.request

import pyarrow.parquet as parquet
import toml

BASE_IMAGE = "node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"
BASE_DOCKERFILE = f"""FROM --platform=linux/amd64 {BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-liberation curl git && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/office && /opt/office/bin/pip install --no-cache-dir python-docx==1.2.0 python-pptx==1.0.2 openpyxl==3.1.5 PyMuPDF==1.26.4 Pillow==11.3.0 reportlab==4.4.3
ENV PATH="/opt/office/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
"""


def json_file(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def download(revision, relative, destination):
    parts = PurePosixPath(relative).parts
    if not parts or parts[0] != "reference_files" or ".." in parts or "\\" in relative:
        raise ValueError("invalid reference path in source dataset")
    url = "https://huggingface.co/datasets/openai/gdpval/resolve/" + revision + "/" + urllib.parse.quote(relative, safe="/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        destination.write_bytes(response.read())
    return {"path": relative, "url": url, "bytes": destination.stat().st_size, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def main(args):
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        raise ValueError("revision must be a full Hugging Face commit")
    root = Path(args.out).resolve(); root.mkdir(parents=True, exist_ok=False)
    source = Path(args.parquet)
    rows = parquet.read_table(source).to_pylist()
    ids = sorted(row["task_id"] for row in rows)
    if len(ids) != len(set(ids)) or not 0 < args.count <= len(ids):
        raise ValueError("invalid membership/sample size")
    selected = sorted(ids, key=lambda id: hashlib.sha256(f"{args.seed}\0{id}".encode()).hexdigest())[:args.count]
    selection = {"algorithm": "sha256-rank-v1", "seed": args.seed, "population_size": len(ids),
                 "population_digest": "sha256:" + hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest(), "tasks": selected}
    json_file(root / "source-manifest.json", {"selection": selection, "status": "importing"})
    files, transforms = [], []
    caps = ["shell", "artifact-export", "separate-verifier"]
    for row in rows:
        if row["task_id"] not in selected:
            continue
        task = root / "tasks" / row["task_id"]
        environment, tests = task / "environment", task / "tests"
        environment.mkdir(parents=True); tests.mkdir()
        (environment / "reference").mkdir(); (tests / "reference").mkdir()
        for reference in row["reference_files"]:
            target = environment / "reference" / reference.removeprefix("reference_files/")
            files.append(download(args.revision, reference, target))
            verifier_reference = tests / "reference" / reference.removeprefix("reference_files/")
            verifier_reference.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, verifier_reference)
        instruction = row["prompt"] + "\n\nReference inputs are available recursively under /app/reference. Put final deliverables in /app/output. The image includes LibreOffice, python-docx, python-pptx, openpyxl, PyMuPDF, Pillow and reportlab.\n"
        (task / "instruction.md").write_text(instruction)
        (task / "source-prompt.txt").write_text(row["prompt"])
        transforms.append({"kind": "declare-reference-and-output-paths", "before_path": str((task / "source-prompt.txt").relative_to(root)), "after_path": str((task / "instruction.md").relative_to(root))})
        json_file(tests / "task.json", row)
        json_file(tests / "judge.json", {"protocol": "gdpval-public-weighted-rubric@1", "harness": "codex@version:0.145.0", "model": args.judge_model, "timeout_sec": 900,
            "formula": "clip(sum(weight * condition_met) / sum(positive_weights), 0, 1)", "strict": "all positive conditions met and no negative conditions met"})
        for runtime in Path(__file__).with_name("runtime").glob("*.py"):
            shutil.copy2(runtime, tests / runtime.name)
        (environment / "Dockerfile").write_text(BASE_DOCKERFILE + "COPY reference /app/reference\nRUN chmod -R a-w /app/reference && mkdir -p /app/output\nWORKDIR /app\nCMD [\"sleep\", \"infinity\"]\n")
        (tests / "Dockerfile").write_text(BASE_DOCKERFILE + "RUN npm install -g @openai/codex@0.145.0\nCOPY . /tests\nRUN mkdir -p /app/output /logs/verifier\nWORKDIR /tests\nCMD [\"sleep\", \"infinity\"]\n")
        (tests / "test.sh").write_text("#!/bin/bash\nset -euo pipefail\npython /tests/grade.py\n")
        task_config = {"schema_version": "1.4", "artifacts": ["/app/output"], "metadata": {"category": "professional-work", "occupation": row["occupation"]},
            "agent": {"timeout_sec": 3600}, "environment": {"cpus": 2, "memory_mb": 3072, "storage_mb": 10240, "build_timeout_sec": 1800, "network_mode": "public"},
            "verifier": {"timeout_sec": 1500, "environment_mode": "separate", "env": {"HITCH_CODEX_AUTH_JSON": "${HITCH_CODEX_AUTH_JSON}"},
                "environment": {"cpus": 2, "memory_mb": 3072, "storage_mb": 10240, "build_timeout_sec": 1800, "network_mode": "public"}}}
        (task / "task.toml").write_text(toml.dumps(task_config))
        json_file(task / "task.hitch.json", {"schema_version": "1", "source_task_id": row["task_id"], "driver": {"kind": "terminal", "protocol_version": "1", "config": {}},
            "requirements": caps, "lifecycle": {}, "submission": {"kind": "artifacts", "paths": ["/app/output"], "max_bytes": 536870912},
            "grading": {"kind": "command", "entrypoint": ["bash", "/tests/test.sh"], "metric_map": {"rubric_score": "rubric_score", "strict_success": "strict_success"}}})
    shutil.copy2(__file__, root / "source-adapter.py")
    json_file(root / "source-manifest.json", {"schema_version": "1", "status": "ready", "revision": args.revision, "source": "https://huggingface.co/datasets/openai/gdpval",
        "parquet_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "selection": selection, "reference_files": files, "transformations": transforms,
        "adapter": {"id": "gdpval-public", "version": "1", "path": "source-adapter.py"}, "grading_track": "gdpval-public-rubric; not GDPval-AA v2"})
    metric = lambda type: {"type": type, "direction": "maximize", "range": [0, 1], "reducer": "task_macro_mean"}
    manifest = {"schema_version": "1", "protocol": "hitch-benchmark@1", "id": "gdpval-public-rubric", "release": args.revision,
        "task_root": "tasks", "task_ids": selected, "default_profile": "profiles/default.json", "primary_metric": "rubric_score", "runtime_components": [],
        "task_format": {"name": "harbor", "schema_version": "1.4"}, "source": {"kind": "git", "uri": "https://huggingface.co/datasets/openai/gdpval", "resolved_revision": args.revision, "license": "See official dataset card", "access": "public"},
        "metrics": {"rubric_score": metric("scalar"), "strict_success": metric("binary")}, "publication": {"track": "public-subset", "training_eligible": False}}
    (root / "benchmark.toml").write_text(toml.dumps(manifest))
    json_file(root / "profiles/default.json", {"schema_version": "1", "id": "gdpval-public-rubric-hitch", "track": "public-subset", "input_mode": "instruction",
        "tool_policy": {"id": "terminal-office-web", "allowed": caps, "network": "open", "enforcement": "required"},
        "budget": {"agent_timeout": {"source": "task"}, "setup_timeout_ms": 3600000, "collection_timeout_ms": 120000, "cleanup_grace_ms": 30000},
        "sampling": {"attempts_per_task": 1, "seed": args.seed}, "grading": {"on_agent_budget_exhausted": "grade_final_state", "on_missing_submission": "error", "infrastructure_retries": 0},
        "extensions": {"judge_model": args.judge_model, "comparison": "none", "score_kind": "local public rubric", "selection": selection}})
    print(json.dumps({"package": str(root), "selection": selection}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--judge-model", default="gpt-5.4")
    parser.add_argument("--out", required=True)
    main(parser.parse_args())
